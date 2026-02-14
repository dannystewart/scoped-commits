export type SystemPromptOptions = {
	allowedTypes: string[];
	allowedScopes: string[];
	maxSubjectLength: number;
	promptHints: string[];
	scopeRequirement: ScopeRequirement;
};

export type ScopeRequirement = 'never' | 'onlyIfNoGoodScope' | 'requiredUnscoped';

function formatAllowedList(items: string[]): string {
	return items.map((t) => `- ${t}`).join('\n');
}

const SYSTEM_PROMPT_PREAMBLE_LINES = [
	'You MUST output a valid Conventional Commit message.',
	'Output only the commit message text. No code fences, no extra commentary.',
] as const;

const SYSTEM_PROMPT_ALLOWED_TYPES_TITLE = 'You MUST choose a type ONLY from this allowed list:' as const;
const SYSTEM_PROMPT_ALLOWED_SCOPES_TITLE = 'You MUST choose a scope ONLY from this allowed list:' as const;

function buildSystemPromptConstraintsLines(opts: {
	maxSubjectLength: number;
	scopeRequirement: ScopeRequirement;
	allowedScopesCount: number;
}): string[] {
	const lines: string[] = [];

	if (opts.scopeRequirement === 'never') {
		lines.push('Scope is REQUIRED. Header MUST be: type(scope): subject');
	} else if (opts.scopeRequirement === 'requiredUnscoped') {
		lines.push('Scope is FORBIDDEN. Header MUST be: type: subject');
	} else {
		// onlyIfNoGoodScope
		if (opts.allowedScopesCount > 0) {
			lines.push(
				'Scope is OPTIONAL. Use a scope from the allowed list if one clearly fits; otherwise omit the scope.',
				'Header MUST be either: type(scope): subject OR type: subject',
			);
		} else {
			// No scopes configured, so don't mention scopes at all.
			lines.push('Header MUST be: type: subject');
		}
	}

	lines.push(`Subject MUST be imperative mood, concise, and <= ${opts.maxSubjectLength} characters.`);
	return lines;
}

const SYSTEM_PROMPT_STYLE_LINES = [
	'Body should use third-person singular present tense ("adds", not "add") and may be omitted for trivial changes.',
	'Do NOT include Markdown formatting, and do NOT manually wrap paragraphs with line breaks.',
	'Use the "style" type for changes that do not affect the meaning of the code (whitespace, formatting, comment styling, etc).',
] as const;

const SYSTEM_PROMPT_SCOPED_STYLE_LINES = [
	'Use the "docs" type for documentation changes, and scope it to the documentation area (readme, changelog, etc.).',
	'Use the "workspace" scope for changes to development environment configuration, tools, or other non-code changes.',
	'Use the "agents" scope for changes to agent configuration, instructions, or other agent-related changes.',
	'Use "chore(deps)" for changes to dependencies, package managers, or other dependency-related changes.',
] as const;

/**
 * Builds the system prompt that enforces Conventional Commits + project-specific rules.
 * Keep the rules here so they're easy to audit and modify in one place.
 */
export function buildSystemPrompt(opts: SystemPromptOptions): string {
	const typeList = formatAllowedList(opts.allowedTypes);
	const scopeList = formatAllowedList(opts.allowedScopes);
	const allowScopesInHeader = opts.scopeRequirement !== 'requiredUnscoped' && opts.allowedScopes.length > 0;
	const includeScopedStyle = opts.scopeRequirement !== 'requiredUnscoped' && opts.allowedScopes.length > 0;

	const rulesLines: string[] = [
		...SYSTEM_PROMPT_PREAMBLE_LINES,
		'',
		SYSTEM_PROMPT_ALLOWED_TYPES_TITLE,
		typeList,
	];

	if (allowScopesInHeader) {
		rulesLines.push('', SYSTEM_PROMPT_ALLOWED_SCOPES_TITLE, scopeList);
	}

	rulesLines.push(
		'',
		...buildSystemPromptConstraintsLines({
			maxSubjectLength: opts.maxSubjectLength,
			scopeRequirement: opts.scopeRequirement,
			allowedScopesCount: opts.allowedScopes.length,
		}),
		...SYSTEM_PROMPT_STYLE_LINES,
	);

	if (includeScopedStyle) {
		rulesLines.push(...SYSTEM_PROMPT_SCOPED_STYLE_LINES);
	}

	if (opts.promptHints.length > 0) {
		rulesLines.push('', 'Additional project-specific rules:');
		for (const hint of opts.promptHints) {
			rulesLines.push(`- ${hint}`);
		}
	}

	return rulesLines.join('\n');
}
