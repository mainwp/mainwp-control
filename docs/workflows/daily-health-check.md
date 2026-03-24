# Daily Health Check

> Automatically check your MainWP sites every day and get a Slack alert when something goes wrong.

Managing a network of WordPress sites means things can break silently. A site goes offline, a connection drops, a server becomes unreachable. This guide walks you through setting up a fully automated daily check that monitors every site connected to your MainWP Dashboard and sends you a Slack notification when something needs attention.

You do not need any prior experience with scripting, cron jobs, or the command line. Every concept is explained before it is used.

---

## What You'll Set Up

By the end of this guide you will have:

- **A bash script** that checks all your MainWP-connected sites for connectivity issues
- **Slack notifications** when any site is disconnected or unreachable
- **A cron job** that runs this check automatically every day

---

## Prerequisites

Before you begin, make sure you have the following:

- **MainWP Dashboard 6 or later**, installed and running on a WordPress site. This is the central hub that manages your connected sites.
- **WordPress admin access** to your Dashboard site. You will need to create an Application Password for CLI authentication.
- **Node.js 20 or later** installed on the machine that will run MainWP Control. This is the machine where the daily health check will execute. It does not need to be the same server as your Dashboard.

---

## Step 1: Create an Application Password

Application Passwords are a WordPress feature that lets external tools (like MainWP Control) authenticate with your site without using your main login credentials. Each Application Password is a separate credential you can revoke independently.

1. Log in to your WordPress Dashboard site as an administrator.
2. Navigate to **Users > Your Profile** (or click your name in the top-right corner and select "Edit Profile").
3. Scroll down to the **Application Passwords** section near the bottom of the page.
4. In the **"New Application Password Name"** field, type a name to identify this credential, for example `mainwpcontrol`.
5. Click **"Add New Application Password"**.
6. WordPress will display a generated password. It looks something like this:

   ```
   AbCD 1234 efGH 5678 ijKL 9012
   ```

7. **Copy this password immediately.** WordPress will not show it again. If you lose it, you will need to create a new one.
8. Store it somewhere secure: a password manager, a CI/CD secret store, or a secure note. You will need it in Step 3.

---

## Step 2: Install MainWP Control

MainWP Control is a command-line tool distributed as an npm package. npm is the package manager that comes bundled with Node.js.

