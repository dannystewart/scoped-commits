import * as vscode from 'vscode';
import * as path from 'node:path';
import { anthropicGenerateText, AnthropicError } from './anthropic';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ScopedCommitsResolvedConfig = {
	scopes: string[];
	types: string[];
	promptHints: string[];
	maxSubjectLength: number;
};

export type ScopedCommitsSettings = {
	apiKey: string;
	model: string;
	maxDiffChars: number;
};

export class UserFacingError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'UserFacingError';
	}
}

let activeNotificationCloser: (() => void) | undefined;
function closeActiveNotification(): void {
	const closer = activeNotificationCloser;
	activeNotificationCloser = undefined;
	closer?.();
}

type ScmInvocationTarget = {
	folder?: vscode.WorkspaceFolder;
	folderPath?: string;
	inputBox?: { value: string };
};

function isUriLike(value: unknown): value is vscode.Uri {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as { scheme?: unknown; fsPath?: unknown; path?: unknown };
	return typeof v.scheme === 'string' && typeof v.fsPath === 'string' && typeof v.path === 'string';
}

function extractInputBoxFromScmContext(context: unknown): { value: string } | undefined {
	if (!context) {
		return undefined;
	}
	if (Array.isArray(context)) {
		for (const item of context) {
			const found = extractInputBoxFromScmContext(item);
			if (found) {
				return found;
			}
		}
		return undefined;
	}
	if (typeof context !== 'object') {
		return undefined;
	}

	const c = context as any;
	const inputBox = c?.inputBox ?? c?.sourceControl?.inputBox ?? c?.repository?.inputBox;
	if (inputBox && typeof inputBox === 'object' && 'value' in inputBox) {
		return inputBox as { value: string };
	}
	return undefined;
}

function extractRootUriFromScmContext(context: unknown): vscode.Uri | undefined {
	const visited = new Set<unknown>();

	const visit = (value: unknown, depth: number): vscode.Uri | undefined => {
		if (!value || depth > 4) {
			return undefined;
		}
		if (visited.has(value)) {
			return undefined;
		}

		if (isUriLike(value)) {
			return value;
		}

		if (Array.isArray(value)) {
			visited.add(value);
			for (const item of value) {
				const found = visit(item, depth + 1);
				if (found) {
					return found;
				}
			}
			return undefined;
		}

		if (typeof value !== 'object') {
			return undefined;
		}

		visited.add(value);
		const obj = value as Record<string, unknown>;

		// Common SCM shapes.
		const direct =
			(obj['rootUri'] as unknown) ??
			(obj['resourceUri'] as unknown) ??
			(obj['uri'] as unknown) ??
			(obj['sourceControl'] as unknown) ??
			(obj['repository'] as unknown);
		const directFound = visit(direct, depth + 1);
		if (directFound) {
			return directFound;
		}

		// Heuristic: scan for *Uri keys (depth-limited).
		for (const [k, v] of Object.entries(obj)) {
			if (k === 'rootUri' || k === 'resourceUri' || k === 'uri' || k.endsWith('Uri')) {
				const found = visit(v, depth + 1);
				if (found) {
					return found;
				}
			}
		}

		return undefined;
	};

	return visit(context, 0);
}

function pickBestWorkspaceFolderForPath(folderPath: string): vscode.WorkspaceFolder | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!Array.isArray(folders) || folders.length === 0) {
		return undefined;
	}

	let best: vscode.WorkspaceFolder | undefined;
	let bestLen = -1;
	for (const wf of folders) {
		const rootPath = wf.uri.fsPath;
		if (!rootPath) {
			continue;
		}
		if (folderPath === rootPath || folderPath.startsWith(rootPath + path.sep)) {
			if (rootPath.length > bestLen) {
				best = wf;
				bestLen = rootPath.length;
			}
		}
	}
	return best ?? folders[0];
}

