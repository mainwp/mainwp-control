# Monitoring Integration

> Send MainWP site metrics to your monitoring system (Datadog, StatsD, or similar) so you can track site health over time and set up alerts.

Managing a network of WordPress sites generates useful numbers — how many sites you have, how many need updates, how many are disconnected. These numbers are valuable for spotting trends and catching problems early, but only if they are tracked over time in a monitoring system.

This guide walks you through extracting metrics from your MainWP Dashboard using MainWP Control, sending them to a StatsD-compatible monitoring service, and scheduling the whole thing to run automatically. You do not need any prior experience with scripting, monitoring protocols, or the command line. Every concept is explained before it is used.

---

## What You'll Set Up

By the end of this guide you will have:

- **Commands** that extract metrics from your MainWP Dashboard (site count, pending updates, disconnected sites)
- **One-liners** that send these metrics to StatsD/Datadog
- **A monitoring script** that combines multiple metrics, handles errors, and runs on a schedule

---

## Prerequisites

Before you begin, make sure you have the following:

- **MainWP Dashboard 6 or later**, installed and running on a WordPress site. This is the central hub that manages your connected sites.
- **WordPress admin access** to your Dashboard site. You will need to create an Application Password for CLI authentication.
- **Node.js 20 or later** installed on the machine that will run MainWP Control. This is the machine where the monitoring script will execute — it does not need to be the same server as your Dashboard.
- **A StatsD-compatible monitoring service** (Datadog Agent, Telegraf, Graphite, etc.) listening on UDP port 8125. If you use a different monitoring tool, the concepts are the same — you will just need to adapt the "send" step for your tool's protocol.

---

## Step 1: Create an Application Password

Application Passwords are a WordPress feature that lets external tools (like MainWP Control) authenticate with your site without using your main login credentials. Each Application Password is a separate credential you can revoke independently.

1. Log in to your WordPress Dashboard site as an administrator.
2. Navigate to **Users → Your Profile** (or click your name in the top-right corner and select "Edit Profile").
3. Scroll down to the **Application Passwords** section near the bottom of the page.
4. In the **"New Application Password Name"** field, type a name to identify this credential — for example, `mainwpctl`.
5. Click **"Add New Application Password"**.
6. WordPress will display a generated password. It looks something like this:

   ```
   AbCD 1234 efGH 5678 ijKL 9012
   ```

7. **Copy this password immediately.** WordPress will not show it again. If you lose it, you will need to create a new one.
8. Store it somewhere secure — a password manager, a CI/CD secret store, or a secure note. You will need it in Step 3.

---

## Step 2: Install MainWP Control

MainWP Control is a command-line tool distributed as an npm package. npm is the package manager that comes bundled with Node.js.

