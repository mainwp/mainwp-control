# Plugin Deployment Verification

> Use GitHub Actions to verify that a specific plugin is installed on all your MainWP-connected WordPress sites.

When you manage dozens (or hundreds) of WordPress sites through MainWP, it is easy to lose track of which sites have a particular plugin installed. This guide walks you through setting up an automated check that you can trigger anytime from GitHub, without logging into your Dashboard.

You do not need prior experience with command-line tools, GitHub Actions, or scripting. Every concept is explained the first time it appears.

**Already using MainWP Control?** If `mainwpcontrol doctor` shows "System is ready", skip to [Step 4: Add Secrets to Your GitHub Repository](#step-4-add-secrets-to-your-github-repository).

---

## What You'll Set Up

By the end of this guide you will have:

- A **GitHub Actions workflow** that connects to your MainWP Dashboard, lists every connected site, and checks each one for a specific plugin.
- A **manual trigger** so you can run the check anytime from the GitHub Actions tab in your browser.
- **Clear output** showing which sites are missing the plugin as yellow warning annotations.

---

## Prerequisites

Before you start, make sure you have:

| Requirement | Why |
|---|---|
| **MainWP Dashboard 6 or later**, installed and running | MainWP Control communicates with the Dashboard REST API, which requires Dashboard 6+. |
| **WordPress admin access** to your Dashboard site | You need to create an Application Password (explained below). |
| **Node.js 20 or later** installed on your local machine | MainWP Control is a Node.js application. You only need Node.js locally for the initial verification steps; the GitHub Actions runner provides its own. |
| **A GitHub repository** | Any repository works. The workflow does not need your application code, it only needs a place to live. You can use an existing repo or create a new empty one. |

If you do not have Node.js installed, visit [https://nodejs.org](https://nodejs.org) and download the **LTS** version (20 or later). The installer handles everything.

---

## Step 1: Create an Application Password

An **Application Password** is a special password that WordPress generates for external tools. It lets MainWP Control authenticate with your Dashboard without using your regular login password. Application Passwords can be revoked individually, so if you ever want to cut off access you can delete this password alone without changing your main credentials.

1. Log in to your WordPress Dashboard site (the site where MainWP Dashboard is installed).
2. In the left sidebar, go to **Users** then click **Your Profile** (or **Profile**).
3. Scroll down to the section titled **Application Passwords**.
4. In the **New Application Password Name** field, type a descriptive name such as `mainwpcontrol`.
5. Click **Add New Application Password**.
6. WordPress displays the generated password. It looks something like this:

   ```
   AbCD 1234 efGH 5678 ijKL 9012
   ```

7. **Copy this password immediately.** WordPress will never show it again. If you lose it, you will need to create a new one.
8. Store the password somewhere secure (a password manager is ideal).

The spaces in the password are part of the format. You can include or omit them when you use the password -- WordPress accepts both.

---

## Step 2: Install MainWP Control

Open a **terminal**. On macOS, open the built-in Terminal app (search for "Terminal" in Spotlight). On Windows, use PowerShell or Windows Terminal. On Linux, use your distribution's terminal emulator.

Install MainWP Control globally using npm (npm is the package manager that comes with Node.js):

```bash
npm install -g @mainwp/control
```

This downloads MainWP Control and makes the `mainwpcontrol` command available anywhere on your machine.

**Alternative -- run without installing globally:**

If you prefer not to install globally, you can use `npx` which runs the package directly:

```bash
npx --package=@mainwp/control mainwpcontrol --version
```

`npx` downloads the package temporarily each time you run it. For this guide, the examples use `mainwpcontrol` directly, but you can substitute `npx --package=@mainwp/control mainwpcontrol` anywhere you see `mainwpcontrol`.

**Verify the installation:**

```bash
mainwpcontrol --version
```

Expected output:

```
@mainwp/control/x.y.z darwin-arm64 node-vNN.NN.N
```

You should see `@mainwp/control/` followed by a version number. If you see `command not found`, make sure Node.js 20+ is installed and try opening a new terminal window.

> **Windows PowerShell note:** PowerShell's quoting of inline JSON is unreliable and varies by version. When running `mainwpcontrol` locally with `--input`, use `--input-file params.json` instead. The GitHub Actions workflow runs on Linux, so this only affects local testing.

---

## Step 3: Authenticate (Local Verification)

Before setting up GitHub Actions, verify that your credentials work by logging in from your local machine. This step is optional for the workflow itself, but it saves time debugging later.

Run the interactive login command:

```bash
mainwpcontrol login
```

MainWP Control will prompt you for three pieces of information:

1. **Dashboard URL** -- Enter the full URL of your MainWP Dashboard site, including `https://`. For example: `https://dashboard.example.com`
2. **Username** -- Enter your WordPress admin username.
3. **Application Password** -- Paste the Application Password you created in Step 1.

After entering your credentials, MainWP Control stores them in a local profile so you do not have to enter them again on this machine. If the machine cannot use the OS keychain, keep `MAINWP_APP_PASSWORD` and `MAINWP_DASHBOARD_URL` available in the environment for future runs.

**Verify the connection:**

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

The key line is `✓ System is ready`. If any check fails, run `mainwpcontrol doctor -v` for details. If authentication fails, double-check your URL (make sure it includes `https://`), username, and Application Password.

**Note:** The GitHub Actions workflow will use the same credentials, but it reads them from GitHub Secrets instead of a local profile. The next step sets that up.

---

## Step 4: Add Secrets to Your GitHub Repository

**GitHub Secrets** are encrypted environment variables stored in your repository settings. GitHub Actions workflows can read them at runtime, but they are never displayed in logs or visible to collaborators browsing the repository. This is how you safely provide credentials to an automated workflow.

### Adding the secrets

1. Open your GitHub repository in a web browser.
2. Click the **Settings** tab at the top of the repository page. (If you do not see the Settings tab, you may not have admin access to the repository.)
3. In the left sidebar, click **Secrets and variables**, then click **Actions**.
4. Click the **New repository secret** button.

You need to add three secrets, one at a time. For each secret, enter the **Name** and **Value** exactly as shown, then click **Add secret**.

| Name | Value | Example |
|---|---|---|
| `DASHBOARD_URL` | Your MainWP Dashboard URL (including `https://`) | `https://dashboard.example.com` |
| `DASHBOARD_USER` | Your WordPress admin username | `admin` |
| `MAINWP_APP_PASSWORD` | The Application Password from Step 1 | `AbCD 1234 efGH 5678 ijKL 9012` |

After adding all three, your repository's Actions secrets page will show three entries listed by name: `DASHBOARD_URL`, `DASHBOARD_USER`, and `MAINWP_APP_PASSWORD`. The values are hidden -- GitHub shows only the names and the date each secret was last updated.

---

## Step 5: Create the Workflow File

A **GitHub Actions workflow** is a YAML file that lives in a special directory in your repository: `.github/workflows/`. YAML is a human-readable configuration format that uses indentation to show structure (similar to an outline). GitHub reads these files and runs the instructions they contain.

### 5a: Create the directory structure

If your repository does not already have a `.github/workflows/` directory, create it. Open a terminal in your repository's root directory and run:

```bash
mkdir -p .github/workflows
```

The `-p` flag tells `mkdir` to create any missing parent directories. If `.github/` does not exist yet, this command creates both `.github/` and `.github/workflows/` in one step.

### 5b: Build the workflow file

Rather than showing you the entire file at once, this section builds it piece by piece so you understand what each part does. You will combine everything in Step 5c.

Create a new file at `.github/workflows/verify-deploy.yml` in your text editor and add each section below.

---

**Workflow name and trigger:**

```yaml
name: Verify Plugin Deployment

on:
  workflow_dispatch:
    inputs:
      plugin:
        description: 'Plugin slug to check (e.g. "akismet")'
        required: true
        type: string
```

- `name:` gives the workflow a human-readable name that appears in the GitHub Actions tab.
- `on:` defines when the workflow runs. `workflow_dispatch` means "I will trigger this manually from the GitHub Actions tab." It does not run automatically on pushes or pull requests.
- `inputs:` creates a text field in the GitHub UI where you enter the plugin slug when you trigger the workflow. A **plugin slug** is the folder name of the plugin inside `wp-content/plugins/` -- for example, Akismet's slug is `akismet` and Yoast SEO's slug is `wordpress-seo`.

---

**Job definition and setup steps:**

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      DASHBOARD_URL: ${{ secrets.DASHBOARD_URL }}
      DASHBOARD_USER: ${{ secrets.DASHBOARD_USER }}
      MAINWP_APP_PASSWORD: ${{ secrets.MAINWP_APP_PASSWORD }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install mainwpcontrol
        run: npm install -g @mainwp/control
```

- `jobs:` defines the work to perform. A workflow can have multiple jobs, but this one only needs one, called `verify`.
- `runs-on: ubuntu-latest` tells GitHub to run this job on a fresh Ubuntu Linux virtual machine. GitHub provides these machines for free (with usage limits for public repositories).
- `steps:` lists the actions to perform, in order.
- `actions/setup-node@v4` is a prebuilt action from GitHub that installs Node.js. The `node-version: '20'` line tells it to install version 20.
- The second step installs MainWP Control globally, the same way you did on your local machine in Step 2.

---

**Authentication step:**

```yaml
      - name: Authenticate
        run: >
          mainwpcontrol login
          --url $DASHBOARD_URL
          --username $DASHBOARD_USER
```

- `env:` sets job-level environment variables so every `mainwpcontrol` step can authenticate. GitHub runners often do not persist credentials in an OS keychain between steps, so `MAINWP_APP_PASSWORD` must stay available for the whole job.
- `${{ secrets.NAME }}` is GitHub Actions syntax for reading a secret. GitHub replaces this with the actual value at runtime and automatically masks it in logs.
- `run: >` uses a YAML feature called **folding**. The `>` character means "join the following indented lines into a single line." This lets you split a long command across multiple lines for readability. The actual command that runs is: `mainwpcontrol login --url $DASHBOARD_URL --username $DASHBOARD_USER`
- The `--url` and `--username` flags provide credentials non-interactively, which is necessary because GitHub Actions runs without a terminal and cannot prompt for input.

---

**Plugin check step:**

```yaml
      - name: Check plugin across sites
        run: |
          mainwpcontrol abilities run list-sites-v1 --json | \
            jq -r '.data.data.items[].id' | while read SITE_ID; do
              PLUGINS=$(mainwpcontrol abilities run get-site-plugins-v1 \
                --input "{\"site_id_or_domain\": $SITE_ID}" --json 2>/dev/null)
              SUCCESS=$(echo "$PLUGINS" | jq -r '.success // false')
              if [ "$SUCCESS" != "true" ]; then
                echo "::warning::Could not check site $SITE_ID (site may be disconnected)"
                continue
              fi
              FOUND=$(echo "$PLUGINS" | jq --arg p "${{ inputs.plugin }}" \
                '[.data.data.plugins[] | select(.slug == $p)] | length')
              if [ "$FOUND" -eq 0 ]; then
                echo "::warning::Plugin ${{ inputs.plugin }} not found on site $SITE_ID"
              fi
            done
```

This is the core of the workflow. Here is what each piece does:

- `run: |` uses a YAML **literal block**. The `|` character means "keep the following lines exactly as written, including line breaks." This is used for multi-line scripts.

- **`mainwpcontrol abilities run list-sites-v1 --json`** calls the MainWP API to fetch a list of all connected sites. The `--json` flag tells mainwpcontrol to output structured JSON instead of human-readable text.

- **`jq -r '.data.data.items[].id'`** extracts the site IDs from the JSON response. `jq` is a command-line JSON processor (it comes pre-installed on GitHub's Ubuntu runners). The `-r` flag outputs raw text without quotes. `.data.data.items[].id` is a jq filter that means "from the outer `data` object, navigate into the inner `data` object, get the `items` array, and for each element, extract the `id` field."

- **`| while read SITE_ID; do ... done`** is a shell loop. The `|` (pipe) sends the list of site IDs into the loop, which processes them one at a time. Each iteration stores one site ID in the variable `SITE_ID`.

- **`mainwpcontrol abilities run get-site-plugins-v1 --input "{\"site_id_or_domain\": $SITE_ID}" --json`** fetches the list of plugins installed on a specific site. The `--input` flag passes the site identifier as a JSON parameter. The backslashes (`\"`) are needed to include quotes inside the JSON string.

- **The error check** (`SUCCESS` / `continue`) handles sites that are disconnected or unreachable. If the plugins call fails, the script emits a warning and skips to the next site instead of crashing.

- **`jq --arg p "${{ inputs.plugin }}" '[.data.data.plugins[] | select(.slug == $p)] | length'`** counts how many plugins match the slug you entered. `--arg p` creates a jq variable called `p` containing the plugin slug. `select(.slug == $p)` filters plugins to only those whose slug matches. `length` counts the results. If the count is `0`, the plugin was not found on that site.

- **`echo "::warning::Plugin ... not found on site ..."`** uses a special GitHub Actions syntax. Lines starting with `::warning::` create yellow warning annotations that appear prominently at the top of the workflow run page. This makes missing plugins easy to spot.

---

### 5c: Complete workflow file

Combine all the sections above into a single file. Create `.github/workflows/verify-deploy.yml` with this exact content:

```yaml
name: Verify Plugin Deployment

on:
  workflow_dispatch:
    inputs:
      plugin:
        description: 'Plugin slug to check (e.g. "akismet")'
        required: true
        type: string

jobs:
  verify:
    runs-on: ubuntu-latest
    env:
      DASHBOARD_URL: ${{ secrets.DASHBOARD_URL }}
      DASHBOARD_USER: ${{ secrets.DASHBOARD_USER }}
      MAINWP_APP_PASSWORD: ${{ secrets.MAINWP_APP_PASSWORD }}
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install mainwpcontrol
        run: npm install -g @mainwp/control

      - name: Authenticate
        run: >
          mainwpcontrol login
          --url $DASHBOARD_URL
          --username $DASHBOARD_USER

      - name: Check plugin across sites
        run: |
          mainwpcontrol abilities run list-sites-v1 --json | \
            jq -r '.data.data.items[].id' | while read SITE_ID; do
              PLUGINS=$(mainwpcontrol abilities run get-site-plugins-v1 \
                --input "{\"site_id_or_domain\": $SITE_ID}" --json 2>/dev/null)
              SUCCESS=$(echo "$PLUGINS" | jq -r '.success // false')
              if [ "$SUCCESS" != "true" ]; then
                echo "::warning::Could not check site $SITE_ID (site may be disconnected)"
                continue
              fi
              FOUND=$(echo "$PLUGINS" | jq --arg p "${{ inputs.plugin }}" \
                '[.data.data.plugins[] | select(.slug == $p)] | length')
              if [ "$FOUND" -eq 0 ]; then
                echo "::warning::Plugin ${{ inputs.plugin }} not found on site $SITE_ID"
              fi
            done
```

**YAML indentation matters.** Each level of indentation is exactly two spaces. If the workflow fails to load, the most common cause is incorrect indentation. Make sure you copy the file exactly as shown above.

---

## Step 6: Commit and Push the Workflow

Save the file, then commit and push it to your repository. Run these commands in your terminal from the repository root:

```bash
git add .github/workflows/verify-deploy.yml
git commit -m "Add plugin deployment verification workflow"
git push
```

- `git add` stages the file for commit (tells Git you want to include this file in the next snapshot).
- `git commit -m "..."` creates a snapshot of the staged changes with a descriptive message.
- `git push` uploads the commit to GitHub.

If this is your first time pushing to GitHub from the terminal, you may be prompted to authenticate. Follow the on-screen instructions.

---

## Step 7: Trigger the Workflow

Now that the workflow file is on GitHub, you can trigger it from the browser.

1. Open your repository on GitHub.
2. Click the **Actions** tab near the top of the page.
3. In the left sidebar, you will see **Verify Plugin Deployment** listed under "All workflows." Click it.
4. A banner appears on the right side with a **Run workflow** button. Click it.
5. A dropdown appears with a text field labeled *Plugin slug to check*. Enter the slug of the plugin you want to verify -- for example, `akismet`.
6. Click the green **Run workflow** button.

GitHub starts the workflow immediately. You will see a new entry appear in the workflow runs list with a yellow spinning indicator showing it is in progress.

---

## Step 8: Read the Results

1. Click on the running workflow entry to open it.
2. Click on the **verify** job to expand its steps.
3. Click on **Check plugin across sites** to see the detailed output.

**When the plugin is found on all sites:**

The step completes successfully with a green checkmark. The output shows the script running through each site with no warnings. There are no annotations at the top of the page.

**When a plugin is missing from one or more sites:**

The step still completes (it does not fail), but you will see yellow warning annotations at the top of the workflow run page. Each warning identifies which site is missing the plugin:

```
Warning: Plugin akismet not found on site 5
Warning: Plugin akismet not found on site 12
```

The numbers correspond to the site IDs in your MainWP Dashboard.

---

## Verifying It Works

Run the workflow a few times to build confidence:

1. **Test with a plugin you know is everywhere.** Run the workflow with a plugin slug like `akismet` (if you know it is installed on all sites). The workflow should complete with no warnings.

2. **Test with a plugin you know is missing.** Run the workflow with a plugin slug that is definitely not installed on every site. You should see warning annotations for the sites that are missing it.

3. **Check that secrets are hidden.** Open any completed workflow run and expand the "Authenticate" step. You should see `***` in place of your credentials -- GitHub automatically masks secret values in logs.

---

## Troubleshooting

### "Error: Login failed" in the Actions log

- Verify the `DASHBOARD_URL` secret includes the protocol (`https://`). A bare domain like `dashboard.example.com` will not work.
- Verify the `DASHBOARD_USER` secret matches your WordPress admin username exactly (it is case-sensitive).
- The Application Password may have been revoked or expired. Go back to Step 1 and generate a new one. Update the `MAINWP_APP_PASSWORD` secret with the new value.

### "jq: command not found"

The `ubuntu-latest` GitHub Actions runner includes `jq` by default. If you see this error, check that your workflow uses `runs-on: ubuntu-latest` (not a different runner like `windows-latest` or a self-hosted runner).

### Plugin not found, but it is definitely installed

The `plugin` input uses the **plugin slug**, not the display name. The slug is the folder name inside `wp-content/plugins/`. Here are some common examples where the slug differs from the display name:

| Display Name | Plugin Slug |
|---|---|
| Yoast SEO | `wordpress-seo` |
| WooCommerce | `woocommerce` |
| Contact Form 7 | `contact-form-7` |
| Wordfence Security | `wordfence` |

If you are unsure of a plugin's slug, you can check it using mainwpcontrol on your local machine:

```bash
mainwpcontrol abilities run get-site-plugins-v1 \
  --input '{"site_id_or_domain": 1}' \
  --json | jq -r '.data.data.plugins[].slug'
```

The output lists plugin slugs directly, one per line.

### Workflow does not appear in the Actions tab

- The workflow file must be on your repository's **default branch** (usually `main` or `master`) for `workflow_dispatch` triggers to appear in the Actions tab. If you committed to a different branch, merge it to your default branch first.
- Make sure the file is in `.github/workflows/` -- not `.github/workflow/` (note the plural) or another path.
- Check for YAML syntax errors. Even a small indentation mistake can prevent GitHub from loading the workflow. You can validate your YAML at [https://www.yamllint.com](https://www.yamllint.com).

### Timeout or slow execution with many sites

Each site is checked sequentially (one after another). For large networks, the execution time scales linearly:

- 10 sites: approximately 1-2 minutes
- 50 sites: approximately 5-10 minutes
- 100+ sites: approximately 10-20 minutes

GitHub Actions has a default timeout of 6 hours per job, so even very large networks will complete. If you find the wait too long, consider running the check against a subset of sites by modifying the `jq` filter to select specific site IDs.
