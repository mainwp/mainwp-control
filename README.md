# MainWP Control

A CLI for managing your MainWP Dashboard from the terminal. The command is `mainwpctl`.

You can list sites, check status, push updates, sync data, add or remove child sites, and run batch operations across dozens of sites. Everything outputs structured JSON for piping into other tools. Exit codes are deterministic so CI pipelines can branch on them. There's also an optional chat mode if you want to explore abilities conversationally before scripting them.

---

## When to Use MainWP Control vs MCP Server

**[MainWP MCP Server](https://github.com/mainwp/mainwp-mcp)** is for conversational AI management: natural language queries inside Claude, Cursor, ChatGPT, or any MCP-compatible client. Good for exploration, ad-hoc questions, and interactive workflows.

**MainWP Control** is for automation: cron jobs, CI/CD pipelines, monitoring scripts, and batch operations. `mainwpctl` gives you deterministic exit codes, stable JSON output, and composability with standard Unix tools. Both talk to the same Abilities API with the same safety model.

---

## Quick Start

### Prerequisites

1. **Node.js 20 or later** (the LTS version from [nodejs.org](https://nodejs.org/) is recommended)
2. **A MainWP Dashboard** (version 6+) with the Abilities API enabled
3. **A WordPress Application Password** (not your login password). Create one in WordPress admin under Users > Your Profile > Application Passwords. See the [WordPress Application Passwords guide](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/) for details.

### Option A: Standard install (recommended)

This is the best path for most users. Pre-built keychain binaries are included for macOS, Windows, and Linux (x64 and arm64). On other platforms, you may need C++ build tools during installation.

```bash
# Install globally
npm install -g @mainwp/control

# Log in (stores credentials in your OS keychain)
mainwpctl login

# Verify it works
mainwpctl abilities run list-sites-v1 --json
```

### Option B: Environment variable auth (no keychain)

Use this if keytar fails to build, or in CI, Docker, and headless environments where no OS keychain is available.

```bash
# Install globally
npm install -g @mainwp/control

# Set your Application Password as an env var
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'

# Log in non-interactively (credentials stay in the environment, not on disk)
mainwpctl login --url https://dashboard.example.com --username admin

# Verify it works
mainwpctl abilities run list-sites-v1 --json
```

> **Tip:** If keytar is installed but broken, set `MAINWPCTL_NO_KEYTAR=1` to skip loading it entirely.

When the OS keychain is unavailable, `mainwpctl` does not persist plaintext credentials. Keep `MAINWP_APP_PASSWORD` set for each run on CI, cron hosts, and headless servers.

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

`npm` is the Node.js package manager. It downloads and installs JavaScript packages. The `-g` flag installs globally, which makes `mainwpctl` available as a command anywhere on your system, not only in one project folder.

### What is an environment variable?

An environment variable is a named value that programs can read. They're commonly used for passwords and API keys.

**Setting one:**
```bash
# macOS / Linux (lasts until you close the terminal)
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'

# Windows PowerShell (lasts until you close the window)
$env:MAINWP_APP_PASSWORD = 'xxxx xxxx xxxx xxxx xxxx xxxx'
```

For long-term storage, use the OS keychain (the default when you run `mainwpctl login`) or a restricted-permission `.env` file rather than pasting credentials into shell profile files.

### What is an Application Password?

WordPress Application Passwords let external tools like `mainwpctl` access your site without using your main login password. They look like groups of four characters separated by spaces (e.g., `abcd efgh ijkl mnop qrst uvwx`).

**To create one:** Log into WordPress admin > Users > Your Profile > scroll to **Application Passwords** > enter a name like "mainwpctl" > click **Add New Application Password** > copy the generated password.

### Reading command output

When you run a command, the output appears in your terminal. A few things to know:

- **`--json`** tells `mainwpctl` to output structured JSON (useful for scripting and piping to other tools)
- **Exit codes** indicate success (`0`) or failure (`1` through `5`). You won't see them directly, but scripts and CI use them to decide what happens next. Run `echo $?` (macOS/Linux) or `echo $LASTEXITCODE` (PowerShell) after a command to check.

</details>

---

## Real-World Workflows

We recommend a two-step pattern for destructive operations: preview first, then execute.

```bash
# Step 1: Preview what will be deleted (nothing changes)
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --dry-run --json

# Step 2: Execute after reviewing the preview
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --confirm --force --json
```

Each workflow guide below walks you from creating an Application Password through a working result, with every step verified.

| Workflow | Description |
|----------|-------------|
| [Daily Health Check](docs/workflows/daily-health-check.md) | Cron job that checks site connectivity and alerts via Slack |
| [Plugin Deployment Verification](docs/workflows/plugin-deployment-verification.md) | GitHub Actions workflow to verify a plugin exists across all sites |
| [Monthly Batch Updates](docs/workflows/monthly-batch-updates.md) | Preview and apply updates safely, scripted and GitHub Actions variants |
| [Input from File](docs/workflows/input-from-file.md) | Pass complex parameters via JSON files, stdin pipes, or heredocs |
| [Monitoring Integration](docs/workflows/monitoring-integration.md) | Send site metrics to Datadog, StatsD, or other monitoring tools |

---

## Commands

### Abilities

The MainWP Abilities API provides all available operations:

```bash
# List all abilities
mainwpctl abilities list

# Get ability details (input schema, annotations)
mainwpctl abilities info <ability-name>

# Execute an ability
mainwpctl abilities run <ability-name> [--input JSON] [--input-file path] [--json]

# Execute and wait for batch completion
mainwpctl abilities run <ability-name> --wait [--wait-timeout 300] --json
```

### Batch Jobs

Monitor long-running batch operations:

```bash
# Watch a batch job
mainwpctl jobs watch <job-id>

# With timeout
mainwpctl jobs watch <job-id> --timeout 120
```

### Diagnostics

```bash
# Check configuration and connectivity
mainwpctl doctor

# Verbose output with details
mainwpctl doctor -v

# JSON output for scripting
mainwpctl doctor --json
```

### Profile Management

```bash
# List all profiles
mainwpctl profile list

# Switch active profile
mainwpctl profile use <profile-name>
```

### Authentication

```bash
# Interactive login (stores credentials in OS keychain)
mainwpctl login

# Non-interactive login for CI/containers (password from env var)
export MAINWP_APP_PASSWORD='your-application-password'
mainwpctl login --url https://dashboard.example.com --username admin
```

To create an Application Password: log into WordPress admin > Users > Your Profile > Application Passwords > add a new password named "mainwpctl".

When the OS keychain is unavailable, `mainwpctl` does not persist plaintext credentials. Keep `MAINWP_APP_PASSWORD` set for each non-interactive run on CI, cron hosts, and headless servers.

### Chat Mode

Optional interactive mode for exploring abilities before scripting them. Requires an LLM provider key.

```bash
# Interactive chat
mainwpctl chat

# Single message (works in scripts)
mainwpctl chat "list all sites with pending updates"
```

Chat requires one of these environment variables:
- `ANTHROPIC_API_KEY` (Anthropic Claude)
- `OPENAI_API_KEY` (OpenAI GPT)
- `GOOGLE_API_KEY` (Google Gemini)
- `OPENROUTER_API_KEY` (OpenRouter)
- `LOCAL_LLM_API_KEY` (Local endpoint, with optional `LOCAL_LLM_URL`)

In non-TTY environments (pipes, CI), `mainwpctl chat` without a message exits with guidance. Use `mainwpctl chat "message"` for single-message mode in scripts.

---

## Safety Model

Destructive operations support a two-step workflow: preview with `--dry-run`, then execute with `--confirm`. Server-side confirmation enforcement is handled by the Abilities REST API. See the [Real-World Workflows](#real-world-workflows) section above for examples.

In CI/scripted workflows, you can pass `--confirm --force` directly if you've already validated the operation.

---

## Exit Codes

| Code | Meaning | CI Usage |
|------|---------|----------|
| 0 | Success | Continue pipeline |
| 1 | User/input error | Fix command syntax |
| 2 | Auth/config error | Check credentials |
| 3 | Network error | Retry or check connectivity |
| 4 | API error | Check ability parameters |
| 5 | Internal error | Report bug |

---

## Global Flags

| Flag | Description |
|------|-------------|
| `--json` | Structured JSON output |
| `--quiet` / `-q` | Suppress output (exit code only) |
| `--profile <name>` | Use specific profile |
| `--debug` | Show redacted debug diagnostics on stderr |
| `--help` | Show help |

### Abilities Run Flags

| Flag | Description |
|------|-------------|
| `--input` / `-i` | Input parameters as JSON (use `-` for stdin) |
| `--input-file` | Read input from a JSON file |
| `--dry-run` | Preview changes without executing |
| `--confirm` | Execute destructive ability |
| `--force` | Skip interactive confirmation (CI mode) |
| `--wait` | Block until batch job completes |
| `--wait-timeout` | Max seconds to wait (default: 300) |

---

## Environment Variables

### MainWP Configuration

| Variable | Description |
|----------|-------------|
| `MAINWP_APP_PASSWORD` | Application password for non-interactive login and commands when keychain storage is unavailable |
| `MAINWPCTL_NO_KEYTAR` | Set to `1` to skip keytar (keychain) loading entirely |
| `MAINWP_ALLOW_HTTP` | Set to `1` to allow insecure HTTP Dashboard URLs |

### Chat Configuration (optional)

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LOCAL_LLM_API_KEY` | Local LLM provider (required, enables local provider) |
| `LOCAL_LLM_URL` | Local endpoint URL (optional, defaults to localhost) |
| `MAINWP_LLM_PROVIDER` | Override auto-detected provider |
| `MAINWP_LLM_MODEL` | Specify model to use |

---

## Configuration File

Settings in `~/.config/mainwpctl/settings.json`:

```json
{
  "defaultJsonOutput": true,
  "timeout": 30000,
  "debug": false,
  "llmProvider": "openai",
  "chatContextMessages": 20
}
```

| Setting | Type | Description |
|---------|------|-------------|
| `defaultJsonOutput` | boolean | Default to JSON output |
| `timeout` | number | Default HTTP request timeout in milliseconds |
| `debug` | boolean | Enable debug output |
| `llmProvider` | string | Default LLM provider for chat |
| `chatContextMessages` | number | Max messages in chat context |
| `skipSSLVerification` | boolean | Advanced fallback: disable TLS verification when the active profile does not set its own SSL preference |
| `allowInsecureHttp` | boolean | Advanced fallback: allow `http://` Dashboard URLs without setting `MAINWP_ALLOW_HTTP=1` |

`skipSSLVerification` and `allowInsecureHttp` are insecure overrides. Prefer storing TLS behavior on the profile with `mainwpctl login --skip-ssl-verify`, and keep HTTPS as the default transport.

---

## Shell Completion

```bash
# Bash
source /path/to/mainwpctl/scripts/completions/mainwpctl.bash

# Zsh
source /path/to/mainwpctl/scripts/completions/mainwpctl.zsh
```

## Requirements

- Node.js 20 LTS or later
- MainWP Dashboard 6+ with Abilities API
- WordPress Application Password

---

## Troubleshooting

<details>
<summary><strong>"keytar failed to build" or native module errors during install</strong></summary>

Keytar requires native C++ compilation on some platforms. If it fails:

1. **Use environment variable auth instead** (bypasses keytar entirely):
   ```bash
   export MAINWP_APP_PASSWORD='your-application-password'
   mainwpctl login --url https://dashboard.example.com --username admin
   ```
2. **Or skip keytar explicitly** by setting `MAINWPCTL_NO_KEYTAR=1` before running commands.

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

If `mainwpctl login` or commands fail with connection errors:

1. **Check the Dashboard URL.** Make sure it's the full URL with `https://` (e.g., `https://dashboard.example.com`). Don't include a trailing slash.
2. **Verify HTTPS.** `mainwpctl` requires HTTPS by default. If your Dashboard uses HTTP (not recommended), set `MAINWP_ALLOW_HTTP=1`.
3. **Check firewall/network.** Make sure your machine can reach the Dashboard:
   ```bash
   curl -I https://dashboard.example.com
   ```
4. **SSL certificate issues.** If using a self-signed certificate, you can use `mainwpctl login --skip-ssl-verify` (not recommended for production).

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
# Set credentials (or export from an .env file)
export MAINWP_API_URL=https://your-dashboard.example.com
export MAINWP_USER=your-admin-username
export MAINWP_APP_PASSWORD=your-application-password

npm run test:live
```

The live suite includes:
- **API tests**: login, abilities discovery, read-only execution, safety model, exit codes
- **Workflow doc tests**: validates that every jq expression, field name, and data pipeline documented in `docs/workflows/` works against the real API

Live tests are safe: they only run read-only operations and `--dry-run` previews, never mutations.

---

## License

GPL-3.0-or-later

---

- [MainWP](https://mainwp.com/)
- [MainWP MCP Server](https://github.com/mainwp/mainwp-mcp)
- [Issue Tracker](https://github.com/mainwp/mainwp-control/issues)
