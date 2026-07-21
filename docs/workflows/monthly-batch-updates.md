# Monthly Batch Updates

> Safely preview and apply WordPress core, plugin, and theme updates across all your MainWP sites, either from a script or through GitHub Actions.

This guide covers two ways to automate monthly updates for every WordPress site connected to your MainWP Dashboard:

- **Option A:** A bash script you run manually or schedule with cron
- **Option B:** A GitHub Actions workflow that runs automatically on the 1st of each month

Both options follow the same pattern: preview what will change, apply the updates, and verify the result. You only need to pick one, but the guide builds the concepts incrementally so Option B builds on what you learn in Option A.

**Already using MainWP Control?** If `mainwpcontrol doctor` shows "System is ready", skip to [Understanding the Safety Model](#understanding-the-safety-model).

---

## What You'll Set Up

- A script that previews pending updates, applies them, and verifies the result
- An understanding of MainWP Control's safety model: the dry-run / confirm pattern that prevents accidental changes
- (Optional) A GitHub Actions workflow that runs this automatically on the 1st of each month

---

## Prerequisites

Before starting, make sure you have:

- **MainWP Dashboard 6 or later**, installed and running on a WordPress site you control. This is the central management hub that connects to your WordPress sites.
- **WordPress admin access** to the site where MainWP Dashboard is installed. You will need to create an Application Password for CLI authentication.
- **Node.js 20 or later** on the machine where you will run MainWP Control. You can check your version with `node --version`. If you do not have Node.js, download it from [nodejs.org](https://nodejs.org).
- **(For GitHub Actions only)** A GitHub repository where you can add a workflow file and secrets.

---

## Step 1: Create an Application Password

MainWP Control authenticates with your MainWP Dashboard using a WordPress Application Password. This is a built-in WordPress feature (no extra plugins needed) that generates a separate password for API access, so you never expose your main login credentials.

To create one:

1. Log in to the WordPress site where MainWP Dashboard is installed.
2. Go to **Users** in the left sidebar, then click on your own user profile (or go to **Users > Your Profile**).
3. Scroll down to the **Application Passwords** section near the bottom of the page.
4. In the **New Application Password Name** field, type a descriptive name like `mainwpcontrol`.
5. Click **Add New Application Password**.
6. WordPress will display the generated password. It looks something like this:

   ```
   AbCD 1234 efGH 5678 ijKL 9012
   ```

7. **Copy this password immediately.** WordPress will not show it again. If you lose it, you will need to revoke it and create a new one.
8. Store the password securely: in a password manager, as a CI/CD secret, or in an encrypted note. Do not paste it into files that are committed to version control.

---

## Step 2: Install MainWP Control

Install MainWP Control globally using npm (the Node.js package manager that comes with Node.js):

```bash
npm install -g @mainwp/control
```

This makes the `mainwpcontrol` command available anywhere on your system.

If you prefer not to install globally, you can use `npx` to run it without a permanent install:

```bash
npx --package=@mainwp/control mainwpcontrol --version
```

`npx` downloads and runs the package on the fly, which is useful for one-off testing. For scripting and automation, the global install is more convenient.

Verify the installation:

```bash
mainwpcontrol --version
```

Expected output:

```
@mainwp/control/x.y.z
```

You should see `@mainwp/control/` followed by a version number. As long as the output starts with `@mainwp/control/`, the installation is working.

If you see `command not found`, make sure Node.js 20+ is installed and that your system PATH includes the npm global bin directory. Run `npm config get prefix` to find where npm installs global packages.

---

## Step 3: Authenticate

Run the interactive login command:

```bash
mainwpcontrol login
```

MainWP Control will prompt you for three pieces of information:

1. **Dashboard URL:** The full URL of your MainWP Dashboard site (e.g., `https://dashboard.example.com`). Include the `https://` prefix.
2. **Username:** Your WordPress admin username on that site.
3. **Application Password:** The password you created in Step 1.

After entering your credentials, MainWP Control stores them in a local profile so you do not need to re-enter them each time. If the machine cannot use the OS keychain, keep `MAINWP_APP_PASSWORD` available in the environment for future runs.

Verify that authentication is working:

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

The key line is `✓ System is ready`. If any check fails, run `mainwpcontrol doctor -v` for details. If authentication fails, double-check your Dashboard URL, username, and Application Password.

---

## Understanding the Safety Model

Before writing any scripts, it is important to understand how MainWP Control prevents accidental changes. Every operation that modifies your sites uses a two-step pattern: **preview first, then execute**.

MainWP Control enforces this through four flags:

- **`--dry-run`:** Asks MainWP to show you what *would* happen, without making any changes. Think of it as a preview. `--dry-run` makes no changes on any site, so you can repeat it freely while you refine your filters.

- **`--confirm`:** Tells MainWP to go ahead and execute the operation for real. This is required for any operation that changes something (applying updates, deleting plugins, etc.). Without `--confirm`, the command will only show you what it would do.

- **`--force`:** Skips the interactive "Are you sure?" prompt that MainWP Control normally shows before destructive operations. This is necessary in scripts and CI/CD pipelines where there is no human to type "yes." It does not bypass the preview/confirm model. It only skips the interactive prompt.

- **`--wait`:** Keeps the command running until the batch operation finishes on the server. Without this flag, the command returns immediately with a job ID, and the updates continue in the background. With `--wait`, the command blocks until all updates are complete and then returns the final result.

**Important:** `--dry-run` and `--confirm` are mutually exclusive. You cannot preview and execute at the same time. If you pass both, MainWP Control will return an error. This is intentional. It forces you to make the preview and execution separate, deliberate steps.

The typical flow in any script is:

1. List what is pending (e.g., `list-updates-v1`) to see what would change
2. Check the results
3. Run with `--confirm` to apply the changes (e.g., `run-updates-v1`)
4. Verify the result

> **Note:** Some destructive abilities (like `delete-site-v1`) support `--dry-run` for a server-side preview. For updates, use `list-updates-v1` to preview what is pending before applying with `run-updates-v1`.

---

## Before You Automate

Once you schedule `--confirm --force`, updates apply without anyone watching. Before you turn on either option below, make sure:

- **Backups are current for every site in scope.** Use the MainWP Backups extension or your host's backup tool, and confirm a recent, restorable backup exists before the first automated run.
- **You've run a canary first.** Run the workflow against one or two low-risk sites before widening it to your full network. `run-updates-v1` accepts a `site_ids_or_domains` input that limits its scope, so a canary run looks like `mainwpcontrol abilities run run-updates-v1 --input '{"site_ids_or_domains": [12, 34]}' --confirm --force --wait --json` with your low-risk site IDs (or domains). Only expand once a full cycle has run clean.
- **You know your rollback path.** If an update breaks a site, you need a way back: restoring from backup, or rolling back the specific plugin or theme version. Confirm this actually works before you rely on it.
- **The confirmed run lands inside a maintenance window you can monitor.** Even with `--wait`, something can go wrong. Schedule the `--confirm` run for a time when you, or someone, can check the result and react.

Both Option A and Option B below assume these are in place.

---

> **Windows users:** Option A builds a bash script with cron, which needs macOS or Linux. If you're on Windows, skip to **Option B: GitHub Actions**. It runs on Linux in the cloud and works regardless of your local OS.

## Option A: Scripted Updates

This section builds a bash script step by step. Each step introduces one concept, shows the command, and explains the output. At the end, everything is combined into a complete script.

### Step 4: Check for Pending Updates

Start by asking MainWP what updates are available across all your connected sites:

```bash
mainwpcontrol abilities run list-updates-v1 --json
```

Breaking this command down:

- `abilities run`: Tells MainWP Control to execute a MainWP ability (an action the API can perform).
- `list-updates-v1`: The specific ability to run. This one lists all pending updates across your network.
- `--json`: Outputs the result as JSON instead of a human-readable table. This makes the output easy to parse in scripts.

Expected output (abbreviated):

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/list-updates-v1",
    "success": true,
    "data": {
      "total": 12,
      "summary": {
        "core": 2,
        "plugins": 8,
        "themes": 2,
        "translations": 0,
        "total": 12
      },
      "updates": [
        {
          "site_id": 1,
          "site_name": "Client Site A",
          "type": "plugin",
          "slug": "woocommerce",
          "name": "WooCommerce",
          "current_version": "8.5.1",
          "new_version": "8.6.0"
        }
      ]
    }
  }
}
```

The `data.data.total` field tells you how many updates are pending (the inner `data` contains the API response). The `summary` object breaks this down by type: core, plugins, themes, and translations. The `updates` array lists each individual update with the site, plugin/theme name, and version information.

### Step 5: Preview Pending Updates

Now check what updates are available. `list-updates-v1` is a read-only ability. It shows you what is pending without changing anything:

```bash
PREVIEW=$(mainwpcontrol abilities run list-updates-v1 --json)
echo "$PREVIEW"
```

The first line runs the command and stores its output in a variable called `PREVIEW`. A variable in bash is a named container that holds a value. Here it holds the JSON output so you can use it again without re-running the command. The second line prints the stored output to your terminal.

Expected output (abbreviated):

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/list-updates-v1",
    "success": true,
    "data": {
      "total": 12,
      "summary": {
        "core": 2,
        "plugins": 8,
        "themes": 2,
        "translations": 0,
        "total": 12
      },
      "updates": [
        {
          "site_id": 1,
          "site_name": "Client Site A",
          "type": "plugin",
          "slug": "woocommerce",
          "name": "WooCommerce",
          "current_version": "8.5.1",
          "new_version": "8.6.0"
        }
      ]
    }
  }
}
```

