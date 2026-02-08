import * as vscode from 'vscode';
import {
	runCommitAllAmendAndForcePushCommand,
	runGenerateCommitMessageCommand,
	showCommitGenOutput,
} from './core';

export function activate(context: vscode.ExtensionContext) {
	const generate = vscode.commands.registerCommand('commit-gen.generateCommitMessage', async () => {
		await runGenerateCommitMessageCommand();
	});

	const commitAllAmendAndForcePush = vscode.commands.registerCommand('commit-gen.commitAllAmendAndForcePush', async () => {
		await runCommitAllAmendAndForcePushCommand();
	});

	const openOutput = vscode.commands.registerCommand('commit-gen.openOutput', () => {
		showCommitGenOutput();
	});

	context.subscriptions.push(generate, commitAllAmendAndForcePush, openOutput);
}

export function deactivate() {}
