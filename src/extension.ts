import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runGenerateCommitMessageCommand } from './core';

const execFileAsync = promisify(execFile);

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

function uniqStable(values: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const v of values) {
		if (!seen.has(v)) {
			seen.add(v);
			out.push(v);
		}
	}
	return out;
}

export function extractScopeFromCommitSubject(subject: string): string | null {
	// Purposefully permissive: we only need to recognize a leading `type(scope)` prefix.
	// Examples:
	// - feat(ui): add button
	// - Fix(core): correct thing
	// - chore(deps)!: update
	const m = /^[A-Za-z][A-Za-z0-9-]*\(([^)]+)\)/.exec(subject.trim());
	const scopeRaw = m?.[1];
	if (!scopeRaw) {
		return null;
	}
	const normalized = normalizeScopeName(scopeRaw);
	return normalized || null;
}

export function normalizeScopeName(scope: string): string {
	return scope.trim().toLowerCase();
}

export function topScopesFromCommitSubjects(subjects: readonly string[], topN: number): Array<{ scope: string; count: number }> {
	const counts = new Map<string, number>();
	for (const subject of subjects) {
		const scope = extractScopeFromCommitSubject(subject);
		if (!scope) {
			continue;
		}
		counts.set(scope, (counts.get(scope) ?? 0) + 1);
	}

	const ranked = [...counts.entries()]
		.map(([scope, count]) => ({ scope, count }))
		.sort((a, b) => (b.count !== a.count ? b.count - a.count : a.scope.localeCompare(b.scope)));

	return ranked.slice(0, Math.max(0, topN));
}

async function execGit(args: string[], cwd: string): Promise<string> {
	try {
		const result = await execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
		return result.stdout ?? '';
	} catch (err) {
		const e = err as { stderr?: string; message?: string; code?: unknown };
		if (e.code === 'ENOENT') {
			throw new Error('git was not found on PATH.');
		}
		const stderr = (e.stderr ?? '').trim();
		const msg = stderr || e.message || 'git command failed';
		throw new Error(`git ${args.join(' ')} failed: ${msg}`);
	}
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execGit(['rev-parse', '--is-inside-work-tree'], cwd);
		return true;
	} catch {
		return false;
	}
}

type UpdateMode = 'add' | 'replace';

