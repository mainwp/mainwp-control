# Input from File

> Pass complex parameters to mainwpctl using JSON files, stdin pipes, or heredocs instead of typing everything on the command line.

MainWP Control is a command-line tool for managing your MainWP Dashboard and all the WordPress sites connected to it. Some operations need structured data as input: site IDs, lists of plugins, or nested configuration objects. This guide shows you three ways to pass that structured data without wrestling with long, error-prone command-line strings.

---

## What You'll Learn

- How to write JSON parameter files for MainWP Control abilities
- Three ways to pass input: `--input-file`, `--input -` (stdin pipe), and heredocs
- When to use each method
- How to troubleshoot common mistakes

---

## Why Use File Input?

Some MainWP Control abilities need more than a flag. For example, updating specific plugins on a specific site requires a JSON object with a site ID and a list of plugin slugs. Typing this as an `--input` flag works for simple cases:

```bash
mainwpctl abilities run get-site-v1 --input '{"site_id_or_domain": 5}' --json
```

But when parameters get complex (nested objects, arrays, multiple fields), inline JSON becomes hard to read and easy to get wrong. A misplaced quote or missing comma can cause confusing errors.

File input solves this. You write your parameters in a file (or pipe them from another command), and MainWP Control reads them cleanly.

---

## Prerequisites

Before you start, make sure you have:

- **MainWP Dashboard 6 or later**, installed and running on a WordPress site you control
- **WordPress admin access** to that Dashboard site (you need to create an Application Password)
- **Node.js 20 or later** on the machine where you will run MainWP Control (your laptop, a server, a CI runner, etc.)

If you are not sure whether Node.js is installed, open a terminal and run:

```bash
node --version
```

You should see something like:

```
v20.11.0
```