This tells you exactly what updates are pending: which sites, which plugins/themes/core versions, and what version they will move to. Nothing has been changed.

Next, extract the update count using `jq`. `jq` is a command-line tool for reading and manipulating JSON data. If you do not have it installed, you can install it with `brew install jq` on macOS or `sudo apt-get install jq` on Ubuntu/Debian:

```bash
PREVIEW=$(mainwpcontrol abilities run list-updates-v1 --json)
UPDATE_COUNT=$(echo "$PREVIEW" | jq '.data.data.total // 0')
echo "$UPDATE_COUNT updates pending"
```

The `jq '.data.data.total // 0'` part reads the `total` field from inside the inner `data` object in the JSON. The `// 0` means "if that field does not exist or is null, use 0 instead." This prevents the script from breaking if the response format is unexpected.

Expected output:

```
12 updates pending
```

### Step 6: Apply Updates

When you are satisfied with the preview, apply the updates for real. The prerequisites above apply here: confirm backups are current and run against your canary sites before pointing this at your full network.

```bash
mainwpcontrol abilities run run-updates-v1 --confirm --force --wait --json
```

Here is what each flag does in this context:

- `--confirm`: "Yes, apply these updates for real." This is the flag that transitions from preview to execution.
- `--force`: Skip the interactive "Are you sure?" prompt. In a script, there is no human to respond to the prompt, so this flag is required.
- `--wait`: Block and wait until all updates have finished applying across all sites. Without this, the command would return immediately with a job ID while updates continue in the background. With `--wait`, the command stays running and gives you the final result when everything is done.
- `--json`: Output the result as JSON for easy parsing.

