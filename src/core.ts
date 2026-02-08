import * as vscode from 'vscode';
import * as path from 'node:path';
import { anthropicGenerateText, AnthropicError } from './anthropic';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CommitGenResolvedConfig = {
	scopes: string[];
	types: string[];
	promptHints: string[];
	maxSubjectLength: number;
};

export type CommitGenSettings = {
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

const DEFAULT_TYPES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'perf', 'test', 'build', 'ci', 'revert', 'style'];
const DEFAULT_SCOPES = [
	'auth',
	'config',
	'data',
	'integrations',
	'nav',
	'network',
	'persistence',
	'platform',
	'security',
	'state',
	'sync',
	'ui',
];

let activeNotificationCloser: (() => void) | undefined;
function closeActiveNotification(): void {
	const closer = activeNotificationCloser;
	activeNotificationCloser = undefined;
	closer?.();
}

export async function runGenerateCommitMessageCommand(): Promise<void> {
	closeActiveNotification();
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Commit Gen',
			cancellable: false,
		},
		async (progress) => {
			try {
				const folder = getBestWorkspaceFolder();
				if (!folder) {
					throw new UserFacingError('Open a folder/workspace first.');
				}

				progress.report({ message: 'Reading config and changes…' });
				const resolvedConfig = loadCommitGenConfigFromWorkspace(folder);
				const settings = getCommitGenSettings();

				const git = await getGitContext(folder.uri.fsPath, settings.maxDiffChars);
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
				const method = await presentCommitMessage(finalMessage);
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
					out.appendLine(`[${new Date().toISOString()}] Commit Gen error`);
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

export async function runCommitAllAmendAndForcePushCommand(): Promise<void> {
	closeActiveNotification();
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Commit Gen',
			cancellable: false,
		},
		async (progress) => {
			try {
				const folder = getBestWorkspaceFolder();
				if (!folder) {
					throw new UserFacingError('Open a folder/workspace first.');
				}

				const repoRoot = await getRepoRoot(folder.uri.fsPath);

				progress.report({ message: 'Staging all changes…' });
				await execGit(['add', '-A'], repoRoot);

				progress.report({ message: 'Amending last commit…' });
				const hasStaged = await hasStagedChanges(repoRoot);
				if (hasStaged) {
					await execGit(['commit', '--amend', '--no-edit'], repoRoot);
				} else {
					progress.report({ message: 'Nothing new to amend; pushing…' });
				}

				progress.report({ message: 'Force pushing…' });
				await execGit(['push', '--force'], repoRoot);

				progress.report({ message: 'Done.' });
				await delay(900);
			} catch (err) {
				const { notificationText, outputText } = renderError(err);
				if (outputText) {
					const out = getOutputChannel();
					out.appendLine(`[${new Date().toISOString()}] Commit Gen error`);
					out.appendLine(outputText);
					out.appendLine('');
					void offerOpenOutputNotification();
				}

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
		notificationText: 'Unexpected error (see Output: Commit Gen).',
		outputText: e.stack || e.message,
	};
}

function showStickyErrorNotification(message: string): void {
	closeActiveNotification();
	void vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Commit Gen Error',
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

export function showCommitGenOutput(): void {
	getOutputChannel().show(true);
}

async function offerOpenOutputNotification(): Promise<void> {
	const action = await vscode.window.showInformationMessage('Commit Gen: error details are available in Output.', 'Open Output');
	if (action === 'Open Output') {
		showCommitGenOutput();
	}
}

let outputChannel: vscode.OutputChannel | undefined;
function getOutputChannel(): vscode.OutputChannel {
	if (!outputChannel) {
		outputChannel = vscode.window.createOutputChannel('Commit Gen');
	}
	return outputChannel;
}

async function generateWithValidationAndRetry(opts: {
	settings: CommitGenSettings;
	config: CommitGenResolvedConfig;
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

async function callAnthropicOrThrow(opts: { settings: CommitGenSettings; system: string; userText: string }): Promise<string> {
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
			throw new UserFacingError('Anthropic API key was rejected (401). Check `commitGen.anthropicApiKey` or `ANTHROPIC_API_KEY`.');
		}
		throw err;
	}
}

async function presentCommitMessage(message: string): Promise<'scm' | 'git' | 'clipboard'> {
	const inputBox = vscode.scm?.inputBox;
	if (inputBox) {
		try {
			inputBox.value = message;
			return 'scm';
		} catch {
			// Fall through to clipboard/editor fallback below.
		}
	}

	const insertedViaGit = await tryInsertViaGitExtension(message);
	if (insertedViaGit) {
		return 'git';
	}

	await vscode.env.clipboard.writeText(message);
	return 'clipboard';
}

async function tryInsertViaGitExtension(message: string): Promise<boolean> {
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

	const workspaceFolder = getBestWorkspaceFolder();
	const folderPath = workspaceFolder?.uri.fsPath;

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

export function getCommitGenSettings(): CommitGenSettings {
	const cfg = vscode.workspace.getConfiguration('commitGen');
	const apiKeyFromSettings = cfg.get<string>('anthropicApiKey')?.trim() ?? '';
	const apiKeyFromEnv = (process.env['ANTHROPIC_API_KEY'] ?? '').trim();
	const apiKey = apiKeyFromSettings || apiKeyFromEnv;
	if (!apiKey) {
		throw new UserFacingError('Missing Anthropic API key. Set `commitGen.anthropicApiKey` or env var `ANTHROPIC_API_KEY`.');
	}

	const model = (cfg.get<string>('anthropicModel') ?? 'claude-3-5-sonnet-latest').trim();
	const maxDiffChars = clampInt(cfg.get<number>('maxDiffChars') ?? 12000, 1000, 200000);

	return { apiKey, model, maxDiffChars };
}

function loadCommitGenConfigFromWorkspace(folder: vscode.WorkspaceFolder): CommitGenResolvedConfig {
	const cfg = vscode.workspace.getConfiguration('commitGen', folder.uri);
	const scopesRaw = cfg.get<unknown>('scopes');
	const typesRaw = cfg.get<unknown>('types');
	const promptHintsRaw = cfg.get<unknown>('promptHints');
	const maxSubjectLengthRaw = cfg.get<number>('maxSubjectLength');

	const scopes = normalizeStringList(scopesRaw);
	const resolvedScopes = scopes.length > 0 ? scopes : DEFAULT_SCOPES;

	const types = normalizeStringList(typesRaw);
	const resolvedTypes = types.length > 0 ? types : DEFAULT_TYPES;

	const promptHints = normalizeStringOrStringList(promptHintsRaw);

	return {
		scopes: uniq(resolvedScopes),
		types: uniq(resolvedTypes),
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
	const stagedDiff = await execGit(['diff', '--staged', '--no-color'], cwd);
	const workingDiff = stagedDiff.trim().length === 0 ? await execGit(['diff', '--no-color'], cwd) : '';

	const usingWorking = stagedDiff.trim().length === 0;
	const diffToUse = usingWorking ? workingDiff : stagedDiff;
	const trimmedDiff = truncateMiddle(diffToUse, maxDiffChars);
	const statusSummary = status.trim() || '(clean)';

	return { diff: trimmedDiff, statusSummary, diffKind: usingWorking ? 'working' : 'staged' };
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

async function getRepoRoot(cwd: string): Promise<string> {
	const inRepo = await isGitRepo(cwd);
	if (!inRepo) {
		throw new UserFacingError('This workspace is not a git repository (no `.git`).');
	}
	const root = (await execGit(['rev-parse', '--show-toplevel'], cwd)).trim();
	if (!root) {
		throw new UserFacingError('Unable to determine git repository root.');
	}
	return root;
}

async function hasStagedChanges(repoRoot: string): Promise<boolean> {
	const staged = (await execGit(['diff', '--cached', '--name-only'], repoRoot)).trim();
	return staged.length > 0;
}

async function execGit(args: string[], cwd: string): Promise<string> {
	try {
		const result = await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
		return result.stdout ?? '';
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string; message?: string };
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
	return [
		`Generate a commit message for these ${changesLabel}.`,
		'',
		'Git status (porcelain):',
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