If you get "command not found" or a version below 20, install Node.js from [https://nodejs.org](https://nodejs.org). Download the LTS version and follow the installer.

---

## Step 1: Create an Application Password

MainWP Control authenticates with your MainWP Dashboard using a WordPress Application Password. This is a special password that gives API access without sharing your main login credentials.

1. Log in to your WordPress Dashboard site as an administrator.
2. Go to **Users > Your Profile** (click your username in the top-right, then "Edit Profile", or navigate to `/wp-admin/profile.php`).
3. Scroll down to the **Application Passwords** section near the bottom of the page.
4. In the "New Application Password Name" field, type a name you will recognize later, for example: `mainwpctl`
5. Click **Add New Application Password**.
6. WordPress will display a password that looks something like this:

   ```
   AbCD 1234 efGH 5678 ijKL 9012
   ```

7. **Copy this password immediately.** WordPress will not show it again. If you lose it, you will need to create a new one.
8. Store it somewhere secure (a password manager is ideal).

The spaces in the password are optional. mainwpctl accepts the password with or without them.

---

## Step 2: Install MainWP Control

Open a terminal (on macOS: open the Terminal app; on Linux: open your terminal emulator; on Windows: use PowerShell or Windows Terminal).

### Option A: Global install (recommended)

This installs MainWP Control so it is available everywhere on your system:

```bash
npm install -g @mainwp/control
```

### Option B: Run without installing

If you prefer not to install globally, you can run MainWP Control on demand using `npx`:

```bash
npx mainwpctl --version
```

`npx` downloads and runs the package temporarily. Every example in this guide uses `mainwpctl` directly. If you chose Option B, replace `mainwpctl` with `npx mainwpctl` in every command.

### Verify the installation

```bash
mainwpctl --version
```

Expected output:

```
mainwpctl/x.y.z
```

You should see `mainwpctl/` followed by a version number. The exact values depend on your system.

---

## Step 3: Authenticate

Run the interactive login command:

```bash
mainwpctl login
```

MainWP Control will prompt you for three pieces of information:

1. **Dashboard URL:** the full URL of your MainWP Dashboard site, for example `https://manage.example.com`
2. **Username:** your WordPress admin username
3. **Application Password:** the password you created in Step 1

Enter each value when prompted. MainWP Control will test the connection and store the credentials in a local profile. If the machine cannot use the OS keychain, keep `MAINWP_APP_PASSWORD` available in the environment for future runs.

### Verify authentication

```bash
mainwpctl doctor
```

Expected output:

```
  MainWP Control CLI - System Check

  ────────────────────────────────────────
  ✓ Profiles
     1 profile(s) configured
  ✓ Keychain
     OS keychain available
  ✓ Active Profile
     Active: production
  ✓ Credentials
     Credentials available
  ✓ Dashboard Connection
     Connected to Dashboard
  ✓ Abilities API
     42 abilities available
  ⚠ LLM Provider
     No LLM provider configured
  ────────────────────────────────────────
  Summary: 6 passed, 1 warnings, 0 failed

  ✓ System is ready
```

If you see errors, double-check your Dashboard URL and Application Password. The URL must include `https://` and must be the site where MainWP Dashboard is installed.

---

## Step 4: Create a JSON Parameters File

### What is JSON?

JSON (JavaScript Object Notation) is a standard format for structured data, used by almost every web API. If you have never worked with JSON before, here are the key rules:

- Data is organized in **key-value pairs**: `"key": "value"`
- **Keys** are always in double quotes: `"site_id_or_domain"` (not `site_id` or `'site_id'`)
- **String values** are in double quotes: `"hello"` (not `'hello'`)
- **Number values** do not have quotes: `5` (not `"5"`)
- **Arrays** (ordered lists) use square brackets: `["akismet", "wordfence"]`
- **Objects** (groups of key-value pairs) use curly braces: `{"key": "value"}`
- **No trailing commas:** the last item in an object or array must not have a comma after it

Here is a quick comparison of valid and invalid JSON:

```
Valid:    {"site_id_or_domain": 5, "name": "blog"}
Invalid:  {site_id: 5, name: "blog"}         ← keys must be in double quotes
Invalid:  {"site_id_or_domain": 5, "name": "blog",}    ← trailing comma after last item
Invalid:  {'site_id': 5}                      ← single quotes are not allowed
```

### Create the file

Open a text editor (any editor works: VS Code, nano, Notepad, TextEdit in plain text mode) and create a file called `params.json` with this content:

```json
{
  "site_id_or_domain": 5
}
```

Save the file in a directory you can easily navigate to in your terminal.

Here is what each part means:

- `{` and `}`: the outer curly braces define a JSON object (a collection of key-value pairs)
- `"site_id_or_domain"`: the key, which tells mainwpctl which parameter you are setting
- `:` separates the key from the value
- `5`: the value (a number representing the site ID in your MainWP Dashboard)

This is the simplest possible parameter file. It passes a single site ID to an ability.

**How do you find your site ID?** Run `mainwpctl abilities run list-sites-v1 --json` to see all your connected sites. Each site in the output will have an `id` field. Replace `5` with your actual site ID.

### A more complex example

For updating specific plugins on a site, you might need:

```json
{
  "site_id_or_domain": 5,
  "plugins": ["akismet", "wordfence"]
}
```

This adds a second parameter called `plugins`. The value is an array (a list) containing two plugin slugs. A plugin slug is the short name used in the plugin's directory. You can find it by running `mainwpctl abilities run get-site-plugins-v1 --input '{"site_id_or_domain": 5}' --json` and looking at the `slug` field for each plugin.

Notice the comma after `5` on the first line. Commas separate items within an object. There is no comma after the last item (`"plugins"` line).

---

## Step 5: Run an Ability with --input-file

Now that you have a `params.json` file, use it with the `--input-file` flag:

```bash
mainwpctl abilities run get-site-v1 --input-file params.json --json
```

Here is what each part of this command does:

- `mainwpctl abilities run`: tells MainWP Control to execute an ability
- `get-site-v1`: the name of the ability (fetches details about a specific site)
- `--input-file params.json`: read the parameters from your `params.json` file instead of the command line
- `--json`: output the result as structured JSON (easier to read and use in scripts)

The file path (`params.json`) is relative to the directory where you run the command. If you are in `/home/user/projects` and the file is at `/home/user/projects/params.json`, then `params.json` works. You can also use an absolute path:

```bash
mainwpctl abilities run get-site-v1 --input-file /home/user/projects/params.json --json
```

Expected output (your values will differ):

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/get-site-v1",
    "success": true,
    "data": {
      "id": 5,
      "name": "My Blog",
      "url": "https://myblog.example.com",
      "status": "connected",
      "wp_version": "6.7.1",
      "php_version": "8.2.15"
    }
  }
}
```

> **Note:** MainWP Control wraps every JSON response in a standard envelope. The outer `success` field indicates the CLI completed successfully, and the actual API response data is nested inside `data.data`.

### Destructive operations

Some abilities make changes: updating plugins, deleting themes, modifying site settings. These are called destructive operations. For safety, MainWP Control requires you to explicitly confirm them:

```bash
mainwpctl abilities run update-site-plugins-v1 --input-file params.json --confirm --force
```

- `--confirm`: tells MainWP Control you have reviewed the action and want to proceed
- `--force`: skips the interactive confirmation prompt (useful in scripts and CI/CD pipelines)

Without `--confirm --force`, MainWP Control will show you a preview of what will happen and ask you to approve before executing.

---

## Step 6: Pipe JSON via Stdin with --input -

### What is stdin?

"stdin" stands for **standard input**. It is a way for one program to send data to another. In a terminal, the **pipe character** `|` connects the output of one command to the input of the next command.

Think of it like a conveyor belt: the command on the left produces data, the pipe moves it along, and the command on the right consumes it.

### Basic pipe

```bash
echo '{"site_id_or_domain": 5}' | mainwpctl abilities run get-site-v1 --input - --json
```

Here is what happens:

1. `echo '{"site_id_or_domain": 5}'`: the `echo` command outputs the JSON string to the terminal
2. `|`: the pipe takes that output and sends it as input to the next command
3. `mainwpctl abilities run get-site-v1 --input - --json`: mainwpctl runs the ability, and `--input -` tells it to read parameters from stdin (the `-` character means "read from the pipe instead of from a flag value")

Expected output:

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/get-site-v1",
    "success": true,
    "data": {
      "id": 5,
      "name": "My Blog",
      "url": "https://myblog.example.com",
      "status": "connected"
    }
  }
}
```

