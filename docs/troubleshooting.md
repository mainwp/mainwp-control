# Troubleshooting

Start with the built-in diagnostics before anything on this page:

```bash
mainwpcontrol doctor -v
```

`doctor` checks your configuration, credentials, and Dashboard connectivity, and names the failing layer.

## "keytar failed to build" or native module errors during install

Keytar (the keychain module) requires native C++ compilation on some platforms. Pre-built binaries cover macOS, Windows, and Linux (x64/arm64); elsewhere the build can fail. If it does:

1. **Skip keytar and use environment variable auth.** `MAINWP_APP_PASSWORD` supplies the credential, but login still tries the keychain layer unless you disable it, so set both:
   ```bash
   export MAINWPCONTROL_NO_KEYTAR=1
   export MAINWP_APP_PASSWORD='your-application-password'
   export MAINWP_DASHBOARD_URL='https://dashboard.example.com'
   mainwpcontrol login --url https://dashboard.example.com --username admin
   mainwpcontrol abilities list
   ```
   `MAINWP_DASHBOARD_URL` is required alongside the password: the CLI releases the environment credential only to the Dashboard it names, and refuses when it is missing or points elsewhere.
2. **Or install C++ build tools** (`gcc`, `g++`, `make`) and reinstall.

## "command not found" after install

Your npm global bin directory isn't on your PATH.

1. Find where npm installs global packages:
   ```bash
   npm config get prefix
   ```
2. Add the `bin` subdirectory to your PATH. For example, if the prefix is `/usr/local`:
   ```bash
   # Add to ~/.bashrc, ~/.zshrc, or your shell profile:
   export PATH="/usr/local/bin:$PATH"
   ```
3. Restart your terminal (or run `source ~/.zshrc` / `source ~/.bashrc`) and try again.

On Windows, the npm global directory is usually already in PATH after installing Node.js.

## "connection refused" or network errors

1. **Check the Dashboard URL.** Use the full URL with `https://` (e.g., `https://dashboard.example.com`), no trailing slash.
2. **Verify HTTPS.** HTTPS is required by default. If your Dashboard uses HTTP (not recommended), set `MAINWP_ALLOW_HTTP=1`.
3. **Check firewall/network.** Confirm your machine can reach the Dashboard:
   ```bash
   curl -I https://dashboard.example.com
   ```
4. **SSL certificate issues.** For a self-signed certificate, `mainwpcontrol login --skip-ssl-verify` accepts it for that profile (not for production).

## Authentication fails after upgrading

Version 1.1.0 binds stored credentials to the Dashboard identity they were created for, and refuses credentials saved by earlier beta versions. If commands that worked before the upgrade now fail with an authentication error, run:

```bash
mainwpcontrol login
```

once for each profile. This is a one-time migration; your Application Password itself is still valid.

## Authentication fails on a fresh setup

1. Confirm the Application Password was created on the **Dashboard** site, under the user you're logging in as, and copied exactly (spaces are fine either way).
2. Confirm the user has administrator access to the MainWP Dashboard.
3. Some security plugins and hosts disable Application Passwords; check for that if login rejects a freshly created password.

## An ability fails with an API error (exit 4)

1. Check the input schema: `mainwpcontrol abilities info <name>` shows required fields and types.
2. Re-run with `--debug` to see redacted request diagnostics on stderr.
3. Confirm the ability exists on your Dashboard version: `mainwpcontrol abilities list`. The set varies by Dashboard version, and the CLI only sees what the Dashboard exposes.

## Still stuck?

[Open an issue](https://github.com/mainwp/mainwp-control/issues) with the command you ran, the `--debug` stderr output, and your `doctor -v` output. Before posting, remove anything that identifies your setup: credentials and tokens, usernames, Dashboard URLs, and site names or IDs.
