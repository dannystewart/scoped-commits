import * as vscode from 'vscode';
import { runGenerateCommitMessageCommand } from './core';

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
	const generate = vscode.commands.registerCommand('scoped-commits.generateCommitMessage', async () => {
		await runGenerateCommitMessageCommand();
	});

	const addScopeGlobal = vscode.commands.registerCommand('scoped-commits.addScopeGlobal', async () => {
		await addScope(vscode.ConfigurationTarget.Global);
	});

	const addScopeWorkspace = vscode.commands.registerCommand('scoped-commits.addScopeWorkspace', async () => {
		await addScope(vscode.ConfigurationTarget.Workspace);
	});

	context.subscriptions.push(generate, addScopeGlobal, addScopeWorkspace);
}

export function deactivate() {}