function resolveScmInvocationTarget(context: unknown): ScmInvocationTarget {
	const inputBox = extractInputBoxFromScmContext(context);
	const rootUri = extractRootUriFromScmContext(context);
	const folderPath = rootUri?.fsPath;
	const folder = folderPath ? pickBestWorkspaceFolderForPath(folderPath) : undefined;
	return { folder, folderPath: folder?.uri.fsPath ?? folderPath, inputBox };
}

export async function runGenerateCommitMessageCommand(context?: unknown): Promise<void> {
	closeActiveNotification();
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
			title: 'Scoped Commits',
			cancellable: false,
		},
		async (progress) => {
			try {
				const target = resolveScmInvocationTarget(context);
				const folder = target.folder ?? getBestWorkspaceFolder();
				if (!folder) {
					throw new UserFacingError('Open a folder/workspace first.');
				}

				progress.report({ message: 'Reading config and changes…' });
				const resolvedConfig = loadScopedCommitsConfigFromWorkspace(folder);
				const settings = getScopedCommitsSettings();

				const cwd = target.folderPath ?? folder.uri.fsPath;
				const git = await getGitContext(cwd, settings.maxDiffChars);
				if (!git.diff.trim()) {
					throw new UserFacingError('No changes found.');
				}

				progress.report({ message: 'Generating commit message…' });
				const finalMessage = await generateWithValidationAndRetry({
					settings,
					config: resolvedConfig,
					diff: git.diff,
					statusSummary: git.statusSummary,
					diffKind: git.diffKind,
				});

				progress.report({ message: 'Inserting…' });
				const method = await presentCommitMessage(finalMessage, { preferredInputBox: target.inputBox, folderPath: cwd });
				const doneMsg =
					method === 'clipboard'
						? 'Copied to clipboard.'
						: 'Inserted commit message.';
				progress.report({ message: doneMsg });
				await delay(1200);
			} catch (err) {
				const { notificationText, outputText } = renderError(err);
				if (outputText) {
					const out = getOutputChannel();
					out.appendLine(`[${new Date().toISOString()}] Scoped Commits error`);
					out.appendLine(outputText);
					out.appendLine('');
					void offerOpenOutputNotification();
				}

				// Close the progress notification quickly, then show a sticky error notification
				// that will be auto-cleared on the next run.
				progress.report({ message: 'Failed.' });
				await delay(250);
				showStickyErrorNotification(notificationText);
			}
		},
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderError(err: unknown): { notificationText: string; outputText?: string } {
	if (err instanceof UserFacingError) {
		return { notificationText: err.message };
	}
	const e = err instanceof Error ? err : new Error(String(err));
	return {
		notificationText: 'Unexpected error (see Output: Scoped Commits).',
		outputText: e.stack || e.message,
	};
}

function showStickyErrorNotification(message: string): void {
	closeActiveNotification();
	void vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Scoped Commits Error',
			cancellable: true,
		},
		(progress, token) =>
			new Promise<void>((resolve) => {
				activeNotificationCloser = resolve;
				progress.report({ message });
				token.onCancellationRequested(() => resolve());
			}),
	);
}

function showScopedCommitsOutput(): void {
	getOutputChannel().show(true);
}

async function offerOpenOutputNotification(): Promise<void> {
	const action = await vscode.window.showInformationMessage('Scoped Commits: error details are available in Output.', 'Open Output');
	if (action === 'Open Output') {
		showScopedCommitsOutput();
	}
}

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('Scoped Commits');
	}
	return outputChannel;
}