**If you do not have Node.js installed:** Download and install Node.js 20 or later from [https://nodejs.org](https://nodejs.org). The LTS (Long Term Support) version is recommended. The installer includes npm automatically.

### Option A: Install globally (recommended)

A global install makes `mainwpcontrol` available as a command anywhere on your system:

```bash
npm install -g @mainwp/control
```

### Option B: Run without installing (npx)

If you cannot or prefer not to install packages globally, you can use `npx` to run MainWP Control on demand. npx downloads and runs the package temporarily:

```bash
npx --package=@mainwp/control mainwpcontrol
```

### Option C: Install in a project directory

If you are integrating MainWP Control into an existing project:

```bash
npm install @mainwp/control
```

Then run it with `npx mainwpcontrol` from that project directory.

### Verify the installation

Run the following command to confirm MainWP Control is installed and working:

```bash
mainwpcontrol --version
```

Expected output:

```
@mainwp/control/x.y.z darwin-arm64 node-vNN.NN.N
```

You should see `@mainwp/control/` followed by version information. The exact values depend on your system and Node.js version.

---

## Step 3: Authenticate

MainWP Control needs to know which MainWP Dashboard to connect to and how to authenticate. The `login` command walks you through this interactively.

Run:

```bash
mainwpcontrol login
```

You will be prompted for three pieces of information:

1. **Dashboard URL:** The full URL of your MainWP Dashboard site (e.g., `https://manage.example.com`).
2. **Username:** Your WordPress admin username on the Dashboard site.
3. **Application Password:** The password you created in Step 1. Paste it in when prompted. The spaces in the password are fine; include them or omit them, both work.

After entering these, MainWP Control stores your credentials in your system's keychain when one is available (macOS Keychain, Linux secret service, or Windows Credential Manager). If the machine cannot use a keychain, keep `MAINWP_APP_PASSWORD` available in the environment for future runs.

### Verify authentication

Run the built-in diagnostic command:

```bash
mainwpcontrol doctor
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

The key line is `✓ System is ready`. If any check fails, run `mainwpcontrol doctor -v` for details. If authentication fails, double-check your URL, username, and Application Password.

---

## Step 4: Create a Slack Incoming Webhook

A **webhook** is a URL that accepts incoming data. A Slack Incoming Webhook is a special URL that, when you send a JSON message to it, posts that message into a Slack channel. This is how the health check script will alert you.

### Create the webhook

1. Open [https://api.slack.com/messaging/webhooks](https://api.slack.com/messaging/webhooks) in your browser.
2. Click **"Create your Slack app"** (or use an existing Slack app if you have one).
3. Choose **"From scratch"**, give the app a name (e.g., "MainWP Alerts"), and select your Slack workspace.
4. In the app settings, navigate to **Incoming Webhooks** in the left sidebar.
5. Toggle **"Activate Incoming Webhooks"** to **On**.
6. Click **"Add New Webhook to Workspace"**.
7. Select the Slack channel where you want health check alerts to appear (e.g., `#ops-alerts` or `#mainwp`).
8. Click **"Allow"**.
9. Slack will generate a webhook URL. It looks like this:

   ```
   https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX
   ```

10. **Copy this URL.** You will need it in Step 5.

### Test the webhook

Before writing the script, confirm the webhook works by sending a test message. Open your terminal and run:

```bash
curl -X POST -H 'Content-Type: application/json' \
  -d '{"text":"Test from mainwpcontrol setup"}' \
  'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
```

Replace `https://hooks.slack.com/services/YOUR/WEBHOOK/URL` with your actual webhook URL.

Expected result in your terminal:

```
ok
```

Expected result in Slack: A message reading "Test from mainwpcontrol setup" appears in the channel you selected.

If you see an error or the message does not appear, double-check that you copied the full webhook URL and that the Slack app is still active.

---

## Step 5: Write the Health Check Script

A **bash script** is a plain text file containing a sequence of commands that your computer executes one after another. Instead of typing commands manually each time, you write them in a file and run that file.

We will build the script step by step, adding one capability at a time. Create a new file called `mainwp-health-check.sh` in a location you will remember. Your home directory or a scripts folder works well.

You can create the file using any text editor. If you are unsure, use `nano` in your terminal:

```bash
nano mainwp-health-check.sh
```

### 5a: Start with the basic command

Enter the following content:

```bash
#!/bin/bash
# mainwp-health-check.sh - Check MainWP site connectivity

RESULT=$(mainwpcontrol abilities run list-sites-v1 --json 2>/dev/null)
echo "$RESULT"
```

Here is what each line does:

- `#!/bin/bash`: This is called a **shebang**. It tells your operating system which program to use to run this script. `/bin/bash` is the Bash shell, which is available on macOS and virtually all Linux systems.
- `# mainwp-health-check.sh ...`: Lines starting with `#` are **comments**. They are ignored when the script runs and exist only to help humans understand the code.
- `RESULT=$(mainwpcontrol abilities run list-sites-v1 --json 2>/dev/null)`: This runs the MainWP Control command that lists all sites, captures its output into a **variable** called `RESULT`. The `--json` flag tells MainWP Control to output structured JSON data instead of human-readable text. The `2>/dev/null` part hides any warning messages so only the JSON output is captured.
- `echo "$RESULT"`: This prints the captured output to the terminal so you can see it.

Save the file (in nano: press `Ctrl+O`, then `Enter`, then `Ctrl+X` to exit).

Make the script executable and run it:

```bash
chmod +x mainwp-health-check.sh
./mainwp-health-check.sh
```

Expected output (abbreviated):

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/list-sites-v1",
    "success": true,
    "data": {
      "items": [
        {
          "id": 1,
          "name": "Client Site A",
          "url": "https://clienta.example.com",
          "status": "connected"
        },
        {
          "id": 2,
          "name": "Client Site B",
          "url": "https://clientb.example.com",
          "status": "connected"
        }
      ]
    }
  }
}
```

The exact sites and details will match your MainWP Dashboard. The important thing is that you see JSON output with site data.

### 5b: Add exit code checking

An **exit code** is a number that every command returns when it finishes. An exit code of `0` means success. Any other number means something went wrong. The variable `$?` contains the exit code of the most recently run command.

Update your script to check whether the mainwpcontrol command succeeded:

```bash
#!/bin/bash
# mainwp-health-check.sh - Check MainWP site connectivity

