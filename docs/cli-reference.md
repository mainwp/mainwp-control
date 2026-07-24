# CLI Reference

The `mainwpcontrol` commands, their flags, and the exit-code contract. `mainwpcontrol <command> --help` is always the authoritative listing for the version you have installed. For the credential and settings model behind these commands, see [Configuration](configuration.md).

## Global flags

These work on every command except the built-in `help` and `autocomplete` commands.

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output: exactly one envelope on stdout |
| `--quiet` / `-q` | Suppress output (exit code only) |
| `--profile <name>` | Use a specific profile for this command |
| `--debug` | Show redacted debug diagnostics on stderr |
| `--help` | Show help |

## `login`

Connects to a Dashboard and creates a profile named after its hostname. Interactive by default; prompts for URL, username, and Application Password, then stores the credentials in your OS keychain.

```bash
# Interactive
mainwpcontrol login

# Non-interactive (CI, headless): password from the environment
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'
mainwpcontrol login --url https://dashboard.example.com --username admin
```

| Flag | Description |
|------|-------------|
| `--url <url>` | Dashboard URL (HTTPS required unless `MAINWP_ALLOW_HTTP=1` or the `allowInsecureHttp` setting is enabled) |
| `--username <name>` | WordPress username |
| `--name <name>` | Profile name (defaults to the Dashboard hostname) |
| `--password <pw>` | Application Password; prefer `MAINWP_APP_PASSWORD` or the prompt, since flags are visible in the process list |
| `--skip-ssl-verify` | Accept a self-signed certificate for this profile (not for production) |

When no OS keychain is available, credentials are not stored on disk; keep `MAINWP_APP_PASSWORD` set for each run.

## `abilities list`

Shows every operation your Dashboard exposes, grouped by category, with each one's type (read, write, destructive) and the exact `abilities run` command to execute it.

```bash
mainwpcontrol abilities list
mainwpcontrol abilities list --category sites
mainwpcontrol abilities list --json
```

## `abilities info`

Shows one ability's description, input schema, and safety annotations.

```bash
mainwpcontrol abilities info list-sites-v1
mainwpcontrol abilities info delete-site-v1 --json
```

## `abilities run`

Executes an ability by its versioned name.

```bash
mainwpcontrol abilities run list-sites-v1 --json
mainwpcontrol abilities run get-site-v1 --input '{"site_id_or_domain": 1}' --json
mainwpcontrol abilities run get-site-v1 --input-file params.json --json
echo '{"site_id_or_domain": 1}' | mainwpcontrol abilities run get-site-v1 --input - --json
```

| Flag | Description |
|------|-------------|
| `--input` / `-i` | Input parameters as JSON (use `-` for stdin) |
| `--input-file` | Read input from a JSON file |
| `--dry-run` | Preview a destructive ability without executing |
| `--confirm` | Execute a destructive ability |
| `--force` | Skip the interactive confirmation prompt (CI mode) |
| `--wait` | Block until a batch job completes |
| `--wait-timeout` | Max seconds to wait (default: 300) |

`--dry-run` and `--confirm` are mutually exclusive. Destructive abilities refuse to run without one of them; the intended sequence is preview first, then confirm. The full flow, including what `--force` does and doesn't skip, is in [Safety & Destructive Operations](safety.md).

## `jobs watch`

Watches a batch job until it finishes. Operations that affect many items return a `job_id` immediately instead of blocking.

```bash
mainwpcontrol jobs watch <job-id>
mainwpcontrol jobs watch <job-id> --timeout 120
```

| Flag | Description |
|------|-------------|
| `--timeout` | Max seconds to watch before giving up |
| `--initial-delay` | First polling delay in milliseconds |
| `--max-delay` | Polling backoff ceiling in milliseconds |
| `--no-progress` | Suppress the progress display |

A timeout or interruption leaves the job running on the Dashboard; re-run `jobs watch` with the same ID to pick it back up. Using `--wait` on the original `abilities run` command is equivalent to running the command and watching the job in one step.

## `profile`

Each `login` creates a profile, a named connection to one Dashboard, identified by hostname. Manage several Dashboards by logging in once per Dashboard.

```bash
mainwpcontrol profile list
mainwpcontrol profile use production.example.com
mainwpcontrol profile delete staging.example.com   # also removes its keychain credentials
```

Any command accepts `--profile <name>` to target a profile without switching the default.

`profile delete` always asks for confirmation and has no skip flag. In non-interactive contexts (pipes, CI) it cancels safely instead of deleting, so treat profile removal as a manual step.

## `config show`

Prints the active settings (from `~/.config/mainwpcontrol/settings.json` and defaults), with secrets redacted.

```bash
mainwpcontrol config show
mainwpcontrol config show --verbose
mainwpcontrol config show --json
```

## `doctor`

Checks configuration, credentials, and Dashboard connectivity. Run it first when something isn't working.

```bash
mainwpcontrol doctor
mainwpcontrol doctor -v       # verbose
mainwpcontrol doctor --json
```

## `chat`

Talks to your Dashboard in plain English using your own LLM API key. Optional; nothing else depends on it.

```bash
export ANTHROPIC_API_KEY='sk-ant-...'
mainwpcontrol chat
mainwpcontrol chat "list all sites with pending updates"
```

Chat-specific flags: `--provider`, `--model`, `--max-turns`, `--max-context-messages`, `--no-stream`, `--api-key` (prefer the environment variable; flags are visible in the process list), and `--base-url` for local or proxy endpoints. Providers, models, and the chat safety model are in [Chat Mode](chat.md).

## Shell completion

```bash
# Bash
source "$(npm root -g)/@mainwp/control/scripts/completions/mainwpcontrol.bash"

# Zsh
source "$(npm root -g)/@mainwp/control/scripts/completions/mainwpcontrol.zsh"
```

## Exit codes

| Code | Meaning | CI usage |
|------|---------|----------|
| 0 | Success | Continue pipeline |
| 1 | User/input error | Fix command syntax |
| 2 | Auth/config error | Check credentials |
| 3 | Network error | Retry or check connectivity |
| 4 | API error | Check ability parameters |
| 5 | Internal error | Report bug |
| 130 | Interrupted (SIGINT) | Ctrl-C during a prompt or `jobs watch`; standard Unix 128+signal convention, outside the 0-5 contract |
| 143 | Terminated (SIGTERM) | `jobs watch` killed by a supervisor or timeout wrapper; same 128+signal convention |

```bash
# Pipeline branching on exit codes
if mainwpcontrol abilities run check-sites-v1 --json --quiet; then
  echo "All sites healthy"
else
  echo "Issues detected"
fi
```