async function generateWithValidationAndRetry(opts: {
	settings: ScopedCommitsSettings;
	config: ScopedCommitsResolvedConfig;
	diff: string;
	statusSummary: string;
	diffKind: 'staged' | 'working';
}): Promise<string> {
	const baseSystem = buildSystemPrompt({
		allowedTypes: opts.config.types,
		allowedScopes: opts.config.scopes,
		maxSubjectLength: opts.config.maxSubjectLength,
		promptHints: opts.config.promptHints,
	});

	const baseUser = buildUserPrompt({
		status: opts.statusSummary,
		diff: opts.diff,
		diffKind: opts.diffKind,
	});

	const first = await callAnthropicOrThrow({
		settings: opts.settings,
		system: baseSystem,
		userText: baseUser,
	});

	const firstNormalized = normalizeCommitMessageText(first);
	const firstRepaired = tryRepairSubjectLengthOnly({
		message: firstNormalized,
		allowedTypes: opts.config.types,
		allowedScopes: opts.config.scopes,
		maxSubjectLength: opts.config.maxSubjectLength,
	});

	const v1 = validateCommitMessage({
		message: firstRepaired,
		allowedTypes: opts.config.types,
		allowedScopes: opts.config.scopes,
		maxSubjectLength: opts.config.maxSubjectLength,
	});
	if (v1.ok) {
		return firstRepaired;
	}

	const retrySystem = [
		baseSystem,
		'',
		'Your previous output failed validation.',
		`Validation error: ${v1.reason}`,
		'Rewrite the commit message so it passes all constraints.',
	].join('\n');

	const retryUser = [
		baseUser,
		'',
		'Previous output (for correction):',
		firstNormalized,
	].join('\n');

	const second = await callAnthropicOrThrow({
		settings: opts.settings,
		system: retrySystem,
		userText: retryUser,
	});

	const secondNormalized = normalizeCommitMessageText(second);
	const secondRepaired = tryRepairSubjectLengthOnly({
		message: secondNormalized,
		allowedTypes: opts.config.types,
		allowedScopes: opts.config.scopes,
		maxSubjectLength: opts.config.maxSubjectLength,
	});

	const v2 = validateCommitMessage({
		message: secondRepaired,
		allowedTypes: opts.config.types,
		allowedScopes: opts.config.scopes,
		maxSubjectLength: opts.config.maxSubjectLength,
	});
	if (v2.ok) {
		return secondRepaired;
	}

	throw new UserFacingError(`Generated message failed validation after retry: ${v2.reason}`);
}

async function callAnthropicOrThrow(opts: { settings: ScopedCommitsSettings; system: string; userText: string }): Promise<string> {
	try {
		return await anthropicGenerateText({
			apiKey: opts.settings.apiKey,
			model: opts.settings.model,
			system: opts.system,
			userText: opts.userText,
			maxTokens: 450,
			temperature: 0.2,
		});
	} catch (err) {
		if (err instanceof AnthropicError && err.statusCode === 401) {
			throw new UserFacingError('Anthropic API key was rejected (401). Check `scopedCommits.anthropicApiKey` or `ANTHROPIC_API_KEY`.');
		}
		throw err;
	}
}

async function presentCommitMessage(
	message: string,
	opts?: { preferredInputBox?: { value: string }; folderPath?: string },
): Promise<'scm' | 'git' | 'clipboard'> {
	const preferred = opts?.preferredInputBox;
	if (preferred) {
		try {
			preferred.value = message;
			return 'scm';
		} catch {
			// Fall through to other options below.
		}
	}

	const folderPath = opts?.folderPath;
	if (folderPath) {
		const insertedViaGit = await tryInsertViaGitExtension(message, folderPath);
		if (insertedViaGit) {
			return 'git';
		}
	}

	const inputBox = vscode.scm?.inputBox;
	if (inputBox) {
		try {
			inputBox.value = message;
			return 'scm';
		} catch {
			// Fall through to clipboard fallback below.
		}
	}

	const insertedViaGit = await tryInsertViaGitExtension(message);
	if (insertedViaGit) {
		return 'git';
	}

	await vscode.env.clipboard.writeText(message);
	return 'clipboard';
}