Expected output (abbreviated):

```json
{
  "success": true,
  "data": {
    "mode": "execute",
    "ability": "mainwp/run-updates-v1",
    "success": true,
    "data": {
      "total": 12,
      "succeeded": 11,
      "failed": 1,
      "results": [
        {
          "site": "Client Site A",
          "type": "plugin",
          "name": "WooCommerce",
          "status": "updated",
          "version": "8.6.0"
        }
      ]
    }
  }
}
```

The output shows how many updates succeeded and how many failed, along with per-update details.

### Step 7: Verify No Updates Remain

After applying updates, check that nothing is left pending:

```bash
REMAINING=$(mainwpcontrol abilities run list-updates-v1 --json | jq '.data.data.total // 0')
echo "$REMAINING updates remaining after run"
```

The `|` character (called a "pipe") takes the output of the command on its left and feeds it as input to the command on its right. So this runs `list-updates-v1`, takes the JSON output, and passes it to `jq` to extract the total count.

Expected output:

```
0 updates remaining after run
```

If the number is not zero, some updates may have failed, or new updates appeared while the previous batch was running. This is not necessarily a problem. The Troubleshooting section at the end covers this scenario.

### Complete Script

Here is everything combined into a single script with error handling. This is the script you'll schedule with cron, so make sure the [prerequisites above](#before-you-automate) are in place before you rely on it. Create a file called `monthly-updates.sh`:

