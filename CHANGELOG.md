# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog], and this project adheres to [Semantic Versioning].

## [Unreleased]

## [0.2.1] (2026-02-10)

### Added

- Adds "Add Scope (Global)" and "Add Scope (Workspace)" commands for interactively managing commit scopes with input validation, duplicate detection, and stable ordering.

## [0.2.0] (2026-02-10)

Changed extension name from **Commit Gen** to the more representative **Scoped Commits** to reflect the primary feature.

### Added

- Adds instruction to system prompt preventing Markdown formatting and line breaks in generated commit messages to ensure plain text output.

### Changed

- Changes extension name from "commit-gen" to "scoped-commits" with updated configuration keys (`scopedCommits.*`), command identifiers, and documentation.
- Changes default commit types and scopes to be configurable in `package.json` instead of hardcoded constants, with validation to require non-empty arrays.
- Removes 'integrations', 'nav', and 'persistence' from default scope options to streamline default choices.

## [0.1.3] (2026-02-08)

Initial release (basically).

### Added

- Includes untracked files when generating commit messages from working tree changes.

### Changed

- Moves progress indicator to Source Control.
- Updates extension category to "SCM Providers" for better discoverability.
- Refines extension description to clarify workspace-level scope configuration.

### Removed

- Removes manual installation instructions from README as extension is now available through the marketplace.

<!-- Links -->
[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html

<!-- Versions -->
[unreleased]: https://github.com/dannystewart/scoped-commits/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/dannystewart/scoped-commits/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/dannystewart/commit-gen/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/dannystewart/scoped-commits/releases/tag/v0.1.3
