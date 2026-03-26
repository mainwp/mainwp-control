# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mainwp/mainwp-control/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/mainwp/mainwp-control/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mainwp/mainwp-control/releases/tag/v1.0.0
