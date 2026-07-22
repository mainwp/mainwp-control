# Acceptance testing

The acceptance harness exercises the CLI as a process and verifies results with direct Abilities API reads. Packed mode is the default. It creates the npm tarball, checks its contents, installs it in a temporary consumer, and runs the installed `mainwpcontrol` binary. Source mode uses the repository's `bin/run.js` and existing build output.

The deterministic layer chooses every CLI command itself. The agent layer gives Claude a natural-language task and grades the ordered `mainwpcontrol` invocations and final answer against independent state. Agent runs supplement the deterministic suite; they do not replace it.

## Modes and targets

The runner supports two modes:

- `packed` builds and installs the current working tree as a package in a temporary consumer. This is the default.
- `source` runs the repository binary and current `dist/` output. Run `npm run build` first.

The deterministic runner supports two targets:

- `live` uses a configured MainWP Dashboard. This is the default.
- `fixture` starts the local deterministic Dashboard fixture on `127.0.0.1`.

The agent runner has no `--target` flag. Its three read scenarios are live: each reads ground truth directly from the live Abilities API before starting Claude. The delete scenario runs against a per-scenario local fixture Dashboard instead. A live delete victim is not repeatable — MainWP Child locks to a dashboard key on first connect, so every add-then-delete cycle would leave the child rejecting the next add — and pre-existing testbed sites are never valid targets. The mcp reference harness scopes its agent delete scenario the same way.

## Prerequisites

- Node.js 20.18.1 or newer
- Dependencies installed in this repository
- `npm`, `git`, and `tar` on `PATH`
- A completed build for source mode
- Live Dashboard credentials for live and agent runs
- The `claude` CLI with working model access for agent runs

The full harness must run from an unsandboxed local shell. Packed installs and fixtures bind temporary listeners on `127.0.0.1`, `tsx` creates a temporary IPC socket, live verification contacts the Dashboard, and agent scenarios start `claude`. Restricted sandboxes can reject these operations with `listen EPERM`.

## Credentials

Live credentials are resolved in this order:

1. `MAINWP_URL`, `MAINWP_USER`, and `MAINWP_APP_PASSWORD` in the process environment
2. The file named by `MAINWP_CONTROL_ACCEPTANCE_ENV`
3. `~/github/dev-tools/network-testbed/.env`

The environment file maps `LLM_DASH_URL` to the Dashboard URL and reads `MAINWP_USER` and `MAINWP_APP_PASSWORD`.

The agent runner creates one temporary XDG configuration directory per scenario. Its profile contains the Dashboard URL and username. The Application Password exists only in the Claude child environment as `MAINWP_APP_PASSWORD`; it is not written to the profile, consumer, transcript, command record, or result files. `MAINWPCONTROL_NO_KEYTAR=1` keeps the run independent of the OS keychain.

`MAINWP_CONTROL_ACCEPTANCE_TOGGLE_PLUGIN` can select the plugin slug preferred by the `agent-plugin-active` scenario and the reversible deterministic plugin scenario.

## Commands

The package defines six acceptance entry points:

```bash
npm run test:acceptance
npm run test:acceptance:fast
npm run test:acceptance:fixture
npm run test:acceptance:writes
npm run test:acceptance:agent
npm run test:acceptance:human
```

Their behavior is:

- `test:acceptance`: packed mode against the live target.
- `test:acceptance:fast`: builds, then runs source mode against the live target.
- `test:acceptance:fixture`: packed mode against the local fixture.
- `test:acceptance:writes`: packed mode against live with guarded writes enabled.
- `test:acceptance:agent`: packed agent scenarios (live reads plus the fixture delete scenario).
- `test:acceptance:human`: fixture, guarded writes, and agent layers in that order. The `&&` chain stops on the first non-zero exit.

List or select deterministic scenarios:

```bash
npx tsx tests/acceptance/run.ts --list
npx tsx tests/acceptance/run.ts --target fixture --scenario count-sites-consistency
npx tsx tests/acceptance/run.ts --mode source --scenario startup-doctor
```

List or select agent scenarios:

```bash
npx tsx tests/acceptance/agent-run.ts --list
npx tsx tests/acceptance/agent-run.ts --scenario agent-count-sites
npx tsx tests/acceptance/agent-run.ts --scenario agent-confirm-delete-site
npx tsx tests/acceptance/agent-run.ts --mode source --scenario agent-updates
```

Both runners accept repeatable `--scenario <id>`, `--mode packed|source`, `--list`, `--keep-consumer`, and `--help`. The deterministic runner also accepts `--target live|fixture`. `--writes` enables guarded live mutation scenarios in both runners; the agent delete scenario uses the fixture Dashboard and does not need it. Unknown flags fail the run.

## Write guard

Live writes require both conditions:

1. The runner received `--writes`.
2. The Dashboard hostname is `localhost`, `127.0.0.1`, or ends in `.local`.

The shared guard in `tests/acceptance/lib/guards.ts` checks these conditions before a live mutation. Missing authorization reports the scenario as skipped. Fixture writes remain local and do not require `--writes`.