async function tryInsertViaGitExtension(message: string, folderPath?: string): Promise<boolean> {
	// Cursor/VS Code commonly expose the commit message box via the built-in Git extension API,
	// even when `vscode.scm.inputBox` is not available.
	const gitExt = vscode.extensions.getExtension('vscode.git');
	if (!gitExt) {
		return false;
	}

	let exportsAny: any;
	try {
		exportsAny = gitExt.isActive ? gitExt.exports : await gitExt.activate();
	} catch {
		return false;
	}

	const api = exportsAny?.getAPI?.(1);
	const repositories: any[] | undefined = api?.repositories;
	if (!Array.isArray(repositories) || repositories.length === 0) {
		return false;
	}

	const matchingRepo = folderPath
		? pickBestRepoForPath(repositories, folderPath)
		: repositories[0];

	const inputBox = matchingRepo?.inputBox;
	if (!inputBox || typeof inputBox !== 'object') {
		return false;
	}

	try {
		inputBox.value = message;
		return true;
	} catch {
		return false;
	}
}

function pickBestRepoForPath(repositories: any[], folderPath: string): any | undefined {
	let best: any | undefined;
	let bestLen = -1;
	for (const repo of repositories) {
		const rootUri = repo?.rootUri;
		const rootPath: string | undefined = rootUri?.fsPath;
		if (!rootPath) {
			continue;
		}
		// Prefer the deepest repo root that contains the folder.
		if (folderPath === rootPath || folderPath.startsWith(rootPath + path.sep)) {
			if (rootPath.length > bestLen) {
				best = repo;
				bestLen = rootPath.length;
			}
		}
	}
	return best ?? repositories[0];
}

export function getScopedCommitsSettings(): ScopedCommitsSettings {
	const cfg = vscode.workspace.getConfiguration('scopedCommits');
	const apiKeyFromSettings = cfg.get<string>('anthropicApiKey')?.trim() ?? '';
	const apiKeyFromEnv = (process.env['ANTHROPIC_API_KEY'] ?? '').trim();
	const apiKey = apiKeyFromSettings || apiKeyFromEnv;
	if (!apiKey) {
		throw new UserFacingError('Missing Anthropic API key. Set `scopedCommits.anthropicApiKey` or env var `ANTHROPIC_API_KEY`.');
	}

	const model = (cfg.get<string>('anthropicModel') ?? 'claude-3-5-sonnet-latest').trim();
	const maxDiffChars = clampInt(cfg.get<number>('maxDiffChars') ?? 12000, 1000, 200000);

	return { apiKey, model, maxDiffChars };
}

function loadScopedCommitsConfigFromWorkspace(folder: vscode.WorkspaceFolder): ScopedCommitsResolvedConfig {
	const cfg = vscode.workspace.getConfiguration('scopedCommits', folder.uri);
	const scopesRaw = cfg.get<unknown>('scopes');
	const typesRaw = cfg.get<unknown>('types');
	const promptHintsRaw = cfg.get<unknown>('promptHints');
	const maxSubjectLengthRaw = cfg.get<number>('maxSubjectLength');

	const scopes = normalizeStringList(scopesRaw);
	if (scopes.length === 0) {
		throw new UserFacingError('`scopedCommits.scopes` is empty. Add at least one scope, or use "Reset This Setting" to restore defaults.');
	}

	const types = normalizeStringList(typesRaw);
	if (types.length === 0) {
		throw new UserFacingError('`scopedCommits.types` is empty. Add at least one type, or use "Reset This Setting" to restore defaults.');
	}

	const promptHints = normalizeStringOrStringList(promptHintsRaw);

	return {
		scopes: uniq(scopes),
		types: uniq(types),
		promptHints,
		maxSubjectLength: clampInt(maxSubjectLengthRaw ?? 80, 20, 120),
	};
}

function normalizeStringOrStringList(value: unknown): string[] {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed ? [trimmed] : [];
	}
	return normalizeStringList(value);
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === 'string') {
			const trimmed = item.trim();
			if (trimmed) {
				out.push(trimmed);
			}
		}
	}
	return out;
}