RESULT=$(mainwpcontrol abilities run list-sites-v1 --json 2>/dev/null)
EXIT=$?

if [ $EXIT -ne 0 ]; then
  echo "Health check command failed with exit code $EXIT"
  exit 1
fi

echo "Command succeeded. Site data retrieved."
```

New lines explained:

- `EXIT=$?`: Captures the exit code of the mainwpcontrol command into a variable called `EXIT`.
- `if [ $EXIT -ne 0 ]; then`: This is a **conditional**. `-ne` means "not equal to". So this reads: "if the exit code is not equal to zero, then..."
- `echo "Health check command failed with exit code $EXIT"`: Prints an error message that includes the actual exit code.
- `exit 1`: Stops the script immediately and reports failure (exit code 1).
- `fi`: Marks the end of the `if` block.

Save and run:

```bash
./mainwp-health-check.sh
```

Expected output if everything is working:

```
Command succeeded. Site data retrieved.
```

If your Dashboard is unreachable or credentials are invalid, you will see:

```
Health check command failed with exit code 3
```

### 5c: Parse with jq

The JSON output from MainWP Control contains structured data, but we need to extract specific information from it, namely how many sites are not connected. For this we use **jq**, a command-line tool designed for reading and filtering JSON data.

**Install jq** if you do not already have it:

- **macOS (Homebrew):** `brew install jq`
- **Ubuntu / Debian:** `sudo apt-get install jq`
- **Other systems:** See [https://jqlang.github.io/jq/download/](https://jqlang.github.io/jq/download/)

Verify jq is installed:

```bash
jq --version
```

Expected output:

```
jq-1.7.1
```

The version number may vary. Any version will work for our purposes.

Now update the script to count disconnected sites:

```bash
#!/bin/bash
# mainwp-health-check.sh - Check MainWP site connectivity

RESULT=$(mainwpcontrol abilities run list-sites-v1 --json 2>/dev/null)
EXIT=$?

if [ $EXIT -ne 0 ]; then
  echo "Health check command failed (exit $EXIT)"
  exit 1
fi

DISCONNECTED=$(echo "$RESULT" | jq '[.data.data.items[] | select(.status != "connected")] | length')
echo "$DISCONNECTED site(s) disconnected"
```

The new jq line explained:

- `echo "$RESULT"`: Sends the JSON output to jq.
- `|`: This is a **pipe**. It takes the output of the command on the left and feeds it as input to the command on the right.
- `.data.data.items[]`: Navigates into the JSON. Start at the root, go into the outer `data` object, then the inner `data` object, then `items`, and iterate over every item in the array.
- `select(.status != "connected")`: Keeps only the sites whose `status` field is not `"connected"`.
- `[...] | length`: Wraps the filtered results in an array and counts how many items are in it.
- The final result is a single number: the count of disconnected sites.

Save and run:

```bash
./mainwp-health-check.sh
```

Expected output if all sites are connected:

```
0 site(s) disconnected
```

If two sites are disconnected:

```
2 site(s) disconnected
```

### 5d: Add Slack alerting

Now we bring it all together. When the health check fails or finds disconnected sites, the script sends an alert to Slack. Update your script to the final version:

```bash
#!/bin/bash
# mainwp-health-check.sh - Daily MainWP site connectivity check
# Sends a Slack alert if any sites are disconnected or if the check itself fails.

SLACK_WEBHOOK_URL="https://hooks.slack.com/services/YOUR/WEBHOOK/URL"

