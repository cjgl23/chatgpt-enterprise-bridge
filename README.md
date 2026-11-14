# chatgpt-enterprise-bridge

A small program that runs on your own computer and lets your other apps use
your **ChatGPT Enterprise** account through simple web requests.

Behind the scenes it opens Microsoft Edge (invisibly), types your prompt into
chatgpt.com using your saved login, waits for the answer, and hands the answer
back to your app. Any language that can make an HTTP request (Python,
JavaScript, C#, PowerShell, Power Automate, …) can use it. Works on Windows
and Mac.

> **Keep it on your own machine.** The bridge acts as *you* in ChatGPT. It
> only listens on `127.0.0.1` (your computer only), and every request needs a
> secret key. Don't expose it to your company network or the internet, and
> don't share your key.

> **Not an official OpenAI product.** This project is independent and is not
> affiliated with, endorsed by, or supported by OpenAI. It works by automating
> the ChatGPT website, which OpenAI's terms of use or your organization's
> policies may not allow. Check both before you use it, and use it at your
> own risk. ChatGPT's website can change at any time and break the bridge
> without warning.

---

## Contents

1. [What you need first](#1-what-you-need-first)
2. [Download the bridge](#2-download-the-bridge)
3. [Install its packages](#3-install-its-packages)
4. [Set up your settings (`.env` file)](#4-set-up-your-settings-env-file)
5. [Start the bridge](#5-start-the-bridge)
6. [Log in to ChatGPT (one time)](#6-log-in-to-chatgpt-one-time)
7. [Ask your first question](#7-ask-your-first-question)
8. [Use it from your own code](#8-use-it-from-your-own-code)
9. [All settings (environment variables)](#9-all-settings-environment-variables)
10. [Start it automatically (optional)](#10-start-it-automatically-optional)
11. [Troubleshooting](#11-troubleshooting)
12. [License](#license)

All commands below are typed into a terminal:

- **Mac:** open the **Terminal** app (press `Cmd + Space`, type *Terminal*, press Enter).
- **Windows:** open **PowerShell** (press the Windows key, type *PowerShell*, press Enter).

Each step shows the Mac and Windows command where they differ. Type or paste
one command at a time and press Enter.

---

## 1. What you need first

| You need | How to check | How to get it |
|---|---|---|
| **Node.js 20.12 or newer** (22 or 24 recommended) | `node -v` prints `v22…` or similar | Download the **LTS** installer from [nodejs.org](https://nodejs.org) and run it. Reopen your terminal afterwards. |
| **Git** | `git --version` prints a version | Mac: run `xcode-select --install`. Windows: install from [git-scm.com](https://git-scm.com). |
| **Microsoft Edge** | It's in your apps list | Already on Windows. Mac: install from [microsoft.com/edge](https://www.microsoft.com/edge). (Google Chrome also works — see `CHATGPT_BRIDGE_BROWSER_CHANNEL` in [step 9](#9-all-settings-environment-variables).) |
| **A ChatGPT Enterprise login** | You can sign in at [chatgpt.com](https://chatgpt.com) | Ask your IT team. |

If `node -v` says *command not found* (Mac) or *not recognized* (Windows),
Node.js isn't installed yet, or you need to close and reopen the terminal.

---

## 2. Download the bridge

Go to the folder where you keep projects, then download the code:

```
git clone https://github.com/cjgl23/chatgpt-enterprise-bridge.git
cd chatgpt-enterprise-bridge
```

Every command from now on is run **inside this `chatgpt-enterprise-bridge`
folder**. If you open a new terminal later, `cd` back into it first.

---

## 3. Install its packages

```
npm install
```

This downloads the libraries the bridge needs into a `node_modules` folder.
It takes a minute. Warnings are fine; a red `ERR!` line is not (see
[Troubleshooting](#11-troubleshooting)).

---

## 4. Set up your settings (`.env` file)

The bridge reads its settings from a file called `.env` in the project
folder. You only need to set **one** thing to begin with: an **API key**. It's a
password you make up, and your apps send it with every request so that only
they can use the bridge.

**a) Make your own copy of the example settings file**

Mac:
```
cp .env.example .env
```

Windows:
```
copy .env.example .env
```

**b) Generate a random API key** (same command on Mac and Windows):

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

It prints a long line of letters and numbers, such as
`3f9c2a…e81b`. Select it and copy it.

**c) Paste the key into `.env`**

Open the file:

- Mac: `open -e .env` (opens in TextEdit)
- Windows: `notepad .env`

Find this line:

```
CHATGPT_BRIDGE_API_KEY=
```

and paste your key right after the `=`, with no spaces or quotes:

```
CHATGPT_BRIDGE_API_KEY=3f9c2a...e81b
```

Save and close the file.

> **Already have `CHATGPT_BRIDGE_API_KEY` on this computer?** A
> `CHATGPT_BRIDGE_API_KEY` that is already set in your computer's environment
> variables (for example, from an earlier install or `setx`) **overrides** the
> one in `.env`, and the bridge silently uses that one instead. Check:
>
> - Mac: `echo $CHATGPT_BRIDGE_API_KEY`
> - Windows: `echo $env:CHATGPT_BRIDGE_API_KEY`
>
> If it prints a key, either use **that same key** in your apps (and in `.env`,
> so they match), or remove it so `.env` takes effect:
>
> - Mac: delete the `export CHATGPT_BRIDGE_API_KEY=...` line from `~/.zshrc`
>   (or `~/.bash_profile`), then open a new terminal.
> - Windows: run `[Environment]::SetEnvironmentVariable("CHATGPT_BRIDGE_API_KEY", $null, "User")`,
>   then open a new PowerShell window. (If your IT team set it machine-wide,
>   ask them to remove it.)
>
> The same rule applies to every other setting: anything already set in your
> computer's environment wins over `.env`.

**d) (Mac only) Make the file private**

```
chmod 600 .env
```

That's it. Every other setting has a sensible default. To change one later,
open `.env`, remove the `#` at the start of its line, edit the value, save,
and restart the bridge. The full list is in [step 9](#9-all-settings-environment-variables).

> `.env` is ignored by git, so your key won't be uploaded if you push the
> project to GitHub. Never put the key in `.env.example` or in your code.

---

## 5. Start the bridge

```
npm start
```

You should see a line like:

```
chatgpt-enterprise-bridge listening on http://127.0.0.1:4747
```

**Leave this terminal window open.** The bridge only runs while it's open.
Stop it with `Ctrl + C`.

Open a **second** terminal window (and `cd` into the project folder) for the
next steps.

**Quick check:** open <http://127.0.0.1:4747/health> in your browser. It
should show `{"ok":true,...}`.

> If you see *"No CHATGPT_BRIDGE_API_KEY set — generated for this run only"*,
> the bridge didn't find your key. Check that the file is named exactly `.env`
> (not `.env.txt`) and is in the project folder, then restart.

---

## 6. Log in to ChatGPT (one time)

The bridge needs your ChatGPT login saved once per computer. You log in
yourself in a real browser window, so SSO and MFA work normally.

In the commands below, **replace `YOUR_KEY` with your API key** from step 4.

**a) Open the login window**

Mac:
```
curl -X POST http://127.0.0.1:4747/session/setup/start -H "x-api-key: YOUR_KEY"
```

Windows:
```
Invoke-RestMethod -Method Post http://127.0.0.1:4747/session/setup/start -Headers @{ "x-api-key" = "YOUR_KEY" }
```

An Edge window opens on chatgpt.com.

**b) Log in** in that window with your Enterprise account (SSO, MFA, etc.).
Wait until you can see the normal ChatGPT chat screen.

**c) Tell the bridge you're done.** It saves your login and closes the window.

Mac:
```
curl -X POST http://127.0.0.1:4747/session/setup/done -H "x-api-key: YOUR_KEY"
```

Windows:
```
Invoke-RestMethod -Method Post http://127.0.0.1:4747/session/setup/done -Headers @{ "x-api-key" = "YOUR_KEY" }
```

**d) Check it worked:**

Mac:
```
curl http://127.0.0.1:4747/session/status -H "x-api-key: YOUR_KEY"
```

Windows:
```
Invoke-RestMethod http://127.0.0.1:4747/session/status -Headers @{ "x-api-key" = "YOUR_KEY" }
```

It should say `ready: true`. Your login is saved in the
`.chatgpt-enterprise-bridge` folder inside your home folder. Treat that folder
like a password, because anyone with it can use your ChatGPT account.

Logins expire eventually. When requests start failing with *"session is
missing or has expired"*, repeat this step.

---

## 7. Ask your first question

Using the bridge takes three requests: **open** a session, **ask** one or more
questions, then **close** it.

**Mac:**

```
curl -X POST http://127.0.0.1:4747/session/open -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" -d "{}"
```

This replies with something like `{"sessionId":"8b1e…"}`. Copy the
`sessionId` value and use it in place of `SESSION_ID`:

```
curl -X POST http://127.0.0.1:4747/session/SESSION_ID/ask -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" -d '{"prompt":"Say hello in five words."}'

curl -X POST http://127.0.0.1:4747/session/SESSION_ID/close -H "x-api-key: YOUR_KEY" -H "Content-Type: application/json" -d "{}"
```

**Windows (PowerShell):**

```
$h = @{ "x-api-key" = "YOUR_KEY" }
$s = Invoke-RestMethod -Method Post http://127.0.0.1:4747/session/open -Headers $h -ContentType "application/json" -Body "{}"
Invoke-RestMethod -Method Post "http://127.0.0.1:4747/session/$($s.sessionId)/ask" -Headers $h -ContentType "application/json" -Body '{"prompt":"Say hello in five words."}'
Invoke-RestMethod -Method Post "http://127.0.0.1:4747/session/$($s.sessionId)/close" -Headers $h -ContentType "application/json" -Body "{}"
```

**Be patient.** Each question waits about 15 seconds before it's sent (on
purpose, so ChatGPT doesn't rate-limit you), and then however long ChatGPT
takes to answer. Opening a session also takes a few seconds.

### Thinking level

Sessions use the **Instant** thinking level unless you ask for another. To use
a deeper level, send it when opening the session:

```
{ "thinkingLevel": "medium" }
```

Allowed values: `instant` (the default), `medium`, `high`. Medium and High are
slower and count against your account's usage limit. If one is unavailable
(for example the limit is reached), opening the session fails with a clear
error. It never quietly falls back to a lower level.

### All endpoints

| Request | Body | Returns |
|---|---|---|
| `GET /health` (no key needed) | | `{ "ok": true }` |
| `GET /session/status` | | `{ "ready": true }` when a login is saved |
| `POST /session/setup/start` | | Opens the login window |
| `GET /session/setup/stream` | | Live progress of the login (Server-Sent Events) |
| `POST /session/setup/done` | | Saves the login, closes the window |
| `POST /session/setup/clear` | | Deletes the saved login |
| `POST /session/open` | `{ "thinkingLevel": "instant" }` (optional) | `{ "sessionId": "..." }` |
| `POST /session/:id/ask` | `{ "prompt": "..." }` | `{ "reply": "..." }` |
| `POST /session/:id/close` | `{}` | `{ "closed": true }` |

Every request except `/health` needs the `x-api-key: YOUR_KEY` header.

Sessions live in memory only. If the bridge restarts, open a new session (an
old `sessionId` returns `404`).

---

## 8. Use it from your own code

**Python** (`pip install requests` first):

```python
import os
import requests

BRIDGE = "http://127.0.0.1:4747"
HEADERS = {"x-api-key": os.environ["CHATGPT_BRIDGE_API_KEY"]}

session_id = requests.post(f"{BRIDGE}/session/open", json={}, headers=HEADERS, timeout=120).json()["sessionId"]
try:
    reply = requests.post(
        f"{BRIDGE}/session/{session_id}/ask",
        json={"prompt": "Summarise the benefits of unit tests in 3 bullets."},
        headers=HEADERS,
        timeout=900,  # answers can take minutes
    ).json()["reply"]
    print(reply)
finally:
    requests.post(f"{BRIDGE}/session/{session_id}/close", json={}, headers=HEADERS, timeout=60)
```

**JavaScript / Node.js 18+** (no packages needed):

```js
const BRIDGE = 'http://127.0.0.1:4747';
const headers = { 'x-api-key': process.env.CHATGPT_BRIDGE_API_KEY, 'Content-Type': 'application/json' };
const post = (path, body) => fetch(BRIDGE + path, { method: 'POST', headers, body: JSON.stringify(body) }).then(r => r.json());

const { sessionId } = await post('/session/open', {});
try {
  const { reply } = await post(`/session/${sessionId}/ask`, { prompt: 'Summarise the benefits of unit tests in 3 bullets.' });
  console.log(reply);
} finally {
  await post(`/session/${sessionId}/close`, {});
}
```

Tips:

- Read the key from an environment variable in **your** app too, as above.
  Don't paste it into your code.
- Reuse one session for many questions, and send them **one at a time** (wait
  for each reply). The bridge drives one browser tab per session.
- Use a long timeout (10–15 minutes) on `ask`, especially for Medium and High.
- Error codes from `ask`: `409` means the login expired (redo [step 6](#6-log-in-to-chatgpt-one-time)),
  `429` means ChatGPT rate-limited you even after the bridge's own retries,
  and `500` covers anything else (the message explains what happened).

---

## 9. All settings (environment variables)

Put any of these in your `.env` file as `NAME=value`, one per line, then
restart the bridge.

**Order of priority:** a setting already present in your computer's
environment variables (system, user, or the current terminal) **overrides**
the same setting in `.env`. This matters most for `CHATGPT_BRIDGE_API_KEY`: if
one is already set on the machine, the bridge uses it and ignores the key in
`.env` (see the note in [step 4](#4-set-up-your-settings-env-file)).

### Common settings

| Setting | Default | What it does |
|---|---|---|
| `CHATGPT_BRIDGE_API_KEY` | random each start | The key your apps send in the `x-api-key` header. **Set this.** Without it, a new key is printed every start and your apps break on every restart. |
| `CHATGPT_BRIDGE_PORT` | `4747` | Port number. Change it if something else already uses 4747. Your apps must use the same port. |
| `CHATGPT_MODEL` | `Latest` | Which model to choose in ChatGPT's model picker, using its exact label (for example `GPT-5.6 Sol`). If the label isn't in the picker, opening a session fails rather than using a different model. |
| `CHATGPT_BRIDGE_BROWSER_CHANNEL` | `msedge` | Which installed browser to drive: `msedge` or `chrome`. |
| `CHATGPT_HEADLESS` | `true` | `false` shows the browser window while it works. Handy for seeing what's going wrong. |
| `CHATGPT_BRIDGE_PROFILE_DIR` | `~/.chatgpt-enterprise-bridge` | Folder where the saved login lives. |
| `CHATGPT_URL` | `https://chatgpt.com/` | Only change this if your company uses a different ChatGPT address. |
| `LOG_LEVEL` | `info` | How much the bridge prints: `debug`, `info`, `warn`, `error`. |
| `LOG_PRETTY` | `true` | `false` prints logs as JSON lines (useful when another tool collects the logs). |

### Advanced tuning (leave these alone unless you have a reason)

Times are in milliseconds (1000 = 1 second).

| Setting | Default | What it does |
|---|---|---|
| `CHATGPT_REQUEST_DELAY_MS` | `15000` | Pause before each question (randomised ±25%) to avoid ChatGPT's rate limits. |
| `CHATGPT_BATCHES_PER_CONVERSATION` | `10` | Questions sent in one ChatGPT conversation before a fresh one is started. ChatGPT limits how quickly new conversations are created (around 16), so keep this below that. |
| `CHATGPT_RATE_LIMIT_MAX_RETRIES` | `5` | How many times to wait and retry after a rate limit. |
| `CHATGPT_RATE_LIMIT_BACKOFF_MS` | `90000` | Wait before retrying a rate limit when ChatGPT doesn't say how long (grows with each retry). |
| `CHATGPT_TIMEOUT_MS` | per level | Maximum wait for an answer, for every thinking level. |
| `CHATGPT_TIMEOUT_INSTANT_MS` | `300000` (5 min) | Maximum wait at Instant. Overrides `CHATGPT_TIMEOUT_MS`. |
| `CHATGPT_TIMEOUT_MEDIUM_MS` | `600000` (10 min) | Maximum wait at Medium. |
| `CHATGPT_TIMEOUT_HIGH_MS` | `900000` (15 min) | Maximum wait at High. |
| `CHATGPT_BLANK_REPLY_GRACE_MS` | `15000` | How long a finished-but-empty answer is allowed before it's reported as a blank reply. |
| `CHATGPT_POLL_MS` | `400` | How often the answer is re-read while ChatGPT is writing. |
| `CHATGPT_QUIET_MS` | `2500` | How long the answer must stop changing before it counts as finished. |
| `CHATGPT_RELAXED_QUIET_MS` | `800` | Shorter quiet window used once the Stop button has been gone for a while. |
| `CHATGPT_STOP_HIDDEN_MAX_MS` | `30000` | How long after the Stop button disappears to switch to the shorter quiet window. |
| `CHATGPT_STUCK_QUIET_MS` | `20000` | Accept the answer if it's been unchanged this long even though ChatGPT still shows a Stop button. |

### Setting variables without `.env`

`.env` is the easiest option, but normal environment variables work too, and
they take priority:

- Mac, for one terminal session: `export CHATGPT_HEADLESS=false` then `npm start`.
- Windows, for one PowerShell session: `$env:CHATGPT_HEADLESS = "false"` then `npm start`.
- Windows, permanently for your user: `setx CHATGPT_BRIDGE_API_KEY "YOUR_KEY"` (open a new terminal afterwards).

---

## 10. Start it automatically (optional)

You can skip this and just run `npm start` when you need the bridge. If you'd
rather it start by itself when you log in to your computer:

**Mac** (from the project folder):

```
bash autostart/mac-install.sh
```

Logs go to `~/Library/Logs/chatgpt-enterprise-bridge/`. To remove it:
`bash autostart/mac-uninstall.sh`.

**Windows** (from the project folder, in PowerShell):

```
powershell -ExecutionPolicy Bypass -File autostart\windows-install.ps1
```

To start it straight away without logging out:
`Start-ScheduledTask -TaskName ChatGPTEnterpriseBridge`. To remove it:
`powershell -ExecutionPolicy Bypass -File autostart\windows-uninstall.ps1`.

The auto-started bridge reads the same `.env` file, so set your API key there
first. Company-managed laptops sometimes block these. If the script reports
"Operation not permitted" or "access denied", that's your IT policy, not a
bug; keep using `npm start`.

---

## 11. Troubleshooting

| Problem | Fix |
|---|---|
| `node` / `npm` *not found* or *not recognized* | Install Node.js ([step 1](#1-what-you-need-first)) and open a new terminal. |
| `process.loadEnvFile is not a function` | Your Node.js is too old. Install the current LTS from [nodejs.org](https://nodejs.org). |
| `EADDRINUSE` when starting | Something already uses port 4747, often another copy of the bridge. Close it, or set `CHATGPT_BRIDGE_PORT=4848` in `.env`. |
| `401 Missing or invalid x-api-key header` | The key in your request doesn't match `CHATGPT_BRIDGE_API_KEY` in `.env`. Check for extra spaces or quotes. Restart the bridge after editing `.env`. Also check for an older key set in your system environment, which overrides `.env`: run `echo $CHATGPT_BRIDGE_API_KEY` (Mac) or `echo $env:CHATGPT_BRIDGE_API_KEY` (Windows). |
| A new key is printed every time it starts | `.env` wasn't found or the key line is empty. See [step 4](#4-set-up-your-settings-env-file). On Windows, make sure Notepad didn't save it as `.env.txt`. |
| *Could not launch the system browser* | Install Microsoft Edge, or set `CHATGPT_BRIDGE_BROWSER_CHANNEL=chrome` if you use Chrome. |
| *Profile in use* / *SingletonLock* during login | Another bridge browser is still open. Close all Edge windows that the bridge opened and try again. |
| *session is missing or has expired* (HTTP `409`) | Log in again ([step 6](#6-log-in-to-chatgpt-one-time)). |
| *… is not available in this workspace's ChatGPT model picker* | Open chatgpt.com, click the model picker, and copy a model name exactly into `CHATGPT_MODEL`. |
| *Medium/High … is disabled* | Your account hit its usage limit for that level. Wait for it to reset or use `instant`. |
| *ChatGPT finished its reply without any text (blank reply)* | The chosen model returned nothing. Try again, or pick another model with `CHATGPT_MODEL` (for example `GPT-5.6 Sol`). |
| Rate-limit errors (HTTP `429`) | You're sending too much, too fast. Slow down, or raise `CHATGPT_REQUEST_DELAY_MS`. |
| Want to see what it's doing | Set `CHATGPT_HEADLESS=false` in `.env`, restart, and watch the browser window. |

---

## For maintainers

- `npm test` runs the unit tests.
- `node scripts/verify-chatgpt-connector.cjs` checks the browser automation
  against local HTML copies of ChatGPT's page in a real Edge. No login or
  network is needed.
- Tested end-to-end on Windows. On Mac, model and thinking-level selection
  were checked against the live site in Edge (2026-11-14).

## License

Released under the [MIT License](LICENSE).
