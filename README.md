# Commit Gen

AI-powered commit message generator for VS Code and Cursor that creates high-quality Conventional Commit messages from your git diffs, with the ability to enforce scoping based on predetermined scopes per project.

Available from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=dannystewart.commit-gen).

## Features

- **AI-Generated Commit Messages**: Uses Claude to analyze your staged or working changes and generate detailed, structured commit messages
- **Conventional Commits**: Enforces the Conventional Commits format with customizable types and scopes
- **Flexible Configuration**: Customize commit types, scopes, subject length, and add project-specific prompt hints
- **Smart Validation**: Validates generated messages and automatically retries if they don't meet your project's standards

## Usage

Run the **Commit Gen: Generate Commit Message** command from either the Command Palette or the sparkle icon in the Source Control view. It will analyze your staged changes (or working tree if nothing is staged), generate a message, and insert it into the commit message box.

Note that you must supply `commitGen.anthropicApiKey` or use the `ANTHROPIC_API_KEY` environment variable.

## Configuration

Configure Commit Gen through VS Code/Cursor settings or your workspace's `.vscode/settings.json`.

- `commitGen.types` - Allowed commit types
  - Defaults: feat, fix, chore, docs, refactor, perf, test, build, ci, revert, style
- `commitGen.scopes` - Allowed scope/area names
  - Default: auth, config, data, integrations, nav, network, persistence, platform, security, state, sync, ui
- `commitGen.maxSubjectLength` - Maximum commit subject length (default: 80, range: 40-120)

### Project-Specific Rules

- `commitGen.promptHints` - Array of additional prompt rules for your workspace (e.g., style preferences, definitions, conventions)

### Example Configuration

```json
{
  "commitGen.types": ["feat", "fix", "docs", "refactor"],
  "commitGen.scopes": ["api", "ui", "db", "auth"],
  "commitGen.maxSubjectLength": 72,
  "commitGen.promptHints": [
    "Use past tense for database migrations",
    "Reference ticket numbers when available"
  ]
}
```

## License

This extension is open source under the [MIT License](LICENSE.md).
