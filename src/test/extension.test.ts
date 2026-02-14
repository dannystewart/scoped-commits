import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	hasStagedChangesFromPorcelainV1,
	parseCommitHeader,
	stagedOnlyStatusFromPorcelainV1,
	parseUntrackedFilesFromPorcelainV1,
	validateCommitMessage,
	detectProviderFromApiKey,
} from '../core';
import { extractScopeFromCommitSubject, normalizeScopeName, topScopesFromCommitSubjects } from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('parseCommitHeader: parses scoped and unscoped headers', () => {
		const scoped = parseCommitHeader('feat(ui)!: add button');
		assert.ok(scoped);
		assert.strictEqual(scoped?.type, 'feat');
		assert.strictEqual(scoped?.scope, 'ui');
		assert.strictEqual(scoped?.bang, true);
		assert.strictEqual(scoped?.subject, 'add button');

		const unscoped = parseCommitHeader('chore: update deps');
		assert.ok(unscoped);
		assert.strictEqual(unscoped?.type, 'chore');
		assert.strictEqual(unscoped?.scope, undefined);
		assert.strictEqual(unscoped?.bang, false);
		assert.strictEqual(unscoped?.subject, 'update deps');
	});

	test('validateCommitMessage: enforces allowed type and scope', () => {
		const ok = validateCommitMessage({
			message: 'feat(core): add config loader',
			allowedTypes: ['feat', 'fix'],
			allowedScopes: ['core', 'ui'],
			maxSubjectLength: 80,
			scopeRequirement: 'never',
		});
		assert.deepStrictEqual(ok, { ok: true });

		const badScope = validateCommitMessage({
			message: 'feat(api): add endpoint',
			allowedTypes: ['feat', 'fix'],
			allowedScopes: ['core', 'ui'],
			maxSubjectLength: 80,
			scopeRequirement: 'never',
		});
		assert.strictEqual(badScope.ok, false);
	});

	test('validateCommitMessage: rejects disallowed type', () => {
		const res = validateCommitMessage({
			message: 'feature(core): add thing',
			allowedTypes: ['feat', 'fix'],
			allowedScopes: ['core'],
			maxSubjectLength: 80,
			scopeRequirement: 'never',
		});
		assert.strictEqual(res.ok, false);
	});

	test('validateCommitMessage: onlyIfNoGoodScope allows unscoped and scoped', () => {
		const unscopedOk = validateCommitMessage({
			message: 'chore: update deps',
			allowedTypes: ['chore', 'feat'],
			allowedScopes: ['deps'],
			maxSubjectLength: 80,
			scopeRequirement: 'onlyIfNoGoodScope',
		});
		assert.deepStrictEqual(unscopedOk, { ok: true });

		const scopedOk = validateCommitMessage({
			message: 'chore(deps): update deps',
			allowedTypes: ['chore', 'feat'],
			allowedScopes: ['deps'],
			maxSubjectLength: 80,
			scopeRequirement: 'onlyIfNoGoodScope',
		});
		assert.deepStrictEqual(scopedOk, { ok: true });
	});

	test('validateCommitMessage: requiredUnscoped forbids scopes', () => {
		const scopedBad = validateCommitMessage({
			message: 'feat(ui): add button',
			allowedTypes: ['feat'],
			allowedScopes: ['ui'],
			maxSubjectLength: 80,
			scopeRequirement: 'requiredUnscoped',
		});
		assert.strictEqual(scopedBad.ok, false);

		const unscopedOk = validateCommitMessage({
			message: 'feat: add button',
			allowedTypes: ['feat'],
			allowedScopes: ['ui'],
			maxSubjectLength: 80,
			scopeRequirement: 'requiredUnscoped',
		});
		assert.deepStrictEqual(unscopedOk, { ok: true });
	});

	test('parseUntrackedFilesFromPorcelainV1: extracts ?? paths (including spaces)', () => {
		const status = [
			' M src/core.ts',
			'?? new-file.ts',
			'?? folder with spaces/file name.txt',
			'?? dir/',
		].join('\n');

		assert.deepStrictEqual(parseUntrackedFilesFromPorcelainV1(status), [
			'new-file.ts',
			'folder with spaces/file name.txt',
			'dir/',
		]);
	});

	test('hasStagedChangesFromPorcelainV1: detects staged changes via index column', () => {
		assert.strictEqual(hasStagedChangesFromPorcelainV1(''), false);
		assert.strictEqual(hasStagedChangesFromPorcelainV1(' M src/core.ts'), false); // unstaged only
		assert.strictEqual(hasStagedChangesFromPorcelainV1('?? new-file.ts'), false); // untracked only
		assert.strictEqual(hasStagedChangesFromPorcelainV1('M  src/core.ts'), true);
		assert.strictEqual(hasStagedChangesFromPorcelainV1('MM src/core.ts'), true); // staged + unstaged
		assert.strictEqual(hasStagedChangesFromPorcelainV1([' M a.ts', 'M  b.ts'].join('\n')), true);
	});

	test('stagedOnlyStatusFromPorcelainV1: filters and normalizes to staged entries', () => {
		const status = [
			' M only-unstaged.ts',
			'?? untracked.ts',
			'MM both.ts',
			'M  staged-only.ts',
			'R  old name.ts -> new name.ts',
		].join('\n');

		assert.strictEqual(
			stagedOnlyStatusFromPorcelainV1(status),
			['M  both.ts', 'M  staged-only.ts', 'R  old name.ts -> new name.ts'].join('\n'),
		);
	});

	test('detectProviderFromApiKey: detects Anthropic vs OpenAI by key prefix', () => {
		assert.strictEqual(detectProviderFromApiKey(''), null);
		assert.strictEqual(detectProviderFromApiKey('   '), null);

		assert.strictEqual(detectProviderFromApiKey('sk-ant-123'), 'anthropic');
		assert.strictEqual(detectProviderFromApiKey('sk-ant-api03-abc'), 'anthropic');

		assert.strictEqual(detectProviderFromApiKey('sk-123'), 'openai');
		assert.strictEqual(detectProviderFromApiKey('sk-proj-abc'), 'openai');

		assert.strictEqual(detectProviderFromApiKey('not-a-key'), null);
	});

	test('extractScopeFromCommitSubject: extracts and normalizes scope', () => {
		assert.strictEqual(extractScopeFromCommitSubject('feat(ui): add button'), 'ui');
		assert.strictEqual(extractScopeFromCommitSubject('Fix(Core): correct thing'), 'core');
		assert.strictEqual(extractScopeFromCommitSubject('chore(deps)!: update'), 'deps');
		assert.strictEqual(extractScopeFromCommitSubject('feat( UI ): spacing'), 'ui');
		assert.strictEqual(extractScopeFromCommitSubject('docs: no scope'), null);
		assert.strictEqual(extractScopeFromCommitSubject('not a conventional commit'), null);
	});

	test('normalizeScopeName: lowercases and trims', () => {
		assert.strictEqual(normalizeScopeName(' UI '), 'ui');
		assert.strictEqual(normalizeScopeName('Core'), 'core');
		assert.strictEqual(normalizeScopeName('  '), '');
	});

	test('topScopesFromCommitSubjects: ranks by count and caps topN', () => {
		const subjects = [
			'feat(ui): add button',
			'fix(ui): correct padding',
			'feat(core): add config',
			'chore(core): cleanup',
			'feat(api): add endpoint',
			'docs: update readme',
		];

		const ranked = topScopesFromCommitSubjects(subjects, 2);
		assert.deepStrictEqual(ranked, [
			{ scope: 'core', count: 2 }, // tie-break alpha: core < ui
			{ scope: 'ui', count: 2 },
		]);
	});
});
