# Getting Started

This guide covers the background the rest of the documentation assumes: what a terminal is, what npm does, how Application Passwords work, and how to pass JSON on the command line. If you already live in a terminal, skip to the [README Quick Start](../README.md#quick-start).

## What is a terminal?

A terminal is where you type commands instead of clicking buttons. You'll see it called "command line" or "shell" in different places.

**How to open it:**

- **macOS**: Open **Terminal** (search in Spotlight, or look in Applications > Utilities)
- **Windows**: Open **Git Bash** (installed with [Git for Windows](https://gitforwindows.org/)). If you don't have it, PowerShell works too; see the [quoting notes](#json-quoting-on-the-command-line) below.
- **Linux**: Open your distribution's **Terminal** app (usually in the applications menu)

## What does `npm install -g` do?

`npm` is the Node.js package manager. It downloads and installs JavaScript packages. The `-g` flag installs globally, which makes `mainwpcontrol` available as a command anywhere on your system, not only in one project folder.

```bash
npm install -g @mainwp/control
```

If the command isn't found afterward, your npm global bin directory probably isn't on your PATH; see [Troubleshooting](troubleshooting.md#command-not-found-after-install).

## What is an Application Password?

WordPress Application Passwords let external tools like `mainwpcontrol` access your site without using your main login password. They look like groups of four characters separated by spaces (e.g., `abcd efgh ijkl mnop qrst uvwx`).

**To create one:** Log into your MainWP Dashboard as an administrator > **Users > Profile** > scroll to **Application Passwords** > enter a name like "MainWP Control" > click **Add New Application Password** > copy the generated password. It is shown only once. You can revoke it from the same screen at any time, without touching your login password.

Create a dedicated WordPress user for API access rather than using your main admin account. It keeps the audit trail clean and is easy to revoke later.

## What is an environment variable?

An environment variable is a named value that programs can read. They're commonly used for passwords and API keys.

```bash
# macOS / Linux / Git Bash (lasts until you close the terminal)
export MAINWP_APP_PASSWORD='xxxx xxxx xxxx xxxx xxxx xxxx'

# Windows PowerShell (lasts until you close the window)
$env:MAINWP_APP_PASSWORD = 'xxxx xxxx xxxx xxxx xxxx xxxx'
```

For long-term storage, use the OS keychain (the default when you run `mainwpcontrol login`) or a restricted-permission `.env` file rather than pasting credentials into shell profile files. Note that `mainwpcontrol` does not read `.env` files itself: source the file (or export the variable another way) before running the CLI.

## Reading command output

- **`--json`** tells `mainwpcontrol` to print structured JSON on stdout, for scripting and piping to other tools.
- **Exit codes** indicate success (`0`) or failure (`1` through `5`; interrupted commands exit `130` or `143`). You won't see them directly, but scripts and CI use them to decide what happens next. Run `echo $?` (macOS/Linux) or `echo $LASTEXITCODE` (PowerShell) after a command to check. The full table is in the [CLI Reference](cli-reference.md#exit-codes).

## JSON quoting on the command line

When you pass JSON with `--input`, quoting depends on your shell:

```bash
# macOS / Linux / Git Bash on Windows
mainwpcontrol abilities run get-site-v1 --input '{"site_id_or_domain": 1}' --json
```

**Git Bash on Windows** handles quoting the same way macOS and Linux do. If you use Git Bash, all the examples in this documentation work without changes.

**Windows PowerShell** quoting of inline JSON is unreliable: whether backslash-escaped quotes inside a single-quoted string reach the command intact depends on your PowerShell version. Don't fight it. Put your parameters in a file and use `--input-file`:

```bash
mainwpcontrol abilities run get-site-v1 --input-file params.json --json
```

This works the same on every platform. See [Input from File](workflows/input-from-file.md) for stdin and heredoc variants.

## Next steps

- Run through the [Quick Start](../README.md#quick-start) to connect your Dashboard
- Browse the [CLI Reference](cli-reference.md) to see every command
- Try a [workflow guide](workflows/) when you're ready to automate something real
