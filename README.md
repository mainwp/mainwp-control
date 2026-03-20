# MainWP Control

Automation and AI workflows for the MainWP Dashboard. The CLI command is `mainwpctl`.

### What You Can Do

- **Site Management**: List sites, check status, sync data, add or remove child sites
- **Update Management**: Preview and apply core, plugin, and theme updates across sites
- **Batch Operations**: Run updates, sync, or reconnect across dozens of sites with `--wait`
- **CI/CD Integration**: Deterministic exit codes, JSON output, and composability with Unix tools
- **Interactive Chat**: Explore abilities through natural conversation (optional, requires LLM key)

Built for WordPress agencies and site managers who automate their MainWP workflows.

---

## When to Use MainWP Control vs MCP Server

Use the **[MainWP MCP Server](https://github.com/mainwp/mainwp-mcp)** for conversational AI management — natural language queries inside Claude, Cursor, ChatGPT, or any MCP-compatible client. The MCP server excels at exploration, ad-hoc questions, and interactive workflows.

Use **MainWP Control** for automated and scripted workflows — cron jobs, CI/CD pipelines, monitoring scripts, and batch operations. `mainwpctl` gives you deterministic exit codes, stable JSON output, and composability with standard Unix tools. Both talk to the same Abilities API with the same safety model.

---

## Quick Start

**Requirements:** Node.js >=20 and MainWP Dashboard 6+ with Abilities API

```bash
# Install
npm install -g mainwpctl

# Authenticate
mainwpctl login

# List sites (JSON for scripting)
mainwpctl abilities run list-sites-v1 --json
```

---

## Real-World Workflows

Destructive operations in MainWP Control follow a safe two-step pattern — preview first, then execute:

```bash
# Step 1: Preview what will be deleted (nothing is modified)
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --dry-run --json

# Step 2: Apply after reviewing the preview
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --confirm --force --json
```

Each workflow guide below is fully standalone — it walks you from creating an Application Password through a working result, with every step verified and every concept explained.

| Workflow | Description |
|----------|-------------|
| [Daily Health Check](docs/workflows/daily-health-check.md) | Cron job that checks site connectivity and alerts via Slack |
| [Plugin Deployment Verification](docs/workflows/plugin-deployment-verification.md) | GitHub Actions workflow to verify a plugin exists across all sites |
| [Monthly Batch Updates](docs/workflows/monthly-batch-updates.md) | Preview and apply updates safely — scripted and GitHub Actions variants |
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
# Interactive login
mainwpctl login

# Non-interactive login (CI)
export MAINWP_APP_PASSWORD='your-application-password'
mainwpctl login --url https://dashboard.example.com --username admin
```

When the OS keychain is unavailable, `mainwpctl` does not persist plaintext credentials. Keep `MAINWP_APP_PASSWORD` available to each non-interactive run on CI, cron hosts, and headless servers.

### Chat Mode

Optional interactive mode for exploring abilities before scripting them. Requires an LLM provider key.

```bash
# Interactive chat
mainwpctl chat

# Single message (works in scripts)
mainwpctl chat "list all sites with pending updates"
```

Chat requires one of these environment variables:
- `ANTHROPIC_API_KEY` — Anthropic Claude
- `OPENAI_API_KEY` — OpenAI GPT
- `GOOGLE_API_KEY` — Google Gemini
- `OPENROUTER_API_KEY` — OpenRouter
- `LOCAL_LLM_API_KEY` — Local endpoint (with optional `LOCAL_LLM_URL`)

Note: In non-TTY environments (pipes, CI), `mainwpctl chat` without a message exits with guidance. Use `mainwpctl chat "message"` for single-message mode in scripts.

---

## Safety Model

Destructive operations follow a two-step pattern:

1. **Preview** with `--dry-run` to see what will change
2. **Execute** with `--confirm` after reviewing the preview

In CI/scripted workflows, you can pass `--confirm --force` directly if you've
already validated the operation.

### Example: Deleting a Site

```bash
# Step 1: Preview what will be deleted
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --dry-run

# Step 2: Confirm deletion
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "mysite.com"}' \
  --confirm
```

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
| `MAINWP_APP_PASSWORD` | Application password for non-interactive login and for commands when keychain storage is unavailable |
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
- **API tests** — login, abilities discovery, read-only execution, safety model, exit codes
- **Workflow doc tests** — validates that every jq expression, field name, and data pipeline documented in `docs/workflows/` works against the real API

Live tests are safe: they only run read-only operations and `--dry-run` previews — never mutations.

---

## License

GPL-3.0-or-later

---

- [MainWP](https://mainwp.com/)
- [MainWP MCP Server](https://github.com/mainwp/mainwp-mcp)
- [Issue Tracker](https://github.com/mainwp/mainwp-control/issues)
