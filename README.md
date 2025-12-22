# mainwpctl

AI-first command-line interface for managing MainWP Dashboards.

`mainwpctl` provides deterministic control over your MainWP Dashboard and connected WordPress sites. It uses the MainWP Abilities API for all operations, ensuring consistent behavior between manual commands and AI-assisted chat.

## Quick Start

### Installation

```bash
# From npm (when published)
npm install -g mainwpctl

# From source
git clone https://github.com/mainwp/mainwpctl.git
cd mainwpctl
npm install
npm run build
npm link
```

### Authentication

Connect to your MainWP Dashboard using a WordPress Application Password:

```bash
mainwpctl login
```

You'll be prompted for:
- **Dashboard URL**: Your MainWP Dashboard URL (e.g., `https://dashboard.example.com`)
- **Username**: WordPress admin username
- **Application Password**: Create one at *Users > Profile > Application Passwords*

### Basic Usage

```bash
# Start interactive chat (default)
mainwpctl

# List all sites
mainwpctl abilities run list-sites-v1

# Get site details
mainwpctl abilities run get-site-v1 --input '{"site_id_or_domain": 1}'

# Check available updates
mainwpctl abilities run list-updates-v1 --json
```

## Commands

### Chat Mode (Default)

Running `mainwpctl` without arguments starts interactive chat:

```bash
mainwpctl
```

In chat mode, describe what you want in natural language:
- "List all sites"
- "Show me plugins with updates"
- "Delete site example.com" (will ask for confirmation)

Chat requires an LLM provider. Set one of these environment variables:
- `ANTHROPIC_API_KEY` - Anthropic Claude
- `OPENAI_API_KEY` - OpenAI GPT
- `GOOGLE_API_KEY` - Google Gemini
- `OPENROUTER_API_KEY` - OpenRouter
- `LOCAL_LLM_URL` - Local OpenAI-compatible endpoint

### Authentication

```bash
# Login with prompts
mainwpctl login

# Login with flags
mainwpctl login --url https://dashboard.example.com --username admin

# Skip SSL verification (for local development)
mainwpctl login --skip-ssl-verify
```

### Profile Management

Manage multiple Dashboard connections:

```bash
# List all profiles
mainwpctl profile list

# Switch active profile
mainwpctl profile use <profile-name>
```

### Abilities

The MainWP Abilities API provides all available operations:

```bash
# List all abilities
mainwpctl abilities list

# Get ability details
mainwpctl abilities info <ability-name>

# Execute an ability
mainwpctl abilities run <ability-name> [--input JSON]
```

#### Running Abilities

```bash
# Read-only abilities run directly
mainwpctl abilities run list-sites-v1

# With parameters
mainwpctl abilities run get-site-v1 --input '{"site_id_or_domain": 1}'

# Destructive abilities require --dry-run first, then --confirm
mainwpctl abilities run delete-site-v1 --input '{"site_id_or_domain": 1}' --dry-run
mainwpctl abilities run delete-site-v1 --input '{"site_id_or_domain": 1}' --confirm
```

### Batch Jobs

Monitor long-running batch operations:

```bash
# Watch a batch job
mainwpctl jobs watch <job-id>

# With timeout
mainwpctl jobs watch <job-id> --timeout 300
```

### Diagnostics

Check configuration and connectivity:

```bash
# Run diagnostics
mainwpctl doctor

# Verbose output
mainwpctl doctor -v

# JSON output for scripting
mainwpctl doctor --json
```

## Global Flags

All commands support these flags:

| Flag | Description |
|------|-------------|
| `--json` | Output JSON (for scripting/CI) |
| `--profile <name>` | Use specific profile |
| `--debug` | Show debug output |
| `--help` | Show help |

## Shell Completion

Enable tab completion for commands, flags, and profile names:

```bash
# Bash - add to ~/.bashrc
source /path/to/mainwpctl/scripts/completions/mainwpctl.bash

# Zsh - add to ~/.zshrc
source /path/to/mainwpctl/scripts/completions/mainwpctl.zsh
```

For detailed setup instructions, see [scripts/completions/README.md](scripts/completions/README.md).

## Safety Model

`mainwpctl` enforces safety for destructive operations:

1. **Preview Required**: Destructive abilities automatically show a preview using `--dry-run`
2. **Explicit Confirmation**: Execute with `--confirm` only after reviewing the preview
3. **Mutual Exclusion**: `--dry-run` and `--confirm` cannot be used together
4. **Chat Safety**: AI chat always previews destructive actions before asking for approval

### Example: Deleting a Site

```bash
# Step 1: Preview what will be deleted
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "example.com"}' \
  --dry-run

# Output shows what will be affected

# Step 2: Confirm deletion
mainwpctl abilities run delete-site-v1 \
  --input '{"site_id_or_domain": "example.com"}' \
  --confirm
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | User/input error |
| 2 | Auth/config error |
| 3 | Network error |
| 4 | API error |
| 5 | Internal error |

## Environment Variables

### Authentication

| Variable | Description |
|----------|-------------|
| `MAINWP_APP_PASSWORD` | Fallback application password (if keychain unavailable) |

### LLM Providers

| Variable | Provider |
|----------|----------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LOCAL_LLM_URL` | Local endpoint URL |

### Chat Options

| Variable | Description |
|----------|-------------|
| `MAINWP_LLM_PROVIDER` | Override auto-detected provider |
| `MAINWP_LLM_MODEL` | Specify model to use |

## Configuration File

Settings can be configured in `~/.config/mainwpctl/settings.json`:

```json
{
  "defaultJsonOutput": true,
  "timeout": 30000,
  "debug": false
}
```

### Available Settings

| Setting | Type | Description |
|---------|------|-------------|
| `defaultJsonOutput` | boolean | Default output format (`true` = JSON, `false` = human-readable) |
| `llmProvider` | string | Default LLM provider for chat |
| `timeout` | number | HTTP request timeout in milliseconds |
| `skipSSLVerification` | boolean | Skip SSL verification (not recommended) |
| `debug` | boolean | Enable debug output |
| `chatContextMessages` | number | Max messages in chat context (default: 20) |

### Default JSON Output

Set JSON as the default output format for all commands:

```json
{
  "defaultJsonOutput": true
}
```

The `--json` flag always takes precedence over this setting:

```bash
# Uses JSON output (from settings)
mainwpctl doctor

# Uses human-readable output (flag overrides setting)
mainwpctl doctor --json=false
```

## CI/CD Integration

`mainwpctl` is designed for CI pipelines:

```bash
# Set credentials via environment
export MAINWP_APP_PASSWORD="xxxx xxxx xxxx xxxx"

# Login
mainwpctl login --url https://dashboard.example.com --username admin

# Run commands with JSON output
mainwpctl abilities run list-sites-v1 --json | jq '.data.sites'

# Check for updates
UPDATES=$(mainwpctl abilities run list-updates-v1 --json | jq '.data.total')
if [ "$UPDATES" -gt 0 ]; then
  echo "Found $UPDATES updates"
fi
```

## Requirements

- Node.js 20 LTS or later
- MainWP Dashboard 5.2+ with Abilities API
- WordPress Application Password

## License

GPL-3.0-or-later

## Links

- [MainWP](https://mainwp.com/)
- [GitHub Repository](https://github.com/mainwp/mainwpctl)
- [Issue Tracker](https://github.com/mainwp/mainwpctl/issues)
