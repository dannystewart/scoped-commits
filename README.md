# Commit Gen

AI-powered commit message generator for VS Code and Cursor that creates high-quality Conventional Commit messages from your git diffs, with the ability to enforce scoping based on predetermined scopes per project.

## Installation

### Option A: Install from a VSIX (GitHub Releases)

1. Download the latest `.vsix` from GitHub Releases.
2. In VS Code / Cursor, open the Extensions view.
3. Click the `...` menu and choose **Install from VSIX...**
4. Select the downloaded file and reload the editor when prompted.

### Option B: Install from the CLI

```bash
code --install-extension /path/to/commit-gen-0.1.0.vsix
```

## Features

- **AI-Generated Commit Messages**: Uses Claude to analyze your staged or working changes and generate detailed, structured commit messages
- **Conventional Commits**: Enforces the Conventional Commits format with customizable types and scopes
- **Smart Validation**: Validates generated messages and automatically retries if they don't meet your project's standards
- **Flexible Configuration**: Customize commit types, scopes, subject length, and add project-specific prompt hints
- **Workspace-Aware**: Automatically detects the active workspace and git repository

## Usage

### Generate Commit Message

Run the **Commit Gen: Generate Commit Message** command from:

- The Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
- The sparkle icon in the Source Control view
- The inline sparkle icon in the commit message input box

The extension will:

1. Analyze your staged changes (or working tree if nothing is staged)
2. Generate a Conventional Commit message using Claude
3. Insert it into the commit message box

## Configuration

Configure Commit Gen through VS Code/Cursor settings or your workspace's `.vscode/settings.json` -

### API Settings

- `commitGen.anthropicApiKey` - Your Anthropic API key (optional if using `ANTHROPIC_API_KEY` env var)
- `commitGen.anthropicModel` - AI model to use (default: `claude-sonnet-4-5`)
- `commitGen.maxDiffChars` - Maximum diff characters to send to the API (default: `20000`)

### Commit Format

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