type GitContext = { diff: string; statusSummary: string; diffKind: 'staged' | 'working' };

export async function getGitContext(cwd: string, maxDiffChars: number): Promise<GitContext> {
	const inRepo = await isGitRepo(cwd);
	if (!inRepo) {
		throw new UserFacingError('This workspace is not a git repository (no `.git`).');
	}

	const status = await execGit(['status', '--porcelain=v1'], cwd);
	const hasStaged = hasStagedChangesFromPorcelainV1(status);
	const usingWorking = !hasStaged;

	const stagedDiff = hasStaged ? await execGit(['diff', '--staged', '--no-color'], cwd) : '';

	const workingDiff = usingWorking ? await execGit(['diff', '--no-color'], cwd) : '';
	const untrackedDiff = usingWorking ? await buildUntrackedDiff({ cwd, statusPorcelainV1: status }) : '';

	const diffToUse = usingWorking ? [workingDiff, untrackedDiff].filter(Boolean).join('\n') : stagedDiff;
	const trimmedDiff = truncateMiddle(diffToUse, maxDiffChars);
	const statusToShow = usingWorking ? status : stagedOnlyStatusFromPorcelainV1(status);
	const statusSummary = statusToShow.trim() || '(clean)';

	return { diff: trimmedDiff, statusSummary, diffKind: usingWorking ? 'working' : 'staged' };
}

export function hasStagedChangesFromPorcelainV1(statusPorcelainV1: string): boolean {
	// `git status --porcelain=v1` format is two status columns (XY), then a space, then the path.
	// X is the index (staged) status; Y is the working tree status.
	for (const rawLine of statusPorcelainV1.split('\n')) {
		// Preserve leading spaces (they are significant for the X/Y columns).
		const line = rawLine.trimEnd();
		if (line.length < 2) {
			continue;
		}
		if (line[0] === '?' && line[1] === '?') {
			continue; // untracked (not staged)
		}
		const x = line[0];
		if (x !== ' ') {
			return true;
		}
	}
	return false;
}

export function stagedOnlyStatusFromPorcelainV1(statusPorcelainV1: string): string {
	// Filter status output down to entries that have staged changes (X != ' '), and normalize the
	// working-tree column to ' ' so downstream consumers don't "see" unstaged changes.
	const out: string[] = [];
	for (const rawLine of statusPorcelainV1.split('\n')) {
		const line = rawLine.trimEnd();
		if (line.length < 3) {
			continue;
		}
		if (line[0] === '?' && line[1] === '?') {
			continue;
		}
		const x = line[0];
		if (x === ' ') {
			continue;
		}
		out.push(`${x}  ${line.slice(3)}`);
	}
	return out.join('\n');
}

export function parseUntrackedFilesFromPorcelainV1(statusPorcelainV1: string): string[] {
	// `git status --porcelain=v1` lines:
	// - Untracked file: "?? path"
	// Paths may include spaces; everything after the prefix is part of the path.
	const out: string[] = [];
	for (const rawLine of statusPorcelainV1.split('\n')) {
		const line = rawLine.trimEnd();
		if (!line.startsWith('?? ')) {
			continue;
		}
		const p = line.slice(3).trim();
		if (p) {
			out.push(p);
		}
	}
	return out;
}