```bash
#!/bin/bash
set -e

# set -e tells bash to stop immediately if any command fails (returns a
# non-zero exit code). This prevents the script from continuing after an
# error and potentially making things worse.

# Step 1: Preview what will be updated (nothing changes yet)
echo "Previewing pending updates..."
PREVIEW=$(mainwpcontrol abilities run list-updates-v1 --json)

# Step 2: Check how many updates are pending
UPDATE_COUNT=$(echo "$PREVIEW" | jq '.data.data.total // 0')
echo "$UPDATE_COUNT updates pending"

if [ "$UPDATE_COUNT" -eq 0 ]; then
  echo "Nothing to update"
  exit 0
fi

# Step 3: Apply updates and wait for them to finish
echo "Applying $UPDATE_COUNT updates..."
mainwpcontrol abilities run run-updates-v1 --confirm --force --wait --json

# Step 4: Verify no updates remain
REMAINING=$(mainwpcontrol abilities run list-updates-v1 --json | jq '.data.data.total // 0')
echo "$REMAINING updates remaining after run"
```

The script follows the same four-step flow you built piece by piece:

1. **Preview:** List pending updates to see what would change
2. **Check count:** Extract the number of pending updates; exit early if there are none
3. **Apply:** Run with `--confirm --force --wait` to apply all updates and wait for completion
4. **Verify:** List updates again to confirm everything was applied

Make the script executable (this tells your operating system the file can be run as a program):

```bash
chmod +x monthly-updates.sh
```

Test it:

```bash
./monthly-updates.sh
```

Expected output when updates are available:

```
Previewing pending updates...
12 updates pending
Applying 12 updates...
0 updates remaining after run
```

Expected output when no updates are pending:

```
Previewing pending updates...
0 updates pending
Nothing to update
```

### Scheduling with Cron

To run this script automatically on the 1st of every month, you can use cron, a built-in scheduling tool on macOS and Linux. Open your cron configuration:

```bash
crontab -e
```

This opens a text editor. Add the following line at the bottom:

```
0 6 1 * * /full/path/to/monthly-updates.sh
```

Replace `/full/path/to/monthly-updates.sh` with the actual absolute path to your script. For example: `/Users/yourname/scripts/monthly-updates.sh`.

The five fields in the cron expression mean:

| Field | Value | Meaning |
|-------|-------|---------|
| Minute | `0` | At minute 0 |
| Hour | `6` | At 6:00 AM |
| Day of month | `1` | On the 1st |
| Month | `*` | Every month |
| Day of week | `*` | Any day of the week |

So `0 6 1 * *` means: "At 6:00 AM on the 1st day of every month."

Save and close the editor. The cron job is now active. You can verify it was saved with:

```bash
crontab -l
```

---

## Option B: GitHub Actions