**If you do not have Node.js installed:** Download and install Node.js 20 or later from [https://nodejs.org](https://nodejs.org). The LTS (Long Term Support) version is recommended. The installer includes npm automatically.

### Option A: Install globally (recommended)

A global install makes `mainwpctl` available as a command anywhere on your system:

```bash
npm install -g mainwpctl
```

### Option B: Run without installing (npx)

If you cannot or prefer not to install packages globally, you can use `npx` to run MainWP Control on demand. npx downloads and runs the package temporarily:

```bash
npx mainwpctl
```

### Verify the installation

Run the following command to confirm MainWP Control is installed and working:

```bash
mainwpctl --version
```

Expected output:

```
mainwpctl/x.y.z darwin-arm64 node-vNN.NN.N
```

You should see `mainwpctl/` followed by a version number. The exact values depend on your system.

---

## Step 3: Authenticate

MainWP Control needs to know which MainWP Dashboard to connect to and how to authenticate. The `login` command walks you through this interactively.

Run:

```bash
mainwpctl login
```

You will be prompted for three pieces of information:

1. **Dashboard URL** — The full URL of your MainWP Dashboard site (e.g., `https://manage.example.com`).
2. **Username** — Your WordPress admin username on the Dashboard site.
3. **Application Password** — The password you created in Step 1. Paste it in when prompted (the spaces in the password are fine — include them or omit them, both work).

After entering these, MainWP Control stores your credentials in your system's keychain when one is available (macOS Keychain, Linux secret service, or Windows Credential Manager). If the machine cannot use a keychain, keep `MAINWP_APP_PASSWORD` available in the environment for future runs.

### Verify authentication

Run the built-in diagnostic command:

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

The key line is `✓ System is ready`. If any check fails, run `mainwpctl doctor -v` for details. If authentication fails, double-check your URL, username, and Application Password.

---

## Step 4: Understand the Metrics You Can Extract

Before sending metrics anywhere, it helps to understand what data MainWP Control gives you. This step explores three useful metrics by running commands and inspecting their output.

### Tool: jq

Several commands in this guide use **jq**, a command-line tool for reading and filtering JSON data. JSON is the structured data format that MainWP Control outputs when you use the `--json` flag.

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

### Total site count

Start by listing all sites connected to your MainWP Dashboard:

```bash
mainwpctl abilities run list-sites-v1 --json
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

The exact sites will match your Dashboard. Now extract just the count using jq:

```bash
mainwpctl abilities run list-sites-v1 --json | jq '.data.data.items | length'
```

Here is what the jq expression means:

- `.data.data.items` — Navigate into the JSON: start at the root, go into the outer `data` object, then the inner `data` object, then `items` (which is an array of sites).
- `| length` — Count how many items are in that array.

The `|` between commands is a **pipe**. It takes the output of the command on the left and feeds it as input to the command on the right.

Expected output:

```
12
```

The number will match how many sites are connected to your Dashboard.

### Pending update count

```bash
mainwpctl abilities run list-updates-v1 --json | jq '.data.data.total // 0'
```

The jq expression `.data.data.total // 0` means: "get the `total` field from the inner `data` object, or use `0` if it does not exist." The `//` operator is jq's alternative operator — it provides a fallback value when a field is missing or null.

Expected output:

```
7
```

This is the total number of pending updates (plugins, themes, and core) across all your sites.

### Disconnected site count

```bash
mainwpctl abilities run list-sites-v1 --json | jq '[.data.data.items[] | select(.status != "connected")] | length'
```

This jq expression is more involved, so here is what each part does:

- `.data.data.items[]` — Iterate over every item in the `items` array.
- `select(.status != "connected")` — Keep only the sites whose `status` field is not `"connected"`.
- `[...] | length` — Wrap the filtered results in an array and count how many items are in it.

Expected output if all sites are connected:

```
0
```

Expected output if two sites are disconnected:

```
2
```

---

## Step 5: Send Site Count to StatsD/Datadog

Now that you know how to extract metrics, the next step is sending them to your monitoring system.

### What is StatsD?

StatsD is a protocol for sending metrics to monitoring systems. It is text-based and simple — you send a string like `metric.name:value|type` over UDP to port 8125. Datadog, Graphite, Telegraf, and many other monitoring tools understand this protocol. If your tool accepts StatsD metrics, these examples will work as-is.

### What is netcat (nc)?

`nc` (netcat) is a command-line tool that sends data over the network. Here we use it to send a UDP packet to the local StatsD agent. It is included by default on macOS and most Linux distributions.

### Building the one-liner piece by piece

Start with just getting the count and printing it:

```bash
SITE_COUNT=$(mainwpctl abilities run list-sites-v1 --json | jq '.data.data.items | length')
echo "Site count: $SITE_COUNT"
```

A **variable** (like `SITE_COUNT`) stores a value so you can use it later. The `$(...)` syntax runs the command inside the parentheses and captures its output.

Expected output:

```
Site count: 12
```

Next, format it as a StatsD metric:

```bash
SITE_COUNT=$(mainwpctl abilities run list-sites-v1 --json | jq '.data.data.items | length')
echo "mainwp.sites.total:${SITE_COUNT}|g"
```

Expected output:

```
mainwp.sites.total:12|g
```

Here is what this string means:

- `mainwp.sites.total` — The metric name. You choose this. Use dots to create a hierarchy (like a folder structure) in your monitoring dashboard.
- `:${SITE_COUNT}` — The value. The `${}` syntax inserts the variable's value into the string.
- `|g` — The metric type. `g` stands for **gauge**, which is a value that goes up and down (like a count). Other types include `c` for counter (increments only) and `ms` for timing.

Finally, send it to StatsD:

```bash
mainwpctl abilities run list-sites-v1 --json | \
  jq '.data.data.items | length' | \
  xargs -I {} echo "mainwp.sites.total:{}|g" | \
  nc -u -w1 localhost 8125
```

Each line in this pipeline does one thing:

1. `mainwpctl abilities run list-sites-v1 --json` — Fetches the site data as JSON from your MainWP Dashboard.
2. `jq '.data.data.items | length'` — Extracts the site count from the JSON.
3. `xargs -I {} echo "mainwp.sites.total:{}|g"` — Formats the count as a StatsD metric string. `xargs` takes the input (the count) and passes it to the `echo` command. `-I {}` means "replace `{}` with the input value."
4. `nc -u -w1 localhost 8125` — Sends the formatted string via UDP (`-u`) to localhost port 8125 with a 1-second timeout (`-w1`).

The `\` at the end of each line tells the shell that the command continues on the next line. This is purely for readability — you could write the entire command on one line.

There is no output from this command if it succeeds. The metric is sent silently to StatsD.

---

## Step 6: Send Pending Update Count

The same pattern works for any metric. Here is the one-liner for pending updates:

```bash
mainwpctl abilities run list-updates-v1 --json | \
  jq '.data.data.total // 0' | \
  xargs -I {} echo "mainwp.updates.pending:{}|g" | \
  nc -u -w1 localhost 8125
```

The only differences from the previous step:

- The mainwpctl command fetches updates instead of sites (`list-updates-v1` instead of `list-sites-v1`).
- The jq expression extracts `.data.data.total` instead of the sites array length.
- The metric name is `mainwp.updates.pending` instead of `mainwp.sites.total`.

---

## Step 7: Add Error Detection

What happens when MainWP Control fails — for example, if your Dashboard is unreachable or your credentials have expired? The jq parsing will fail or produce garbage, and you will send a wrong metric value to your monitoring system without knowing.

Error handling fixes this. Here is a version that detects failure and sends a different metric to alert you:

```bash
RESULT=$(mainwpctl abilities run list-sites-v1 --json 2>/dev/null)
EXIT=$?

if [ $EXIT -ne 0 ]; then
  echo "mainwp.check.failed:1|c" | nc -u -w1 localhost 8125
else
  SITE_COUNT=$(echo "$RESULT" | jq '.data.data.items | length')
  echo "mainwp.sites.total:${SITE_COUNT}|g" | nc -u -w1 localhost 8125
fi
```

Here is what is new:

- `2>/dev/null` — Redirects error messages (called **stderr**, or "standard error") to `/dev/null`, which discards them. This keeps the captured output clean — only JSON goes into `RESULT`.
- `EXIT=$?` — The special variable `$?` contains the **exit code** of the most recently run command. An exit code of `0` means success. Any other number means something went wrong.
- `if [ $EXIT -ne 0 ]; then` — This is a **conditional**. `-ne` means "not equal to." So this reads: "if the exit code is not equal to zero, then..."
- `echo "mainwp.check.failed:1|c"` — Notice the metric type is `|c` instead of `|g`. The `c` stands for **counter**. Unlike a gauge, a counter increments: each time this line runs, the count goes up by 1. This lets you set up alerts in your monitoring dashboard like "alert me if `mainwp.check.failed` increments more than 3 times in the last hour."
- `else` — Runs the normal metric-sending code when the command succeeds.
- `fi` — Marks the end of the `if` block.

---

## Step 8: Combine into a Monitoring Script

Now we combine everything into a single script that collects all metrics and runs on a schedule. We will build it incrementally.

### 8a: Script skeleton with a helper function

Create a new file called `mainwp-metrics.sh`. You can use any text editor. If you are unsure, use `nano` in your terminal:

```bash
nano mainwp-metrics.sh
```

Start with this skeleton:

```bash
#!/bin/bash
# mainwp-metrics.sh — Send MainWP metrics to StatsD/Datadog

STATSD_HOST="localhost"
STATSD_PORT="8125"

send_metric() {
  echo "$1" | nc -u -w1 "$STATSD_HOST" "$STATSD_PORT"
}
```

Here is what each part does:

- `#!/bin/bash` — The **shebang** line. It tells your operating system to run this script using Bash.
- `STATSD_HOST` and `STATSD_PORT` — Configuration variables. If your StatsD agent runs on a different host or port, change these values here instead of hunting through the script.
- `send_metric()` — A **function**. It is a reusable shortcut so you do not repeat the `nc` command every time you send a metric. When you call `send_metric "mainwp.sites.total:12|g"`, the `$1` inside the function is replaced with that string.

### 8b: Add site metrics

Add the following below the `send_metric` function:

```bash
# Site count and disconnected count
SITES=$(mainwpctl abilities run list-sites-v1 --json 2>/dev/null)
if [ $? -eq 0 ]; then
  TOTAL=$(echo "$SITES" | jq '.data.data.items | length')
  DISCONNECTED=$(echo "$SITES" | jq '[.data.data.items[] | select(.status != "connected")] | length')
  send_metric "mainwp.sites.total:${TOTAL}|g"
  send_metric "mainwp.sites.disconnected:${DISCONNECTED}|g"
else
  send_metric "mainwp.check.failed:1|c"
fi
```

Notice that we call `mainwpctl abilities run list-sites-v1` only once and extract two metrics (total count and disconnected count) from the same response. This is efficient — each API call takes a few seconds, so reusing the result saves time.

The `$? -eq 0` check means "the exit code equals zero" — i.e., the command succeeded. `-eq` means "equal to."

### 8c: Add update metrics

Add this below the site metrics block:

```bash
# Pending updates
UPDATES=$(mainwpctl abilities run list-updates-v1 --json 2>/dev/null)
if [ $? -eq 0 ]; then
  PENDING=$(echo "$UPDATES" | jq '.data.data.total // 0')
  send_metric "mainwp.updates.pending:${PENDING}|g"
else
  send_metric "mainwp.check.failed:1|c"
fi
```

### 8d: Complete assembled script

Here is the complete script with all sections combined:

```bash
#!/bin/bash
# mainwp-metrics.sh — Send MainWP metrics to StatsD/Datadog

STATSD_HOST="localhost"
STATSD_PORT="8125"

send_metric() {
  echo "$1" | nc -u -w1 "$STATSD_HOST" "$STATSD_PORT"
}

# Site count and disconnected count
SITES=$(mainwpctl abilities run list-sites-v1 --json 2>/dev/null)
if [ $? -eq 0 ]; then
  TOTAL=$(echo "$SITES" | jq '.data.data.items | length')
  DISCONNECTED=$(echo "$SITES" | jq '[.data.data.items[] | select(.status != "connected")] | length')
  send_metric "mainwp.sites.total:${TOTAL}|g"
  send_metric "mainwp.sites.disconnected:${DISCONNECTED}|g"
else
  send_metric "mainwp.check.failed:1|c"
fi

# Pending updates
UPDATES=$(mainwpctl abilities run list-updates-v1 --json 2>/dev/null)
if [ $? -eq 0 ]; then
  PENDING=$(echo "$UPDATES" | jq '.data.data.total // 0')
  send_metric "mainwp.updates.pending:${PENDING}|g"
else
  send_metric "mainwp.check.failed:1|c"
fi
```

Save the file (in nano: press `Ctrl+O`, then `Enter`, then `Ctrl+X` to exit).

### 8e: Make executable and schedule with cron

Make the script executable:

```bash
chmod +x mainwp-metrics.sh
```

`chmod` stands for "change mode" and `+x` adds execute permission. You only need to run this once.

Now schedule it to run every 5 minutes using **cron**, the built-in job scheduler on macOS and Linux. Open your crontab (cron table) for editing:

```bash
crontab -e
```

Add this line:

```
*/5 * * * * /full/path/to/mainwp-metrics.sh
```

Replace `/full/path/to/mainwp-metrics.sh` with the actual full path to your script. To find the full path, run:

```bash
realpath mainwp-metrics.sh
```

The cron syntax `*/5 * * * *` means "every 5 minutes." Here is how to read it:

| Field         | Value | Meaning                     |
|---------------|-------|-----------------------------|
| minute        | `*/5` | Every 5 minutes             |
| hour          | `*`   | Every hour                  |
| day-of-month  | `*`   | Every day                   |
| month         | `*`   | Every month                 |
| day-of-week   | `*`   | Every day of the week       |

Save and exit the editor:

- In **nano**: Press `Ctrl+O`, then `Enter`, then `Ctrl+X`.
- In **vi**: Press `Esc`, type `:wq`, then press `Enter`.

Verify the cron job is saved:

```bash
crontab -l
```

Expected output:

```
*/5 * * * * /Users/yourname/mainwp-metrics.sh
```

---

## Verifying It Works

Run through this checklist to confirm everything is connected:

1. **Run the script manually:**

   ```bash
   ./mainwp-metrics.sh
   ```

   The script produces no terminal output on success — it sends metrics silently to StatsD.

2. **Check your monitoring dashboard** for the new metrics:
   - `mainwp.sites.total`
   - `mainwp.sites.disconnected`
   - `mainwp.updates.pending`

3. **If using Datadog:** Open Metrics Explorer and search for `mainwp`. You should see your metrics listed with recent data points.

4. **If you do not see metrics**, test the StatsD connection directly to rule out mainwpctl as the problem:

   ```bash
   echo "test.metric:1|g" | nc -u -w1 localhost 8125
   ```

   If this test metric does not appear in your dashboard either, the issue is with your StatsD agent configuration, not with the script.

---

## Adapting for Other Monitoring Tools

The metrics-extraction commands (`mainwpctl` + `jq`) are the same regardless of where you send the data. Only the "send" step changes.

### Prometheus / Node Exporter

Instead of sending to StatsD, write metrics to a file in Prometheus text format. Node Exporter's textfile collector picks up `.prom` files from a configured directory:

```bash
cat > /var/lib/node_exporter/textfile/mainwp.prom <<EOF
mainwp_sites_total $TOTAL
mainwp_sites_disconnected $DISCONNECTED
mainwp_updates_pending $PENDING
EOF
```

Note: Prometheus metric names use underscores (`_`) instead of dots (`.`). Adjust the directory path to match your Node Exporter textfile collector configuration.

### HTTP-based monitoring (Healthchecks.io, Uptime Kuma, etc.)

These services give you a URL to ping. A successful ping means "the check ran and everything is OK":

```bash
if [ "$DISCONNECTED" -eq 0 ]; then
  curl -s "https://hc-ping.com/your-uuid-here" > /dev/null
else
  curl -s "https://hc-ping.com/your-uuid-here/fail" > /dev/null
fi
```

Replace `your-uuid-here` with the UUID from your monitoring service.

### Simple log file

If you do not have a monitoring system yet, logging to a file is a good starting point. You can review the file manually or parse it later:

```bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) sites=$TOTAL disconnected=$DISCONNECTED updates=$PENDING" >> /var/log/mainwp-metrics.log
```

This appends a timestamped line to the log file each time the script runs. The `>>` operator appends instead of overwriting. The timestamp format (`2026-03-05T14:30:00Z`) is ISO 8601, which sorts correctly and is easy to parse.

---

## Troubleshooting

### netcat (nc) not installed

- **macOS:** `nc` is included by default. No installation needed.
- **Ubuntu / Debian:** `sudo apt-get install netcat-openbsd`
- **Alpine:** `apk add netcat-openbsd`
- **Alternative:** On some systems, bash has a built-in network feature you can use instead of `nc`:

  ```bash
  echo "mainwp.sites.total:12|g" > /dev/udp/localhost/8125
  ```

  This is not available on all systems (notably macOS does not support it by default), but it works on most Linux distributions.

### StatsD not listening / metrics not appearing

- **Verify StatsD is running** by checking if the port is open:

  ```bash
  nc -z -u localhost 8125 && echo "open" || echo "closed"
  ```

  If the output is `closed`, your StatsD agent is not running or is listening on a different port.

- **If using Datadog Agent:** Check that DogStatsD is enabled in the agent configuration file (usually `/etc/datadog-agent/datadog.yaml`). Look for `use_dogstatsd: true` and `dogstatsd_port: 8125`.

- **Check the metric name:** Some monitoring systems have naming conventions or restrictions. For example, Datadog converts dots to nested tags. If your metrics are not appearing where you expect, check your monitoring tool's documentation for metric naming rules.

### Metric values are wrong or missing

Test the jq parsing in isolation to see what value is being extracted:

```bash
mainwpctl abilities run list-sites-v1 --json | jq '.data.data.items | length'
```

If the output is empty or shows a jq error, the JSON structure may have changed. Check the raw output:

```bash
mainwpctl abilities run list-sites-v1 --json
```

Look at the actual structure and adjust the jq expressions accordingly.

### Cron job not running

- **Check cron logs:**
  - On Linux: `grep CRON /var/log/syslog`
  - On macOS: `log show --predicate 'process == "cron"' --last 1h`

- **Use full paths in cron.** Cron does not load your shell profile, so commands like `mainwpctl` and `jq` may not be found by their short names. Add a `PATH` line at the top of your crontab:

  ```
  PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin
  */5 * * * * /full/path/to/mainwp-metrics.sh
  ```

  The `/opt/homebrew/bin` entry is for macOS with Homebrew on Apple Silicon.

- **On macOS**, you may need to grant Terminal (or your terminal app) **Full Disk Access** in **System Settings → Privacy & Security → Full Disk Access**. Without this, cron may be silently blocked from running scripts.

### Authentication errors in cron

Cron runs in a minimal environment and may not have access to your system keychain where MainWP Control stores credentials. If the script works when you run it manually but fails from cron, set the credentials as environment variables directly in your crontab:

```
MAINWP_APP_PASSWORD=your-app-password
*/5 * * * * /full/path/to/mainwp-metrics.sh
```

Replace `your-app-password` with the Application Password from Step 1 (spaces removed). Environment variables set at the top of the crontab apply to all jobs below them.
