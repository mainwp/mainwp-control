# Configuration

How MainWP Control stores credentials, profiles, and settings, and every environment variable it reads.

## Credential storage

`mainwpcontrol login` stores your Application Password in the operating system keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux). Pre-built keychain binaries are included for macOS, Windows, and Linux (x64 and arm64); on other platforms npm may need C++ build tools during installation.

The profile file on disk records the Dashboard URL and username only. It never contains passwords.

Stored credentials are bound to the Dashboard identity they were created for. If you upgraded from a 1.0.x beta and requests now fail with an authentication error, run `mainwpcontrol login` once per profile; see [Troubleshooting](troubleshooting.md#authentication-fails-after-upgrading).

### Environment variable auth

For CI, Docker, and machines without a keychain, put the password in the environment instead:

```bash
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'
mainwpcontrol login --url https://dashboard.example.com --username admin
```

When no keychain is available, the password is never written to disk; keep `MAINWP_APP_PASSWORD` set for each run, together with `MAINWP_DASHBOARD_URL`:

```bash
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'
export MAINWP_DASHBOARD_URL='https://dashboard.example.com'
mainwpcontrol abilities list
```

`login` takes the destination as `--url`, so it needs only the password. Every later command reads the credential back, and the CLI hands it over only when `MAINWP_DASHBOARD_URL` matches the profile it is about to authenticate against; otherwise the command fails instead of sending the password. That way a `profiles.json` that someone else can write cannot point your credential at their server. Keychain-stored credentials carry the same binding internally and need no extra variable. `doctor` and `config show` only display configuration, so they are unaffected.

The profile file is still written and records the Dashboard URL and username, as it does in every mode. If keytar is installed but broken, set `MAINWPCONTROL_NO_KEYTAR=1` to skip loading it.

## Profiles

A profile is a named connection to one Dashboard, created automatically by `login` and named after the hostname:

```bash
# Creates profile "staging.example.com"
mainwpcontrol login --url https://staging.example.com --username admin

# Creates profile "production.example.com"
mainwpcontrol login --url https://production.example.com --username admin
```

Profiles live at `~/.config/mainwpcontrol/profiles.json`. Switch the default with `profile use`, target one per command with `--profile`, and remove one (including its keychain entry) with `profile delete`. Command details are in the [CLI Reference](cli-reference.md#profile).

## Settings file

Optional defaults live at `~/.config/mainwpcontrol/settings.json` (or `$XDG_CONFIG_HOME/mainwpcontrol/settings.json` if you set `XDG_CONFIG_HOME`):

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
| `timeout` | number | HTTP request timeout in milliseconds |
| `debug` | boolean | Enable debug output |
| `llmProvider` | string | Default LLM provider for chat |
| `chatContextMessages` | number | Max messages in chat context |
| `skipSSLVerification` | boolean | Disable TLS verification (insecure; prefer the per-profile setting via `login --skip-ssl-verify`) |
| `allowInsecureHttp` | boolean | Allow `http://` Dashboard URLs without `MAINWP_ALLOW_HTTP=1` |

Inspect the active values with `mainwpcontrol config show`.

## Environment variables

### MainWP

| Variable | Description |
|----------|-------------|
| `MAINWP_APP_PASSWORD` | Application Password for non-interactive login, and for commands when no keychain is available |
| `MAINWP_DASHBOARD_URL` | The Dashboard `MAINWP_APP_PASSWORD` belongs to. Required whenever a command authenticates using that fallback |
| `MAINWPCONTROL_NO_KEYTAR` | Set to `1` to skip keytar (keychain) loading entirely |
| `MAINWP_ALLOW_HTTP` | Set to `1` to allow insecure HTTP Dashboard URLs |

### Chat / LLM

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude |
| `OPENAI_API_KEY` | OpenAI GPT |
| `GOOGLE_API_KEY` | Google Gemini |
| `OPENROUTER_API_KEY` | OpenRouter |
| `LOCAL_LLM_API_KEY` | Local LLM provider (required to enable the local provider) |
| `LOCAL_LLM_URL` | Local endpoint URL (optional, defaults to localhost) |
| `MAINWP_LLM_API_KEY` | Generic API key for the selected provider (alternative to the provider-specific variables) |
| `MAINWP_LLM_PROVIDER` | Override the auto-detected provider |
| `MAINWP_LLM_MODEL` | Specify the model to use |

Chat behavior and flags are covered in [Chat Mode](chat.md).

## TLS and HTTP

HTTPS is required by default. Two escape hatches exist for development environments:

- `mainwpcontrol login --skip-ssl-verify` accepts a self-signed certificate for that profile.
- `MAINWP_ALLOW_HTTP=1` (or `allowInsecureHttp` in settings) permits `http://` URLs.

Both send credentials over connections an attacker on the network path can read or alter. Use them for local development against test Dashboards, never in production.