GitHub Actions lets you run scripts automatically in the cloud. This is useful if you want your monthly updates to run without relying on a specific computer being turned on and connected to the internet.

If you are already comfortable with the bash script from Option A, this section reuses the same logic in a GitHub Actions workflow file.

### Step 8: Add Secrets to Your GitHub Repository

GitHub secrets are encrypted values stored in your repository settings. They are injected into workflow runs as environment variables, so you never have to put credentials in code.

1. Go to your GitHub repository in a web browser.
2. Click **Settings** (in the top navigation bar of the repository, not your account settings).
3. In the left sidebar, click **Secrets and variables**, then click **Actions**.
4. Click **New repository secret** and add each of these three secrets one at a time:

   | Secret name | Value | Example |
   |-------------|-------|---------|
   | `DASHBOARD_URL` | Your MainWP Dashboard URL | `https://dashboard.example.com` |
   | `DASHBOARD_USER` | Your WordPress admin username | `admin` |
   | `MAINWP_APP_PASSWORD` | The Application Password from Step 1 | `AbCD 1234 efGH 5678 ijKL 9012` |

For each one, type the name in the **Name** field, paste the value in the **Secret** field, and click **Add secret**. Once saved, the value is encrypted and cannot be viewed again, only updated or deleted.

### Step 9: Create the Workflow File

GitHub Actions workflows are defined in YAML files inside the `.github/workflows/` directory of your repository. This section builds the workflow file piece by piece, then shows the complete file at the end.

**Create the file** at `.github/workflows/monthly-updates.yml` in your repository.

#### Trigger Section

```yaml
name: Monthly Batch Updates

on:
  schedule:
    - cron: '0 6 1 * *'
  workflow_dispatch:
```

- `name`: A human-readable name that appears in the GitHub Actions tab.
- `schedule`: Runs the workflow on a cron schedule. The cron syntax `'0 6 1 * *'` means "6:00 AM UTC on the 1st of each month," the same schedule used in the bash cron example.
- `workflow_dispatch`: Adds a "Run workflow" button in the GitHub Actions tab so you can trigger it manually at any time. Essential for testing.

#### Job Setup

```yaml
jobs:
  update:
    runs-on: ubuntu-latest
    env:
      DASHBOARD_URL: ${{ secrets.DASHBOARD_URL }}
      DASHBOARD_USER: ${{ secrets.DASHBOARD_USER }}
      MAINWP_APP_PASSWORD: ${{ secrets.MAINWP_APP_PASSWORD }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install -g @mainwp/control
```

- `jobs`: Defines the work to do. Each job runs on a fresh virtual machine.
- `runs-on: ubuntu-latest`: Uses the latest Ubuntu Linux runner provided by GitHub.
- `actions/setup-node@v4`: A pre-built action that installs Node.js. We specify version 20 to match MainWP Control's requirements.
- `npm install -g @mainwp/control`: Installs MainWP Control globally on the runner, the same way you did on your own machine in Step 2.

#### Authentication

```yaml
      - name: Login
        run: >
          mainwpcontrol login
          --url $DASHBOARD_URL
          --username $DASHBOARD_USER
```

- `env`: Sets job-level environment variables so every `mainwpcontrol` step can authenticate. GitHub runners often do not persist credentials in an OS keychain between steps, so `MAINWP_APP_PASSWORD` must stay available for the whole job.
- `${{ secrets.DASHBOARD_URL }}`: GitHub replaces this with the encrypted secret value at runtime. The actual value never appears in logs.
- The `>` after `run:` is YAML syntax for a folded string. It joins the following indented lines into a single command, which makes long commands easier to read.

#### Preview Step

```yaml
      - name: Preview updates
        id: preview
        run: |
          PREVIEW=$(mainwpcontrol abilities run list-updates-v1 --json)
          COUNT=$(echo "$PREVIEW" | jq '.data.data.total // 0')
          echo "count=$COUNT" >> "$GITHUB_OUTPUT"
          echo "### Preview: $COUNT updates pending" >> "$GITHUB_STEP_SUMMARY"
```