The agent delete scenario targets a synthetic site on its own in-process fixture Dashboard, so no real site record is ever at risk and the scenario is repeatable. The transcript must contain a target-matching `mainwpcontrol abilities run mainwp/delete-site-v1 ... --dry-run` invocation before a target-matching invocation with `--confirm --force`. Independent reads of the fixture must then show exactly one fewer site. The fixture server and its state are discarded when the scenario ends.

## Agent layer

`tests/acceptance/agent-run.ts` runs four scenarios:

- `agent-count-sites`
- `agent-updates`
- `agent-plugin-active`
- `agent-confirm-delete-site`

For packed mode, the child's `PATH` begins with the temporary consumer's `node_modules/.bin`, so `mainwpcontrol` resolves to the package installed from the current tarball. Source mode adds a temporary `mainwpcontrol` link to the repository binary.

Claude receives only:

```text
claude -p <task>
  --allowedTools "Bash(mainwpcontrol *)"
  --disallowedTools "mcp__*"
  --strict-mcp-config
  --settings '{"sandbox": {"enabled": false}}'
  --append-system-prompt <cli usage note>
  --output-format stream-json
  --verbose
  --max-turns 20
```

`--strict-mcp-config` and the MCP disallow pattern isolate the run from any MCP servers configured on the host machine — without them, a host-configured MainWP MCP server can answer the task and the CLI is never exercised. The child's Bash sandbox is disabled because it would block CLI network access to the Dashboard host and force error-and-retry churn on every command; tool access stays restricted through `--allowedTools`. The appended system prompt tells the model that the Dashboard is managed exclusively through the `mainwpcontrol` CLI with `--json`, `--dry-run`, and `--confirm --force`, mirroring what the CLI's own help teaches. Grading tolerates failed intermediate CLI attempts (a CLI agent discovers input schemas by trying) and requires correct non-error results, a non-error final attempt, and a final answer consistent with ground truth. The runner parses stream JSON line by line and collects Bash `tool_use` blocks only when their command starts with `mainwpcontrol`. Grading requires explicit `abilities run` subcommands, expected ability names, valid inline JSON arguments where needed, successful correlated Bash results, and a final answer consistent with verifier ground truth.

Ground truth is computed before Claude starts. If the verifier cannot establish it, the scenario is unverified and Claude is not invoked. A failed scenario makes the runner exit non-zero; skipped and unverified scenarios remain visible but are not counted as passed.

Each agent result records:

- Claude process wall-clock milliseconds
- `duration_ms` from the terminal stream result
- `duration_api_ms` from the terminal stream result
- TTFT from process spawn to the first `assistant` stream event
- Parsed `mainwpcontrol` invocation count

`summary.md` shows the timing for every scenario and identifies the slowest completed Claude process.

## Evidence order

Deterministic and agent checks use this evidence order:

1. The independent verifier reads current state through the Abilities API.
2. The installed or source CLI runs as a child process.
3. Structured output or parsed Bash tool results are compared with the direct read.
4. A second independent read proves state preservation or the requested mutation.
5. Final prose is checked only after structured and state evidence.

The model never grades itself. If the initial verifier read throws, no model call is made.

## Artifacts

Every run writes to:

```text
test-results/acceptance/<UTC timestamp>-<short SHA>[-dirty][-agent]/
```

The directory can contain:

- `manifest.json`: branch, commit, dirty state, diff hash, mode, target, runtime versions, flags, and packed tarball metadata
- `results.json`: statuses, assertions or agent evaluation fields, timing, parsed invocations, and artifact-audit result
- `summary.md`: totals, scenario status, timing, and slowest-run information
- `commands.jsonl`: package, install, CLI, and Claude command records with durations and redacted output tails
- `events.jsonl`: ordered deterministic runner events
- `scenario-<id>.stderr.log`: deterministic CLI diagnostics
- `agent-transcript.jsonl`: every raw Claude stream line, including lines that did not parse

Use `--keep-consumer` to preserve the temporary packed consumer for inspection.

## Redaction audit

The redactor registers the live credentials and the fixture credentials, including usernames, spaced and compact Application Passwords, Dashboard origins, and Basic Authorization values. Every artifact write goes through the `Artifacts` class, which applies the redactor before writing.

At the end of a run, the harness scans the artifact directory for every registered raw value. A finding is recorded as an artifact-audit failure and makes the runner exit non-zero. The transcript retains full model stream lines only after this redaction path.

## Reproducing a failure

1. Read `summary.md` for the failing or slow scenario.
2. Open `results.json` for exact evaluation evidence, parsed argv, timing, and the failure reason.
3. Inspect the scenario's records in `commands.jsonl` and `agent-transcript.jsonl` or `events.jsonl`.
4. Confirm the mode, commit, dirty state, and tarball identity in `manifest.json`.
5. Re-run only that scenario with the same mode and target.

Example:

```bash
npx tsx tests/acceptance/agent-run.ts \
  --mode packed \
  --scenario agent-plugin-active \
  --keep-consumer
```