async function buildUntrackedDiff(opts: { cwd: string; statusPorcelainV1: string }): Promise<string> {
	const untracked = parseUntrackedFilesFromPorcelainV1(opts.statusPorcelainV1);
	if (untracked.length === 0) {
		return '';
	}

	// `git status` may show an untracked directory as "?? dir/". In that case, ask git for
	// the actual untracked files underneath.
	const expanded: string[] = [];
	for (const p of untracked) {
		if (p.endsWith('/')) {
			const childrenNul = await execGit(['ls-files', '--others', '--exclude-standard', '-z', '--', p], opts.cwd);
			for (const child of childrenNul.split('\0')) {
				if (child) {
					expanded.push(child);
				}
			}
		} else {
			expanded.push(p);
		}
	}

	const diffs: string[] = [];
	for (const p of expanded) {
		// `--no-index` uses diff-like exit codes (1 = differences). Allow that.
		const d = await execGit(['diff', '--no-color', '--no-index', '--', '/dev/null', p], opts.cwd, {
			allowExitCode1: true,
		});
		if (d.trim()) {
			diffs.push(d.trimEnd());
		}
	}

	return diffs.join('\n\n');
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
		return true;
	} catch (err) {
		if (err instanceof UserFacingError && /\bENOENT\b/.test(err.message)) {
			throw err;
		}
		return false;
	}
}

async function execGit(args: string[], cwd: string, opts?: { allowExitCode1?: boolean }): Promise<string> {
	try {
		const result = await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
		return result.stdout ?? '';
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
		if (opts?.allowExitCode1 && e.code === 1) {
			return e.stdout ?? '';
		}
		const stderr = (e.stderr ?? '').trim();
		const msg = stderr || e.message || 'git command failed';
		throw new UserFacingError(`git ${args.join(' ')} failed: ${msg}`);
	}
}

function buildSystemPrompt(opts: {
	allowedTypes: string[];
	allowedScopes: string[];
	maxSubjectLength: number;
	promptHints: string[];
}): string {
	const typeList = opts.allowedTypes.map((t) => `- ${t}`).join('\n');
	const scopeList = opts.allowedScopes.map((s) => `- ${s}`).join('\n');

	const rulesLines = [
		'You MUST output a valid Conventional Commit message.',
		'Output only the commit message text. No code fences, no extra commentary.',
		'',
		'You MUST choose a type ONLY from this allowed list:',
		typeList,
		'',
		'You MUST choose a scope ONLY from this allowed list:',
		scopeList,
		'',
		'Scope is REQUIRED. Header MUST be: type(scope): subject',
		`Subject MUST be imperative mood, concise, and <= ${opts.maxSubjectLength} characters.`,
		'Body should use third-person singular present tense ("adds", not "add") and may be omitted for trivial changes.',
		'Do NOT include Markdown formatting, and do NOT manually wrap paragraphs with line breaks.',
	];

	if (opts.promptHints.length > 0) {
		rulesLines.push('', 'Additional project-specific rules:');
		for (const hint of opts.promptHints) {
			rulesLines.push(`- ${hint}`);
		}
	}

	return rulesLines.join('\n');
}

function buildUserPrompt(opts: { status: string; diff: string; diffKind: 'staged' | 'working' }): string {
	const changesLabel = opts.diffKind === 'staged' ? 'staged changes' : 'current working tree changes (nothing staged)';
	const diffLabel = opts.diffKind === 'staged' ? 'Staged diff:' : 'Working tree diff:';
	const statusLabel = opts.diffKind === 'staged' ? 'Git status (porcelain; staged entries only):' : 'Git status (porcelain):';
	return [
		`Generate a commit message for these ${changesLabel}.`,
		'',
		statusLabel,
		opts.status,
		'',
		diffLabel,
		opts.diff,
	].join('\n');
}

export type ParsedCommitHeader = {
	type: string;
	scope?: string;
	bang: boolean;
	subject: string;
};

export function parseCommitHeader(line: string): ParsedCommitHeader | null {
	const trimmed = line.trim();
	const mWithScope = /^([a-z][a-z0-9-]*)\(([^)]+)\)(!)?: (.+)$/.exec(trimmed);
	if (mWithScope) {
		return {
			type: mWithScope[1] ?? '',
			scope: mWithScope[2] ?? '',
			bang: Boolean(mWithScope[3]),
			subject: (mWithScope[4] ?? '').trim(),
		};
	}

	const mNoScope = /^([a-z][a-z0-9-]*)(!)?: (.+)$/.exec(trimmed);
	if (mNoScope) {
		return {
			type: mNoScope[1] ?? '',
			scope: undefined,
			bang: Boolean(mNoScope[2]),
			subject: (mNoScope[3] ?? '').trim(),
		};
	}

	return null;
}

