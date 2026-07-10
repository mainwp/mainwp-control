# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Chat context truncation no longer orphans tool results mid tool-calling loop, which could cause provider API errors on the next message
- Caller-cancelled requests now report "Request cancelled" instead of "Request timed out"
- Keychain credential-removal failures now warn in non-interactive (CI) runs instead of only when attached to a terminal
- Warning shown when the active profile no longer exists and the CLI falls back to another profile

### Changed

- Unified sensitive-key redaction into one shared utility covering compound keys (`apiToken`, `appPassword`) across error output, debug logging, and input sanitization
- Broader destructive-ability name patterns (`reset-`, `restore-`, `rollback-`, `wipe-`, `purge-`, `uninstall-`) in the defense-in-depth safety classification
- Exit code 130 on Ctrl-C at prompts documented as the intentional SIGINT convention

### Security

- Updated `undici` to 7.28.0, resolving TLS certificate validation bypass and response queue poisoning advisories
- Updated `@oclif/core`, `@oclif/plugin-help`, and transitive dependencies — `npm audit` now reports zero vulnerabilities

## [1.1.0-beta.1] - 2026-03-26

### Added

- Required params shown in abilities list examples

### Fixed

- Debug redaction, ctrl-c exit code, CI audit
- Test fixtures: `site_id` → `site_id_or_domain` to match real API
- Windows tester feedback

### Changed

- Git Bash promoted as primary Windows recommendation

## [1.0.1] - 2026-03-24

### Added

- Windows/PowerShell guidance and skip links to docs

## [1.0.0] - 2026-03-24

### Added

- CLI binary (`mainwpcontrol`) with oclif command framework
- Commands: `login`, `profile list|use|delete`, `abilities list|info|run`, `jobs watch`, `doctor`, `chat`, `config show`
- Batch operations with polling and timeout
- Shell completion for bash and zsh
- Streaming chat with sliding window context management
- Audit logging for destructive actions
- Centralized secret masking utility
- Actionable recovery hints on error messages
- `--json` output flag and `defaultJsonOutput` setting
- Golden tests and E2E integration tests
- Profile validation in ProfileStore

### Fixed

- Keytar ESM/CJS interop
- Security vulnerabilities from audit (OWASP mapped)
- Exit code handling consistency

### Changed

- Binary renamed from `mainwpctl` to `mainwpcontrol`

### Removed

- Unimplemented `cancelJob` and `listJobs` from BatchManager

[Unreleased]: https://github.com/mainwp/mainwp-control/compare/v1.1.0-beta.1...HEAD
[1.1.0-beta.1]: https://github.com/mainwp/mainwp-control/compare/v1.0.1...v1.1.0-beta.1
[1.0.1]: https://github.com/mainwp/mainwp-control/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mainwp/mainwp-control/releases/tag/v1.0.0