async function populateScopesFromCommits(): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (folders.length === 0) {
		await vscode.window.showErrorMessage('No workspace is open. Open a folder/workspace first.');
		return;
	}

	const folderPick = await vscode.window.showQuickPick(
		folders.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
		{
			title: 'Populate scopes from commits',
			placeHolder: 'Select a workspace folder (git repo)',
			ignoreFocusOut: true,
		},
	);
	if (!folderPick) {
		return; // cancelled
	}

	const cwd = folderPick.folder.uri.fsPath;
	let inRepo = false;
	try {
		inRepo = await isGitRepo(cwd);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Failed to check git repository: ${msg}`);
		return;
	}
	if (!inRepo) {
		await vscode.window.showErrorMessage('Selected workspace folder is not a git repository (no `.git`).');
		return;
	}

	const topPick = await vscode.window.showQuickPick(
		[
			{ label: 'Top 5', n: 5 },
			{ label: 'Top 10', n: 10 },
			{ label: 'Top 15', n: 15 },
			{ label: 'Top 20', n: 20 },
		],
		{
			title: 'How many scopes?',
			placeHolder: 'Choose how many top scopes to add/replace',
			ignoreFocusOut: true,
		},
	);
	if (!topPick) {
		return; // cancelled
	}

	const modePick = await vscode.window.showQuickPick(
		[
			{ label: 'Add to Existing', mode: 'add' as const, detail: 'Merge top scopes into your existing scopedCommits.scopes' },
			{ label: 'Replace Existing', mode: 'replace' as const, detail: 'Overwrite scopedCommits.scopes with the top scopes' },
		],
		{
			title: 'Update mode',
			placeHolder: 'Add or replace scopes?',
			ignoreFocusOut: true,
		},
	);
	if (!modePick) {
		return; // cancelled
	}

	const maxCount = 5000;
	let subjectsText = '';
	try {
		subjectsText = await execGit(['log', '--pretty=format:%s', `--max-count=${maxCount}`], cwd);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`Failed to read commit subjects: ${msg}`);
		return;
	}

	const subjects = subjectsText
		.split('\n')
		.map((s) => s.trimEnd())
		.filter((s) => Boolean(s.trim()));

	const ranked = topScopesFromCommitSubjects(subjects, topPick.n);
	if (ranked.length === 0) {
		await vscode.window.showInformationMessage(`No Conventional Commit scopes found in the last ${maxCount} commits.`);
		return;
	}

	const topScopes = ranked.map((r) => r.scope);
	const cfg = vscode.workspace.getConfiguration('scopedCommits');
	const existingRaw = normalizeStringList(cfg.get<unknown>('scopes'));
	const existingNormalized = uniqStable(existingRaw.map(normalizeScopeName).filter(Boolean));

	const mode: UpdateMode = modePick.mode;
	const updated =
		mode === 'replace' ? uniqStable(topScopes) : uniqStable([...existingNormalized, ...topScopes]);

	await cfg.update('scopes', updated, vscode.ConfigurationTarget.Workspace);

	const addedCount = updated.length - existingNormalized.length;
	if (mode === 'replace') {
		await vscode.window.showInformationMessage(`Replaced scopedCommits.scopes with ${updated.length} scopes (workspace).`);
	} else {
		await vscode.window.showInformationMessage(`Added ${Math.max(0, addedCount)} scopes to scopedCommits.scopes (workspace).`);
	}
}

async function addScope(target: vscode.ConfigurationTarget): Promise<void> {
	if (target === vscode.ConfigurationTarget.Workspace && (vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
		await vscode.window.showErrorMessage('No workspace is open. Open a folder/workspace to add a workspace scope.');
		return;
	}

	const scopeRaw = await vscode.window.showInputBox({
		title: 'Add Scoped Commits scope',
		placeHolder: 'e.g. ui',
		prompt: 'Enter a new scope to append to scopedCommits.scopes.',
		validateInput: (value) => (value.trim().length === 0 ? 'Scope cannot be empty.' : undefined),
	});

	if (scopeRaw === undefined) {
		return; // cancelled
	}
	const scope = scopeRaw.trim();
	if (!scope) {
		return;
	}

	const cfg = vscode.workspace.getConfiguration('scopedCommits');
	const existing = uniqStable(normalizeStringList(cfg.get<unknown>('scopes')));
	if (existing.includes(scope)) {
		await vscode.window.showInformationMessage(`Scope "${scope}" already exists in scopedCommits.scopes.`);
		return;
	}

	const updated = uniqStable([...existing, scope]);
	await cfg.update('scopes', updated, target);

	const label = target === vscode.ConfigurationTarget.Global ? 'global' : 'workspace';
	await vscode.window.showInformationMessage(`Added scope "${scope}" to scopedCommits.scopes (${label}).`);
}

export function activate(context: vscode.ExtensionContext) {
	const generate = vscode.commands.registerCommand('scoped-commits.generateCommitMessage', async (...args: unknown[]) => {
		await runGenerateCommitMessageCommand(args[0]);
	});

	const populateScopes = vscode.commands.registerCommand('scoped-commits.populateScopesFromCommits', async () => {
		await populateScopesFromCommits();
	});

	const addScopeGlobal = vscode.commands.registerCommand('scoped-commits.addScopeGlobal', async () => {
		await addScope(vscode.ConfigurationTarget.Global);
	});

	const addScopeWorkspace = vscode.commands.registerCommand('scoped-commits.addScopeWorkspace', async () => {
		await addScope(vscode.ConfigurationTarget.Workspace);
	});

	context.subscriptions.push(generate, populateScopes, addScopeGlobal, addScopeWorkspace);
}

export function deactivate() {}
