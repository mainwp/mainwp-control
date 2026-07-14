# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Concurrent `ChatEngine.sendMessage` calls now queue and run in call order instead of interleaving shared history and preview state; the interactive REPL already serialized calls, so this protects programmatic callers
- Chat responses that wrap a JSON tool call in prose (text before or after the object, braces inside string values) now parse correctly: the greedy first-`{`-to-last-`}` fallback was replaced with a brace-depth scanner that respects string literals and escapes; fenced-block parsing and pure-JSON responses are unchanged
- Destructive execution now fails closed: if the automatic `dry_run` preview errors or returns an unsuccessful result, the command exits 4 without sending a confirm request. The successful preview is shown before the confirmation prompt (and included in the `--json` envelope); `--force` skips only the prompt, never the preview
- Chat tool calling now works against the real OpenAI, Anthropic, and Gemini APIs: ability names are aliased to provider-safe tool names (all three reject `/`), assistant tool-call blocks are preserved across turns so continuations pair correctly with their results, and the destructive-approval flow keeps the original tool-call id
- Malformed chat tool calls are rejected instead of executing with empty input: unparseable argument JSON, non-object input, multiple tool calls in one response, responses containing both an answer and a tool call, and responses truncated by `length` or `content_filter` all return a protocol error to the model
- Chat now validates tool input against the ability's JSON schema before execution, matching the CLI path; validation failures go back to the model as tool errors
- Replaced retired LLM model defaults: Anthropic `claude-sonnet-4-20250514` (retired June 2026) with `claude-sonnet-4-6`, Gemini `gemini-1.5-flash` (shut down 2025) with `gemini-3.5-flash`
- Preview summaries no longer claim "No items would be affected" when the dry-run response is in an unrecognized format; the raw response is shown with a warning instead
- `--max-context-messages` rejects negative values; `0` remains the only way to disable truncation
- Chat context truncation no longer orphans tool results mid tool-calling loop or at the destructive-action approval step, which could cause provider API errors on the next message
- Caller-cancelled requests now report "Request cancelled" instead of "Request timed out"
- Gemini 3 thought signatures on function calls are preserved through parsing, chat history, and streaming, and echoed back on the continuation request; previously they were discarded, which Gemini 3 models (including the default `gemini-3.5-flash`) reject with HTTP 400
- Context truncation no longer treats the synthetic approval echo after a destructive action as a turn boundary, which with a small `--max-context-messages` could erase the executed action and its result from history right after approval
- HTTP method selection now resolves destructiveness the same way the safety classifier does, so a destructive-named ability is never sent as a read-only GET even if the server mislabels it; non-boolean annotation values (e.g. `readonly: "true"` as a string) are likewise ignored. When the destructive classification comes from the name override rather than the annotations, the request uses POST instead of trusting the annotations' `idempotent` flag for DELETE
- Keychain credential-removal failures now warn in non-interactive (CI) runs instead of only when attached to a terminal
- Warning shown when the active profile no longer exists and the CLI falls back to another profile

### Changed

- `--json` now emits exactly one JSON document when a batch job times out, fails, or completes partially: an error envelope with the job status in `error.details` (previously a success envelope was printed before the error envelope)
- `jobs watch` and `abilities run --wait` exit 4 when the job ends `failed` or `partial`; `jobs watch` exits 130/143 with an error envelope when interrupted by SIGINT/SIGTERM (previously all of these exited 0 with a success envelope)
- Flag and argument parse errors (for example passing `--dry-run` with `--confirm`) exit 1 (user input error) instead of 2
- Minimum Node.js version is 20.18.1 (required by the bundled undici)
- `npm test` no longer requires a reachable MainWP Dashboard; live integration tests run only via `npm run test:live` with `MAINWP_LIVE_TEST=1`
- Unified sensitive-key redaction into one shared utility covering compound keys (`apiToken`, `appPassword`) across error output, debug logging, and input sanitization
- Broader destructive-ability name patterns (`reset-`, `restore-`, `rollback-`, `wipe-`, `purge-`, `uninstall-`) in the defense-in-depth safety classification
- Exit code 130 on Ctrl-C at prompts documented as the intentional SIGINT convention

### Security

- Dashboard URLs with embedded credentials (`https://user:pass@host`) are rejected at login with a hint to use `--username` and the password prompt; profiles stored before this fix have the userinfo masked as `***:***@` in `login`, `config show`, and `doctor` output (human, JSON, and echoed error messages)
- The audit log directory and file permissions now self-heal to `0700`/`0600` on every write, and the log is opened atomically in append mode, removing a check-then-act window that could truncate the log
- `config show` sanitizes every untrusted value in human-readable output to a single safe line: environment-derived provider names and paths (`MAINWP_LLM_PROVIDER`, `XDG_CONFIG_HOME`) and profile-derived fields (profile name, dashboard URL, username), closing line-injection via a crafted `profiles.json` or hostile environment
- `doctor` and `config show` human-readable output now strips terminal escape sequences from error- and config-derived text, matching the sanitization the `--json` path already applied
- HTTP responses are size-checked after buffering even when the server sends a parseable `Content-Length`, so an inaccurate header can no longer bypass the response size limit
- All remaining single-row terminal output (login summary, profile fallback and keychain warnings, ability names, table cells, list items, preview labels) collapses untrusted values to a single line instead of only stripping non-CR/LF control characters
- Input keys containing `[` or `]` are now rejected; they could canonicalize server-side (PHP query parsing) to alias a control flag like `confirm` past the executor's flag-stripping guard
- Mutual exclusion of `dry_run` and `confirm` is now also asserted at the executor boundary, not only at the flag layer
- Updated `undici` to 7.28.0, resolving TLS certificate validation bypass and response queue poisoning advisories
- Updated `@oclif/core`, `@oclif/plugin-help`, `@oclif/plugin-autocomplete`, and transitive dependencies; `npm audit --omit=dev` reports zero production vulnerabilities, dev-chain advisories are tracked separately

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