- `id: preview`: Gives this step a name so other steps can reference its outputs.
- `$GITHUB_OUTPUT`: A special file provided by GitHub Actions. Writing `key=value` to it makes the value available to later steps via `steps.preview.outputs.key`. Here, we write the update count so the next step can decide whether to proceed.
- `$GITHUB_STEP_SUMMARY`: Another special file. Text written here (in Markdown format) appears as a summary on the workflow run page, making it easy to see results at a glance without digging through logs.

#### Apply Step (Conditional)

The prerequisites above apply here too: confirm backups are current and run this workflow against your canary sites before scheduling it against your full network.

```yaml
      - name: Apply updates
        if: steps.preview.outputs.count != '0'
        run: >
          mainwpcontrol abilities run run-updates-v1
          --confirm --force --wait --json
```

- `if:`: Makes this step conditional. It only runs when the preview step found updates to apply. If the count is `0`, this step is skipped entirely, and you will see it greyed out in the workflow log.
- The flags are the same as in the bash script: `--confirm` to execute for real, `--force` to skip the interactive prompt, `--wait` to block until done, and `--json` for machine-readable output.

#### Verify Step

```yaml
      - name: Verify
        if: steps.preview.outputs.count != '0'
        run: |
          REMAINING=$(mainwpcontrol abilities run list-updates-v1 --json | jq '.data.data.total // 0')
          echo "### $REMAINING updates remaining after run" >> "$GITHUB_STEP_SUMMARY"
```

This step also only runs when there were updates to apply. It checks how many updates remain and writes the result to the workflow summary.

#### Complete Workflow File

Here is the full `.github/workflows/monthly-updates.yml` file with all sections assembled:

```yaml
name: Monthly Batch Updates

on:
  schedule:
    - cron: '0 6 1 * *'
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    env:
      DASHBOARD_URL: ${{ secrets.DASHBOARD_URL }}
      DASHBOARD_USER: ${{ secrets.DASHBOARD_USER }}
      MAINWP_APP_PASSWORD: ${{ secrets.MAINWP_APP_PASSWORD }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - run: npm install -g @mainwp/control

      - name: Login
        run: >
          mainwpcontrol login
          --url $DASHBOARD_URL
          --username $DASHBOARD_USER

      - name: Preview updates
        id: preview
        run: |
          PREVIEW=$(mainwpcontrol abilities run list-updates-v1 --json)
          COUNT=$(echo "$PREVIEW" | jq '.data.data.total // 0')
          echo "count=$COUNT" >> "$GITHUB_OUTPUT"
          echo "### Preview: $COUNT updates pending" >> "$GITHUB_STEP_SUMMARY"

      - name: Apply updates
        if: steps.preview.outputs.count != '0'
        run: >
          mainwpcontrol abilities run run-updates-v1
          --confirm --force --wait --json

      - name: Verify
        if: steps.preview.outputs.count != '0'
        run: |
          REMAINING=$(mainwpcontrol abilities run list-updates-v1 --json | jq '.data.data.total // 0')
          echo "### $REMAINING updates remaining after run" >> "$GITHUB_STEP_SUMMARY"
```

### Step 10: Commit, Push, and Verify

Save the workflow file, then commit and push it to your repository:

```bash
git add .github/workflows/monthly-updates.yml
git commit -m "Add monthly batch updates workflow"
git push
```

To verify it is working:

1. Go to your repository on GitHub.
2. Click the **Actions** tab.
3. You should see **Monthly Batch Updates** in the list of workflows on the left.
4. Click on it, then click **Run workflow** (the button appears because of `workflow_dispatch`).
5. Select the branch and click the green **Run workflow** button.