### Pipe from a file

You can also pipe the contents of a file into mainwpctl:

```bash
cat params.json | mainwpctl abilities run get-site-v1 --input - --json
```

`cat` is a command that reads a file and outputs its contents. The pipe then sends those contents to mainwpctl. This is equivalent to `--input-file params.json` but is useful when you want to chain multiple commands together or add processing steps between reading the file and sending it to MainWP Control.

### Pipe from another command

You can generate JSON dynamically and pipe it directly:

```bash
printf '{"site_id_or_domain": %d}' 5 | mainwpctl abilities run get-site-v1 --input - --json
```

`printf` is like `echo` but gives you more control over formatting. The `%d` is a placeholder that gets replaced with the number `5`. This is useful in scripts where the site ID comes from a variable or another command's output.

Expected output is the same as before: the site details as JSON.

---

## Step 7: Use a Heredoc for Inline Multi-line JSON

### What is a heredoc?

A heredoc (short for "here document") is a way to write multi-line text directly inside a shell command, without creating a separate file. It is especially useful for JSON because JSON is often easier to read when spread across multiple lines.

The syntax `<<'EOF'` means: "everything from here until you see `EOF` on its own line is the input." `EOF` is a marker word. You could use any word, but `EOF` (short for "end of file") is the convention.

### Basic heredoc

```bash
mainwpctl abilities run get-site-v1 --input - --json <<'EOF'
{
  "site_id_or_domain": 5
}
EOF
```

Here is what each part does:

- `mainwpctl abilities run get-site-v1 --input - --json`: runs the ability, reading parameters from stdin
- `<<'EOF'`: starts the heredoc. The single quotes around `EOF` are important (explained below)
- The lines between `<<'EOF'` and `EOF` are the JSON content sent as stdin
- `EOF` on its own line (no spaces before it, nothing after it): ends the heredoc

Expected output:

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/get-site-v1",
    "success": true,
    "data": {
      "id": 5,
      "name": "My Blog",
      "url": "https://myblog.example.com",
      "status": "connected"
    }
  }
}
```

### A more complex heredoc

```bash
mainwpctl abilities run update-site-plugins-v1 --input - --confirm --force <<'EOF'
{
  "site_id_or_domain": 5,
  "plugins": ["akismet", "wordfence"]
}
EOF
```

This sends a multi-line JSON object with a site ID and a list of plugins to update. The heredoc makes it easy to see the structure of the JSON, compared to cramming it all on one line.

### Why use single quotes around EOF?

This is an important detail. There are two ways to start a heredoc:

- `<<'EOF'` (with single quotes): the text is sent **literally**. Characters like `$` are treated as plain text.
- `<<EOF` (without quotes): the shell **expands variables**. A `$` character triggers variable expansion.

For JSON, **always use `<<'EOF'` (with single quotes)**. Here is why:

```bash
# With quotes - CORRECT for JSON
mainwpctl abilities run get-site-v1 --input - --json <<'EOF'
{"site_id_or_domain": 5}
EOF
# mainwpctl receives: {"site_id_or_domain": 5}

