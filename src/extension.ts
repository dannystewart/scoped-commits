import * as vscode from 'vscode';
import { runGenerateCommitMessageCommand, showCommitGenOutput } from './core';

export function activate(context: vscode.ExtensionContext) {
	const generate = vscode.commands.registerCommand('commit-gen.generateCommitMessage', async () => {
		await runGenerateCommitMessageCommand();
	});

	const openOutput = vscode.commands.registerCommand('commit-gen.openOutput', () => {
		showCommitGenOutput();
	});

	context.subscriptions.push(generate, openOutput);
}

export function deactivate() {}