# Run the health check
RESULT=$(mainwpcontrol abilities run list-sites-v1 --json 2>/dev/null)
EXIT=$?

# Alert if the command itself failed
if [ $EXIT -ne 0 ]; then
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"⚠️ MainWP health check failed (exit code $EXIT)\"}" \
    "$SLACK_WEBHOOK_URL"
  exit 1
fi

# Count disconnected sites
DISCONNECTED=$(echo "$RESULT" | jq '[.data.data.items[] | select(.status != "connected")] | length')

if [ "$DISCONNECTED" -gt 0 ]; then
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"⚠️ $DISCONNECTED MainWP site(s) disconnected\"}" \
    "$SLACK_WEBHOOK_URL"
fi
```

**Replace** `https://hooks.slack.com/services/YOUR/WEBHOOK/URL` with the actual Slack webhook URL you created in Step 4.

What changed:

- `SLACK_WEBHOOK_URL="..."`: Stores the webhook URL in a variable so it is easy to find and change.
- The first `curl` block runs when the MainWP Control command itself fails (network issue, auth failure, etc.). It sends a Slack message with the exit code and then stops the script.
- The second `curl` block runs when disconnected sites are detected. `-gt 0` means "greater than zero". If the disconnected count is more than zero, it sends an alert.
- `curl -s`: The `-s` flag means "silent." It suppresses progress output from curl so it does not clutter logs.
- The `\` at the end of a line means the command continues on the next line. This is for readability.
- If all sites are connected, the script finishes without sending any Slack message. No news is good news.

---

## Step 6: Make the Script Executable

If you have not already done so in Step 5a, you need to mark the script as executable. **File permissions** control who can read, write, and execute a file. By default, new files are not executable.

Run:

```bash
chmod +x mainwp-health-check.sh
```

`chmod` stands for "change mode" and `+x` adds execute permission. You only need to run this once.

---

## Step 7: Test the Script Manually

Run the script:

```bash
./mainwp-health-check.sh
```

The `./` prefix tells your shell to run the script in the current directory.

**Expected results:**

- If all sites are connected: the script exits silently with no output and no Slack message.
- If any sites are disconnected: a Slack alert appears in your channel with the count.
- If the MainWP Control command fails: a Slack alert appears reporting the failure and exit code.

**To force a test alert** (useful to confirm Slack notifications are working), temporarily edit the script and change this line:

```bash
if [ "$DISCONNECTED" -gt 0 ]; then
```

to:

```bash
if [ "$DISCONNECTED" -eq 0 ]; then
```

This inverts the condition: it alerts when zero sites are disconnected (which is the normal state). Run the script, confirm the Slack message arrives, then change the condition back to `-gt 0`.

---

## Step 8: Schedule with Cron

**Cron** is a built-in job scheduler available on macOS and Linux. It runs commands automatically on a schedule: every minute, every hour, every day, or on any pattern you define. Each scheduled task is called a **cron job**.

### Open the crontab

The **crontab** (cron table) is a file that lists all your scheduled jobs. Open it for editing:

```bash
crontab -e
```

This opens the crontab file in your default terminal text editor (usually `vi` or `nano`). If you see `vi` and are unfamiliar with it, you can switch to nano by running `EDITOR=nano crontab -e` instead.

### Understand cron syntax

Each line in a crontab defines one scheduled job using this format:

```
minute  hour  day-of-month  month  day-of-week  command
```

| Field         | Values  | Meaning                          |
|---------------|---------|----------------------------------|
| minute        | 0-59    | Minute of the hour               |
| hour          | 0-23    | Hour of the day (24-hour format) |
| day-of-month  | 1-31    | Day of the month                 |
| month         | 1-12    | Month of the year                |
| day-of-week   | 0-6     | Day of the week (0 = Sunday)     |

An asterisk (`*`) means "every," so `* * * * *` means every minute of every hour of every day.

### Add the daily job

Add this line to schedule the health check to run every day at 7:00 AM:

```
0 7 * * * /full/path/to/mainwp-health-check.sh
```

**Important:** Replace `/full/path/to/mainwp-health-check.sh` with the actual full path to your script. Cron does not know about your home directory shortcuts. To find the full path, run:

```bash
realpath mainwp-health-check.sh
```

For example, if the script is in your home directory, the line might be:

```
0 7 * * * /Users/yourname/mainwp-health-check.sh
```

**Note on PATH:** Cron runs in a minimal environment. It does not load your shell profile, so commands like `mainwpcontrol` or `jq` may not be found by their short names. If you encounter issues, add a `PATH` line at the top of your crontab:

```
PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin
0 7 * * * /full/path/to/mainwp-health-check.sh
```

This tells cron where to look for programs. The `/opt/homebrew/bin` entry is for macOS with Homebrew on Apple Silicon.

### Save and exit

- In **nano**: Press `Ctrl+O`, then `Enter` to save, then `Ctrl+X` to exit.
- In **vi**: Press `Esc`, type `:wq`, then press `Enter`.

### Verify the cron job is saved

```bash
crontab -l
```

Expected output:

```
0 7 * * * /Users/yourname/mainwp-health-check.sh
```

Your cron job is now active. It will run every day at 7:00 AM local time.

---

## Verifying It Works

Run through this checklist to make sure everything is connected:

1. **Run the script manually:**

   ```bash
   ./mainwp-health-check.sh
   ```

   If any sites are disconnected, you should see a Slack alert within a few seconds.

2. **Force a test alert** by temporarily inverting the condition (as described in Step 7) to confirm Slack notifications arrive.

3. **Confirm cron is scheduled:**

   ```bash
   crontab -l
   ```

   You should see your health check entry.

4. **Wait for the next scheduled run** (or temporarily set the cron to run in a few minutes for testing, e.g., `45 14 * * *` for 2:45 PM) and verify the Slack message (or silence, if all sites are healthy).

---

## Troubleshooting

### jq: command not found

jq is not installed on your system. Install it:

- **macOS (Homebrew):** `brew install jq`
- **Ubuntu / Debian:** `sudo apt-get install jq`
- **Other systems:** See [https://jqlang.github.io/jq/download/](https://jqlang.github.io/jq/download/)

### Slack message not appearing

- **Verify the webhook URL** is correct by testing it directly with curl:

  ```bash
  curl -X POST -H 'Content-Type: application/json' \
    -d '{"text":"Webhook test"}' \
    'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
  ```

  You should see `ok` in the terminal and a message in Slack.

- **Check the channel.** Each webhook is tied to a specific Slack channel. Make sure you are looking in the right one.
- **Ensure the Slack app is still active.** If someone disabled or deleted the app, the webhook will stop working. Check your Slack app settings at [https://api.slack.com/apps](https://api.slack.com/apps).

### Cron job not running

- **Check the cron log:**
  - On Linux: `grep CRON /var/log/syslog`
  - On macOS: `log show --predicate 'process == "cron"' --last 1h`

- **Make sure you used full paths** for both the script and any commands inside it (mainwpcontrol, jq, curl). Cron does not load your shell profile, so it may not find programs by their short names. Adding a `PATH` line to the top of your crontab (as shown in Step 8) usually resolves this.

- **On macOS**, you may need to grant Terminal (or your terminal app) **Full Disk Access** in **System Settings > Privacy & Security > Full Disk Access**. Without this, cron may be silently blocked from running scripts.

### Permission denied when running the script

Run the following to make the script executable:

```bash
chmod +x mainwp-health-check.sh
```

If MainWP Control itself fails with a permission error, check that your authentication is still valid:

```bash
mainwpcontrol doctor -v
```

If the doctor command reports authentication issues, run `mainwpcontrol login` again.

### Authentication errors in cron

Cron runs in a minimal environment and may not have access to your system keychain where MainWP Control stores credentials. If the health check works when you run it manually but fails from cron, you can set the credentials as environment variables directly in your crontab:

```
MAINWP_APP_PASSWORD=your-app-password
0 7 * * * /full/path/to/mainwp-health-check.sh
```

Replace `your-app-password` with the Application Password from Step 1 (spaces removed). Environment variables set at the top of the crontab apply to all jobs below them.