export function validateCommitMessage(opts: {
	message: string;
	allowedTypes: string[];
	allowedScopes: string[];
	maxSubjectLength: number;
}): { ok: true } | { ok: false; reason: string } {
	const lines = opts.message.replace(/\r\n/g, '\n').split('\n');
	const headerLine = (lines[0] ?? '').trim();
	const parsed = parseCommitHeader(headerLine);
	if (!parsed) {
		return { ok: false, reason: 'Header is not a valid Conventional Commit header.' };
	}

	if (!opts.allowedTypes.includes(parsed.type)) {
		return { ok: false, reason: `Type "${parsed.type}" is not in allowed types.` };
	}

	if (!parsed.scope) {
		return { ok: false, reason: 'Scope is required but missing.' };
	}
	if (!opts.allowedScopes.includes(parsed.scope)) {
		return { ok: false, reason: `Scope "${parsed.scope}" is not in allowed scopes.` };
	}

	if (!parsed.subject) {
		return { ok: false, reason: 'Subject is empty.' };
	}

	const subjectLen = parsed.subject.length;
	if (subjectLen > opts.maxSubjectLength) {
		return { ok: false, reason: `Subject is too long (${subjectLen} > ${opts.maxSubjectLength}).` };
	}

	return { ok: true };
}

function tryRepairSubjectLengthOnly(opts: {
	message: string;
	allowedTypes: string[];
	allowedScopes: string[];
	maxSubjectLength: number;
}): string {
	const validation = validateCommitMessage({
		message: opts.message,
		allowedTypes: opts.allowedTypes,
		allowedScopes: opts.allowedScopes,
		maxSubjectLength: opts.maxSubjectLength,
	});

	if (validation.ok) {
		return opts.message;
	}

	const lines = opts.message.split('\n');
	const headerLine = (lines[0] ?? '').trim();
	const parsed = parseCommitHeader(headerLine);
	if (!parsed) {
		return opts.message;
	}

	if (parsed.subject.length <= opts.maxSubjectLength) {
		return opts.message;
	}

	const safeSubject = clampSubject(parsed.subject, opts.maxSubjectLength);
	const scopePart = parsed.scope ? `(${parsed.scope})` : '';
	const bangPart = parsed.bang ? '!' : '';
	const newHeader = `${parsed.type}${scopePart}${bangPart}: ${safeSubject}`;
	const rest = lines.slice(1).join('\n').trimEnd();
	return rest ? `${newHeader}\n${rest}`.trimEnd() : newHeader;
}

function clampSubject(subject: string, maxLen: number): string {
	const s = subject.replace(/\s+/g, ' ').trim();
	if (!s) {
		return '';
	}
	if (s.length <= maxLen) {
		return s;
	}
	return s.slice(0, maxLen).trimEnd();
}

function normalizeCommitMessageText(text: string): string {
	const t = text.replace(/\r\n/g, '\n').trim();
	const withoutFences = t.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
	return withoutFences;
}

function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) {
		return text;
	}
	const keep = Math.floor((maxChars - 60) / 2);
	const head = text.slice(0, Math.max(0, keep));
	const tail = text.slice(Math.max(0, text.length - keep));
	return `${head}\n\n... diff truncated ...\n\n${tail}`;
}

function uniq(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return out;
}

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) {
		return min;
	}
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function getBestWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	const activeUri = vscode.window.activeTextEditor?.document.uri;
	if (activeUri) {
		const wf = vscode.workspace.getWorkspaceFolder(activeUri);
		if (wf) {
			return wf;
		}
	}
	return vscode.workspace.workspaceFolders?.[0];
}
