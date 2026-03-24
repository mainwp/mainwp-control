# MainWP Control

A CLI for managing your MainWP Dashboard from the terminal. List sites, push updates, sync data, run batch operations across dozens of sites. The command is `mainwpcontrol`.

**Looking for the MCP Server instead?** [MainWP MCP Server](https://github.com/mainwp/mainwp-mcp) is for conversational AI management inside Claude, Cursor, or any MCP-compatible client. MainWP Control is for automation: cron jobs, CI/CD pipelines, monitoring scripts, and batch operations. Both talk to the same Abilities API with the same safety model.

---

## Quick Start

You need Node.js 20+ and a MainWP Dashboard (v6+) with an [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/).

```bash
npm install -g @mainwp/control

mainwpcontrol login

mainwpcontrol abilities list
```

You should see something like this:

```text
Abilities (87 total)

  Sites
Name              Description           Type
----------------  --------------------  --------------
list-sites-v1     List MainWP sites     📖 read
    mainwpcontrol abilities run list-sites-v1
get-site-v1       Get site details      📖 read
    mainwpcontrol abilities run get-site-v1
sync-sites-v1     Sync all sites        ✏️  write
    mainwpcontrol abilities run sync-sites-v1
```

That's it. You're connected and you can see every operation your Dashboard supports.

---

## What Just Happened

`abilities list` shows every operation available on your Dashboard. These are called "abilities" and they cover sites, plugins, themes, updates, clients, tags, and more.

Each ability has a name (like `list-sites-v1`) that you pass to `abilities run` to execute it. The list tells you whether each one is read-only, a write operation, or destructive.

---

## Common Use Cases

**List all your sites:**

```bash
mainwpcontrol abilities run list-sites-v1 --json
```

**Check for pending updates across sites:**

```bash
mainwpcontrol abilities run list-updates-v1 --json
```

**Get details for a specific site:**

```bash
mainwpcontrol abilities run get-site-v1 --input '{"site_id": 1}' --json
```

On Windows PowerShell, escape the inner quotes:

```powershell
mainwpcontrol abilities run get-site-v1 --input '{\"site_id\": 1}' --json
```

To skip quoting issues entirely, use a JSON file (works on every platform):

```bash
mainwpcontrol abilities run get-site-v1 --input-file params.json --json
```

See [Input from File](docs/workflows/input-from-file.md) for more on this approach.

**Preview a destructive action before running it:**

```bash
mainwpcontrol abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --dry-run --json
```

Nothing changes until you explicitly pass `--confirm`.

**Update plugins and wait for completion:**

```bash
mainwpcontrol abilities run update-site-plugins-v1 \
  --input '{"site_id": 1}' \
  --wait --json
```

`--wait` blocks until the operation finishes. Useful in CI pipelines.

---

## Installation

### Standard install (recommended)

Pre-built keychain binaries are included for macOS, Windows, and Linux (x64 and arm64). On other platforms you may need C++ build tools during installation.

```bash
npm install -g @mainwp/control

# Interactive login (stores credentials in your OS keychain)
mainwpcontrol login
```

### Environment variable auth (CI, Docker, headless)

Use this when no OS keychain is available, or if keytar fails to build.

```bash
npm install -g @mainwp/control

export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'

mainwpcontrol login --url https://dashboard.example.com --username admin
```

When the OS keychain is unavailable, credentials are not stored on disk. Keep `MAINWP_APP_PASSWORD` set for each run.

If keytar is installed but broken, set `MAINWPCONTROL_NO_KEYTAR=1` to skip loading it.

---

<details>
<summary><strong>New to the Command Line?</strong></summary>

If you haven't used a terminal before, here's what you need to know.

### What is a terminal?

A terminal is where you type commands instead of clicking buttons. You'll see it called "command line" or "shell" in different places.

**How to open it:**
- **macOS**: Open **Terminal** (search in Spotlight, or look in Applications > Utilities)
- **Windows**: Open **PowerShell** (search in the Start menu)
- **Linux**: Open your distribution's **Terminal** app (usually in the applications menu)

### What does `npm install -g` do?

`npm` is the Node.js package manager. It downloads and installs JavaScript packages. The `-g` flag installs globally, which makes `mainwpcontrol` available as a command anywhere on your system, not only in one project folder.

### What is an environment variable?

An environment variable is a named value that programs can read. They're commonly used for passwords and API keys.

**Setting one:**
```bash
# macOS / Linux (lasts until you close the terminal)
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'

# Windows PowerShell (lasts until you close the window)
$env:MAINWP_APP_PASSWORD = 'xxxx xxxx xxxx xxxx xxxx xxxx'
```

For long-term storage, use the OS keychain (the default when you run `mainwpcontrol login`) or a restricted-permission `.env` file rather than pasting credentials into shell profile files.

### What is an Application Password?

WordPress Application Passwords let external tools like `mainwpcontrol` access your site without using your main login password. They look like groups of four characters separated by spaces (e.g., `abcd efgh ijkl mnop qrst uvwx`).

**To create one:** Log into WordPress admin > Users > Your Profile > scroll to **Application Passwords** > enter a name like "mainwpcontrol" > click **Add New Application Password** > copy the generated password.

### Reading command output

When you run a command, the output appears in your terminal. A few things to know:

- **`--json`** tells `mainwpcontrol` to output structured JSON (useful for scripting and piping to other tools)
- **Exit codes** indicate success (`0`) or failure (`1` through `5`). You won't see them directly, but scripts and CI use them to decide what happens next. Run `echo $?` (macOS/Linux) or `echo $LASTEXITCODE` (PowerShell) after a command to check.

### JSON quoting on the command line

When you pass JSON with `--input`, quoting depends on your shell:

```bash
# macOS / Linux / Git Bash on Windows
mainwpcontrol abilities run get-site-v1 --input '{"site_id": 1}' --json

# Windows PowerShell
mainwpcontrol abilities run get-site-v1 --input '{\"site_id\": 1}' --json
```

Windows strips the inner double quotes unless you escape them with backslashes. If this gets annoying (and it will, with longer JSON), put your parameters in a file and use `--input-file`:

```bash
mainwpcontrol abilities run get-site-v1 --input-file params.json --json
```

This works the same on every platform. See [Input from File](docs/workflows/input-from-file.md) for details.

**Git Bash on Windows** (comes with Git for Windows) handles quoting the same way macOS and Linux do. If you use Git Bash, all the examples in this documentation work without changes.

</details>

---

## Basic Usage

### Abilities

Your Dashboard exposes its operations as "abilities." You browse them, pick one, and run it. Every ability has a versioned name like `list-sites-v1` that you pass to `abilities run`.

```bash
# List all abilities
mainwpcontrol abilities list

# Filter by category
mainwpcontrol abilities list --category sites

# Get full details and input schema for an ability
mainwpcontrol abilities info list-sites-v1

# Run an ability
mainwpcontrol abilities run list-sites-v1 --json

# Run with input parameters
mainwpcontrol abilities run get-site-v1 --input '{"site_id": 1}' --json

# Windows PowerShell: escape inner quotes
mainwpcontrol abilities run get-site-v1 --input '{\"site_id\": 1}' --json

# Or use a file (works everywhere)
mainwpcontrol abilities run get-site-v1 --input-file params.json --json
```

### Profiles

Each `mainwpcontrol login` creates a profile, a named connection to a Dashboard, identified by hostname. If you manage multiple Dashboards, run `login` once per Dashboard to create a profile for each.

```bash
# List all profiles
mainwpcontrol profile list

# Switch active profile
mainwpcontrol profile use production.example.com

# Use a profile for one command without switching
mainwpcontrol abilities list --profile staging.example.com

# Delete a profile and its keychain credentials
mainwpcontrol profile delete staging.example.com
```

### Diagnostics

`doctor` checks your configuration, credentials, and Dashboard connectivity. Run it first if something isn't working.

```bash
# Check configuration and connectivity
mainwpcontrol doctor

# Verbose output
mainwpcontrol doctor -v

# JSON output
mainwpcontrol doctor --json
```

### Chat Mode

If you have an LLM API key, you can talk to your Dashboard in plain English instead of constructing commands. Good for exploration, not required for anything.

Set one of these environment variables to enable it:

```bash
# Pick one (Anthropic, OpenAI, Google, or OpenRouter)
export ANTHROPIC_API_KEY='sk-ant-...'

mainwpcontrol chat
mainwpcontrol chat "list all sites with pending updates"
```

See [Chat Mode Configuration](#chat-mode-configuration) for all supported providers and flags.

### Global Flags

These flags work on every command.

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output |
| `--quiet` / `-q` | Suppress output (exit code only) |
| `--profile <name>` | Use a specific profile |
| `--debug` | Show redacted debug diagnostics on stderr |
| `--help` | Show help |

### Abilities Run Flags

Extra flags for `abilities run`. These control input, safety checks, and batch job behavior.

| Flag | Description |
|------|-------------|
| `--input` / `-i` | Input parameters as JSON (use `-` for stdin) |
| `--input-file` | Read input from a JSON file |
| `--dry-run` | Preview changes without executing |
| `--confirm` | Execute a destructive ability |
| `--force` | Skip interactive confirmation (CI mode) |
| `--wait` | Block until batch job completes |
| `--wait-timeout` | Max seconds to wait (default: 300) |

---

## Concepts

### Abilities

Abilities are the operations your MainWP Dashboard exposes through its REST API. Each one has:

- A versioned name (e.g., `list-sites-v1`, `delete-site-v1`)
- An input schema (what parameters it accepts)
- Annotations that tell you what kind of operation it is

The annotations matter:
- **Readonly**: Safe to run anytime. Cannot modify data.
- **Destructive**: Permanently changes or deletes data. Requires `--dry-run` preview, then `--confirm` to execute.
- **Idempotent**: Safe to re-run. Same result on repeated calls.

Run `mainwpcontrol abilities info <name>` to see the full schema and annotations for any ability.

### Profiles

A profile is a named connection to a MainWP Dashboard. It stores the Dashboard URL and username. Your password stays in the OS keychain (or in the `MAINWP_APP_PASSWORD` environment variable when no keychain is available).

Running `mainwpcontrol login` creates a profile automatically, named after the Dashboard hostname:

```bash
# Creates profile "staging.example.com"
mainwpcontrol login --url https://staging.example.com --username admin

# Creates profile "production.example.com"
mainwpcontrol login --url https://production.example.com --username admin
```

The profile file at `~/.config/mainwpcontrol/profiles.json` never contains passwords.

### Safety Model

Destructive operations follow a two-step pattern: preview first, then execute.

```bash
# Step 1: Preview (nothing changes)
mainwpcontrol abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --dry-run --json

# Step 2: Execute after reviewing the preview
mainwpcontrol abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --confirm --force --json
```

`--dry-run` and `--confirm` are mutually exclusive. You cannot pass both.

In CI/scripted workflows where you've already validated the operation, pass `--confirm --force` directly to skip the interactive prompt.

### Batch Jobs

Operations that affect many items (200+) are automatically queued as batch jobs. The command returns a `job_id` immediately, and you can watch progress:

```bash
mainwpcontrol jobs watch <job-id>

# With a timeout
mainwpcontrol jobs watch <job-id> --timeout 120
```

Or use `--wait` on the original command to block until completion:

```bash
mainwpcontrol abilities run sync-sites-v1 --wait --wait-timeout 300 --json
```

---

## Advanced Usage

### CI/CD Patterns

```bash
# Non-interactive login
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'
mainwpcontrol login --url https://dashboard.example.com --username admin

# Silent execution with exit codes
mainwpcontrol abilities run list-sites-v1 --json --quiet
echo "Exit code: $?"

# Pipeline branching on exit codes
if mainwpcontrol abilities run check-sites-v1 --json --quiet; then
  echo "All sites healthy"
else
  echo "Issues detected"
fi
```

### Input from Files and Stdin

```bash
# From a JSON file
mainwpcontrol abilities run update-site-plugins-v1 --input-file params.json --json

# From stdin
echo '{"site_id": 1}' | mainwpcontrol abilities run get-site-v1 --input - --json

# Heredoc
mainwpcontrol abilities run get-site-v1 --input - --json <<EOF
{"site_id": 1}
EOF
```

### Chat Mode Configuration

Chat requires one of these environment variables:

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LOCAL_LLM_API_KEY` | Local LLM (with optional `LOCAL_LLM_URL`) |

Additional chat flags: `--provider`, `--model`, `--max-turns`, `--max-context-messages`, `--no-stream`.

In non-TTY environments (pipes, CI), `mainwpcontrol chat` without a message argument exits with guidance instead of hanging.

### Shell Completion

```bash
# Bash
source /path/to/mainwp-control/scripts/completions/mainwpcontrol.bash

# Zsh
source /path/to/mainwp-control/scripts/completions/mainwpcontrol.zsh
```

### Configuration File

Settings live at `~/.config/mainwpcontrol/settings.json`:

```json
{
  "defaultJsonOutput": true,
  "timeout": 30000,
  "debug": false,
  "llmProvider": "openai",
  "chatContextMessages": 20
}
```

### Workflow Guides

Step-by-step guides for common automation patterns:

| Workflow | Description |
|----------|-------------|
| [Daily Health Check](docs/workflows/daily-health-check.md) | Cron job that checks site connectivity and alerts via Slack |
| [Plugin Deployment Verification](docs/workflows/plugin-deployment-verification.md) | GitHub Actions workflow to verify a plugin exists across all sites |
| [Monthly Batch Updates](docs/workflows/monthly-batch-updates.md) | Preview and apply updates safely, scripted and GitHub Actions variants |
| [Input from File](docs/workflows/input-from-file.md) | Pass complex parameters via JSON files, stdin pipes, or heredocs |
| [Monitoring Integration](docs/workflows/monitoring-integration.md) | Send site metrics to Datadog, StatsD, or other monitoring tools |

---

## Reference

### Exit Codes

| Code | Meaning | CI Usage |
|------|---------|----------|
| 0 | Success | Continue pipeline |
| 1 | User/input error | Fix command syntax |
| 2 | Auth/config error | Check credentials |
| 3 | Network error | Retry or check connectivity |
| 4 | API error | Check ability parameters |
| 5 | Internal error | Report bug |

### Environment Variables

#### MainWP Configuration

| Variable | Description |
|----------|-------------|
| `MAINWP_APP_PASSWORD` | Application password for non-interactive login and commands when keychain is unavailable |
| `MAINWPCONTROL_NO_KEYTAR` | Set to `1` to skip keytar (keychain) loading entirely |
| `MAINWP_ALLOW_HTTP` | Set to `1` to allow insecure HTTP Dashboard URLs |

#### Chat/LLM Configuration

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LOCAL_LLM_API_KEY` | Local LLM provider (required to enable local provider) |
| `LOCAL_LLM_URL` | Local endpoint URL (optional, defaults to localhost) |
| `MAINWP_LLM_PROVIDER` | Override auto-detected provider |
| `MAINWP_LLM_MODEL` | Specify model to use |

### Configuration Settings

All settings in `~/.config/mainwpcontrol/settings.json`:

| Setting | Type | Description |
|---------|------|-------------|
| `defaultJsonOutput` | boolean | Default to JSON output |
| `timeout` | number | HTTP request timeout in milliseconds |
| `debug` | boolean | Enable debug output |
| `llmProvider` | string | Default LLM provider for chat |
| `chatContextMessages` | number | Max messages in chat context |
| `skipSSLVerification` | boolean | Disable TLS verification (insecure, prefer per-profile setting via `login --skip-ssl-verify`) |
| `allowInsecureHttp` | boolean | Allow `http://` Dashboard URLs without `MAINWP_ALLOW_HTTP=1` |

---

## Troubleshooting

<details>
<summary><strong>"keytar failed to build" or native module errors during install</strong></summary>

Keytar requires native C++ compilation on some platforms. If it fails:

1. **Use environment variable auth instead** (bypasses keytar entirely):
   ```bash
   export MAINWP_APP_PASSWORD='your-application-password'
   mainwpcontrol login --url https://dashboard.example.com --username admin
   ```
2. **Or skip keytar explicitly** by setting `MAINWPCONTROL_NO_KEYTAR=1` before running commands.

The pre-built binaries cover macOS, Windows, and Linux (x64/arm64). If you're on a different platform or architecture, you'll need C++ build tools (`gcc`, `g++`, `make`) or the env var approach.

</details>

<details>
<summary><strong>"command not found" after install</strong></summary>

This usually means your npm global bin directory isn't in your system PATH.

1. **Find where npm installs global packages:**
   ```bash
   npm config get prefix
   ```
2. **Add the `bin` subdirectory to your PATH.** For example, if the prefix is `/usr/local`:
   ```bash
   # Add to ~/.bashrc, ~/.zshrc, or your shell profile:
   export PATH="/usr/local/bin:$PATH"
   ```
3. **Restart your terminal** (or run `source ~/.zshrc` / `source ~/.bashrc`) and try again.

On Windows, the npm global directory is usually already in PATH after installing Node.js.

</details>

<details>
<summary><strong>"connection refused" or network errors</strong></summary>

If `mainwpcontrol login` or commands fail with connection errors:

1. **Check the Dashboard URL.** Make sure it's the full URL with `https://` (e.g., `https://dashboard.example.com`). Don't include a trailing slash.
2. **Verify HTTPS.** `mainwpcontrol` requires HTTPS by default. If your Dashboard uses HTTP (not recommended), set `MAINWP_ALLOW_HTTP=1`.
3. **Check firewall/network.** Make sure your machine can reach the Dashboard:
   ```bash
   curl -I https://dashboard.example.com
   ```
4. **SSL certificate issues.** If using a self-signed certificate, you can use `mainwpcontrol login --skip-ssl-verify` (not recommended for production).

</details>

---

## Contributing

```bash
npm run build      # Build the project
npm test           # Run tests (unit + e2e, no network needed)
npm run lint       # Check code style
```

### Live Integration Tests

`npm run test:live` runs tests against a real MainWP Dashboard, including workflow documentation validation. These require a running Dashboard and credentials:

```bash
export MAINWP_API_URL=https://your-dashboard.example.com
export MAINWP_USER=your-admin-username
export MAINWP_APP_PASSWORD=your-application-password

npm run test:live
```

The live suite includes API tests (login, abilities discovery, read-only execution, safety model, exit codes) and workflow doc tests (validates that every jq expression, field name, and data pipeline documented in `docs/workflows/` works against the real API).

Live tests are safe: they only run read-only operations and `--dry-run` previews, never mutations.

---

## License

GPL-3.0-or-later

---

## Requirements

- Node.js 20 LTS or later
- MainWP Dashboard 6+ with Abilities API
- WordPress Application Password

---

- [MainWP](https://mainwp.com/)
- [MainWP MCP Server](https://github.com/mainwp/mainwp-mcp)
- [Issue Tracker](https://github.com/mainwp/mainwp-control/issues)
