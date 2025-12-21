# Shell Completion for mainwpctl

This directory contains shell completion scripts for `mainwpctl`, providing tab completion for commands, flags, and dynamic data like profile names.

## Quick Start

### Bash

Add to your `~/.bashrc`:

```bash
source /path/to/mainwpctl/scripts/completions/mainwpctl.bash
```

Then reload your shell:

```bash
source ~/.bashrc
```

### Zsh

Add to your `~/.zshrc`:

```bash
source /path/to/mainwpctl/scripts/completions/mainwpctl.zsh
```

Then reload your shell:

```bash
source ~/.zshrc
```

## For npm-installed CLI

If you installed `mainwpctl` globally via npm:

```bash
# Find the installation path
npm root -g

# Source from node_modules (bash example)
source $(npm root -g)/mainwpctl/scripts/completions/mainwpctl.bash

# Or for zsh
source $(npm root -g)/mainwpctl/scripts/completions/mainwpctl.zsh
```

## For Local Development

If you're developing from the cloned repository:

```bash
# Bash
source ./scripts/completions/mainwpctl.bash

# Zsh
source ./scripts/completions/mainwpctl.zsh
```

## What's Completed

### Commands

All top-level and subcommands are completed:

- `chat` - Interactive chat mode
- `login` - Authenticate with a Dashboard
- `doctor` - Check configuration and connectivity
- `abilities list` - List available abilities
- `abilities info` - Get ability details
- `abilities run` - Execute an ability
- `profile list` - List all profiles
- `profile use` - Switch active profile
- `profile delete` - Delete a profile
- `jobs watch` - Monitor a batch job
- `autocomplete` - Display autocomplete setup instructions

### Flags

All command flags are completed:

**Common flags (all commands):**
- `--json` - Output JSON
- `--profile`, `-p` - Use specific profile
- `--debug` - Show debug output
- `--help` - Show help

**abilities run:**
- `--input`, `-i` - Input parameters as JSON
- `--dry-run` - Preview changes
- `--confirm` - Execute after preview
- `--force` - Skip confirmation prompt

**abilities list:**
- `--category` - Filter by category (sites, clients, updates, plugins, themes, core, tags, batch)

**chat:**
- `--provider` - LLM provider (anthropic, gemini, local, openai, openrouter)
- `--model`, `-m` - Model to use
- `--api-key` - LLM API key
- `--base-url` - Custom API base URL
- `--max-turns` - Maximum tool calls per turn
- `--max-context-messages` - Maximum messages in context
- `--stream` / `--no-stream` - Enable/disable streaming

**doctor:**
- `--verbose`, `-v` - Verbose output

**jobs watch:**
- `--timeout` - Maximum wait time
- `--initial-delay` - Initial polling delay
- `--max-delay` - Maximum polling delay
- `--no-progress` - Disable progress output

**login:**
- `--url`, `-u` - Dashboard URL
- `--username` - WordPress username
- `--password` - Application password
- `--name`, `-n` - Profile name
- `--skip-ssl-verify` - Skip SSL verification

### Dynamic Data

Profile names are completed dynamically for:

- `--profile` flag on all commands
- `profile use <name>` argument
- `profile delete <name>` argument

Profile names are read from `~/.config/mainwpctl/profiles.json`.

## Updating Completions

After adding, removing, or modifying commands/flags in the CLI, run:

```bash
./scripts/completions/regenerate.sh
```

This provides guidance on which files to update.

## File Structure

| File | Purpose |
|------|---------|
| `mainwpctl.bash` | Bash completion script |
| `mainwpctl.zsh` | Zsh completion script |
| `profile-completer.sh` | Helper to read profile names from config |
| `regenerate.sh` | Helper script for updating completions |
| `README.md` | This documentation |

## Troubleshooting

### Completions not working

1. **Check if sourced correctly:**
   ```bash
   # Bash
   complete -p mainwpctl

   # Zsh
   whence -f _mainwpctl
   ```

2. **Reload shell configuration:**
   ```bash
   # Bash
   source ~/.bashrc

   # Zsh
   source ~/.zshrc
   ```

3. **Check file paths:**
   Ensure the sourced path in your shell config points to the correct location.

### Profile names not completing

1. **Check if profiles.json exists:**
   ```bash
   cat ~/.config/mainwpctl/profiles.json
   ```

2. **Check if jq is installed (optional but recommended):**
   ```bash
   which jq
   ```
   If not installed, the fallback grep/sed parser is used.

### Bash completion not found

Ensure `bash-completion` is installed:

```bash
# macOS
brew install bash-completion@2

# Ubuntu/Debian
apt install bash-completion

# Fedora/RHEL
dnf install bash-completion
```

### Permission errors

Make sure completion scripts are executable:

```bash
chmod +x scripts/completions/*.sh
chmod +x scripts/completions/mainwpctl.bash
chmod +x scripts/completions/mainwpctl.zsh
```

## Requirements

- **Bash:** Version 4.0+ with bash-completion v2.0+
- **Zsh:** Any modern version (built-in completion support)
- **Optional:** `jq` for reliable JSON parsing of profile names