# Without quotes - DANGEROUS for JSON
mainwpctl abilities run get-site-v1 --input - --json <<EOF
{"site_id_or_domain": 5}
EOF
# If there were a $variable in the JSON, the shell would try to expand it
# and your JSON would be silently corrupted
```

Since JSON never uses shell variables, always quote the marker to prevent accidental expansion.

---

## When to Use Each Method

| Method | Best for | Example |
|--------|----------|---------|
| `--input '...'` | Simple, one-line JSON | `--input '{"site_id_or_domain": 5}'` |
| `--input-file` | Reusable parameter files, complex JSON, version-controlled configs | `--input-file deploy-params.json` |
| `--input -` (pipe) | Dynamically generated parameters, chaining commands | `echo '...' \| mainwpctl ... --input -` |
| `--input -` (heredoc) | Multi-line JSON in scripts without creating a file | `<<'EOF' ... EOF` |

**Rules of thumb:**

- If you will use the same parameters more than once, put them in a file (`--input-file`).
- If you are writing a shell script and the JSON is short, use a heredoc.
- If you are generating parameters from another program, use a pipe.
- If the JSON fits comfortably on one line, inline `--input` is fine.

---

## Verifying It Works

All three methods should produce identical output for the same input. Try running all three and comparing:

```bash
# Method 1: inline
mainwpctl abilities run get-site-v1 --input '{"site_id_or_domain": 5}' --json

# Method 2: file
echo '{"site_id_or_domain": 5}' > test-params.json
mainwpctl abilities run get-site-v1 --input-file test-params.json --json

# Method 3: heredoc
mainwpctl abilities run get-site-v1 --input - --json <<'EOF'
{"site_id_or_domain": 5}
EOF
```

All three commands should return the same JSON output. If one produces an error while the others succeed, the problem is in how you wrote or passed the JSON for that method. Check the troubleshooting section below.

You can clean up the test file afterward:

```bash
rm test-params.json
```

---

## Troubleshooting

### JSON syntax errors

**Missing quotes around keys:**

```
Bad:  {site_id: 5}
Good: {"site_id_or_domain": 5}
```

JSON requires double quotes around every key.

**Single quotes instead of double quotes:**

```
Bad:  {'site_id': 5}
Good: {"site_id_or_domain": 5}
```

JSON only allows double quotes. Single quotes are not valid in JSON, even though they work in JavaScript and some other languages.

**Trailing comma after the last item:**

```
Bad:  {"site_id_or_domain": 5, "name": "blog",}
Good: {"site_id_or_domain": 5, "name": "blog"}
```

Remove the comma after the last key-value pair in an object or the last element in an array.

**Tip:** Paste your JSON into an online JSON validator (search "JSON validator" in your browser) to find syntax errors quickly. The validator will point to the exact line and character where the problem is.

### "File not found" with --input-file

- **Use the full (absolute) path** to avoid ambiguity:
  ```bash
  mainwpctl abilities run get-site-v1 --input-file /home/user/params.json --json
  ```
- **Or make sure you are in the right directory.** Run `pwd` to see your current directory, and `ls` to list files in it. The file must be in that directory (or you must specify the path to it).
- **Filenames are case-sensitive on Linux and macOS.** `Params.json` is not the same as `params.json`.

### Stdin not reading (--input -)

- **Make sure the pipe is correct.** The JSON-producing command must come before the `|`:
  ```bash
  echo '{"site_id_or_domain": 5}' | mainwpctl abilities run get-site-v1 --input - --json
  ```
- **If using a heredoc**, make sure the closing `EOF` is on its own line with no leading spaces or tabs. Even one space before `EOF` will cause the shell to miss it:
  ```
  Bad:    EOF       ← spaces before EOF
  Good: EOF         ← starts at column 1
  ```
- **Make sure you wrote `--input -`** (with the dash after a space), not `--input`. The `-` tells MainWP Control to read from stdin.

### "Unexpected token" or parse errors

- This usually means the JSON is malformed. Copy the exact JSON you are passing and paste it into a validator.
- If you are using `<<EOF` (without quotes around EOF), shell variables like `$HOME` or `$PATH` inside your JSON will be expanded by the shell before MainWP Control sees them. This corrupts your JSON. Use `<<'EOF'` (with single quotes) instead.

### Not sure which parameters an ability expects?

Use the `abilities info` command to see the expected input schema for any ability:

```bash
mainwpctl abilities info get-site-v1
```

This shows you which fields are required, which are optional, and what types they expect (string, number, array, etc.). Use this output to build your JSON parameter file.

### Still stuck?

Try running your command with `--debug` for more detailed error output:

```bash
mainwpctl abilities run get-site-v1 --input-file params.json --json --debug
```

The debug output will show you what MainWP Control received as input and where it failed.