The workflow will run and you can watch each step execute in real time. When it finishes, click on the run to see the step summary showing how many updates were found and applied.

---

## Verifying It Works

### Scripted Version

Run the script and check the output:

```bash
./monthly-updates.sh
```

- If there are pending updates, you should see the preview count, a message that updates are being applied, and a final count of remaining updates.
- If there are no pending updates, the script should exit cleanly with "Nothing to update."
- If any command fails, `set -e` will stop the script and display the error. Run the failing command individually to investigate.

### GitHub Actions Version

1. Trigger the workflow manually from the **Actions** tab as described in Step 10.
2. Click on the workflow run to see the step-by-step log.
3. Check the **Summary** section at the top of the run page for the update count written by `$GITHUB_STEP_SUMMARY`.
4. Verify that the **Apply updates** step only runs when the preview step found a non-zero count. If there are no updates, this step should appear greyed out with a "skipped" label.

---

## Troubleshooting

### Timeout during `--wait`

The default wait timeout is 300 seconds (5 minutes). For large networks with many sites or many updates, the operation may take longer.

To increase the timeout, add the `--wait-timeout` flag with a value in seconds:

```bash
mainwpcontrol abilities run run-updates-v1 --confirm --force --wait --wait-timeout 600 --json
```

This increases the timeout to 10 minutes (600 seconds).

If the command still times out, the updates are not cancelled. They continue running on the MainWP server. The CLI stops waiting. You can check the progress of a running job with:

```bash
mainwpcontrol jobs watch <job-id>
```

Replace `<job-id>` with the job ID from the timeout output. This command connects to the job and shows its progress until it finishes.

### Partial Update Failures

Some individual updates may fail. For example, a plugin may be incompatible with the current WordPress version, or a site may be temporarily unreachable. The command still exits successfully (exit code 0) as long as the overall operation completed.

To see which updates failed, check the `results` array in the JSON output. Each entry includes a `status` field indicating whether that particular update succeeded or failed.

To see what is still pending after a run:

```bash
mainwpcontrol abilities run list-updates-v1 --json
```

### "Updates remaining" Shows a Non-Zero Count After Running

This is normal and can happen for two reasons:

1. **Some updates failed.** Check the JSON output from the apply step for failure details.
2. **New updates appeared during the run.** If a plugin released a new version while your batch was running, it will show up as a new pending update.

In either case, re-run the script to apply the remaining updates.

### `set -e` Causes the Script to Exit Unexpectedly

The `set -e` directive tells bash to stop the script immediately if any command returns a non-zero exit code. This is generally desirable (you do not want to apply updates if the preview failed), but it can be surprising if an unexpected command fails.

To debug, run each command from the script individually in your terminal to find which one is failing and why. Common causes:

- `jq` is not installed (install it with `brew install jq` or `sudo apt-get install jq`)
- MainWP Control is not authenticated (run `mainwpcontrol doctor` to check)
- A network error caused a non-zero exit code

### GitHub Actions: "Login Failed"

If the Login step fails in your GitHub Actions workflow:

1. **Verify all three secrets are set.** Go to your repository's **Settings** > **Secrets and variables** > **Actions** and confirm that `DASHBOARD_URL`, `DASHBOARD_USER`, and `MAINWP_APP_PASSWORD` are all listed.
2. **Check the Dashboard URL.** It must include the `https://` prefix (e.g., `https://dashboard.example.com`, not `dashboard.example.com`).
3. **Verify the Application Password.** Go back to your WordPress Dashboard profile and check the Application Passwords section. If the password was revoked or you are unsure of the value, delete it and create a new one (repeat Step 1), then update the `MAINWP_APP_PASSWORD` secret in GitHub.
4. **Check that MainWP Dashboard is reachable.** The GitHub Actions runner connects from the public internet. If your Dashboard is behind a firewall or VPN, the runner will not be able to reach it. You may need to allowlist GitHub Actions IP ranges or use a self-hosted runner.
