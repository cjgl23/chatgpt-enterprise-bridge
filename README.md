# chatgpt-enterprise-bridge

A small local HTTP service that drives a saved ChatGPT Enterprise browser
session (via Playwright), so any app — in any programming language — can use
it with plain HTTP calls. Runs on Windows and Mac.

Extracted from `itassist-incident-extract`'s ChatGPT automation. See that
app's `utils/chatgptClient.js` history for the production incidents behind
each of the design choices here (rate-limit handling, reply-completion
detection, the reasoning-tier picker, etc.) — this package keeps that logic
close to verbatim, since it was earned the hard way.

## Why local-only

This service acts on a **real, logged-in ChatGPT Enterprise account** — it is
not a general-purpose API server. Run it only on `127.0.0.1` (the default),
and only on the machine that holds the saved login. Do not expose it to your
company network or the internet.

## Setup

```
npm install
npm start
```

On first run, if `CHATGPT_BRIDGE_API_KEY` is not set, a random key is printed
to the console. Every request (except `/health`) needs it in an `x-api-key`
header.

### Logging in (one-time, per machine)

1. `POST /session/setup/start` — opens a real, visible browser window.
2. Log in to ChatGPT Enterprise by hand (SSO/MFA) in that window.
3. `POST /session/setup/done` — saves the session and closes the browser.

Progress can be watched via `GET /session/setup/stream` (Server-Sent Events).

The saved session lives at `~/.chatgpt-enterprise-bridge/chatgpt-session.json`
by default (override with `CHATGPT_BRIDGE_PROFILE_DIR`).

## Using it

```
POST /session/open              { "thinkingLevel": "instant" }  -> { "sessionId": "..." }
POST /session/:id/ask           { "prompt": "..." }              -> { "reply": "..." }
POST /session/:id/close         {}                                -> { "closed": true }
GET  /session/status                                              -> { "ready": true }
POST /session/setup/clear                                         -> { "cleared": true }
```

Every request needs `x-api-key: <your key>` in its headers.

Sessions are in-memory only — if the server restarts, open a new one. A
`thinkingLevel` of `medium` or `high` throws a clear error if it's greyed out
in ChatGPT's picker (usually your account's usage limit), rather than a
generic timeout.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CHATGPT_BRIDGE_PORT` | `4747` | Port to listen on |
| `CHATGPT_BRIDGE_API_KEY` | (random per run) | Pin the API key across restarts |
| `CHATGPT_BRIDGE_PROFILE_DIR` | `~/.chatgpt-enterprise-bridge` | Where the saved session + browser profile live |
| `CHATGPT_BRIDGE_BROWSER_CHANNEL` | `msedge` | Override the browser channel, e.g. `chrome` |
| `CHATGPT_URL` | `https://chatgpt.com/` | Override for a different ChatGPT deployment |
| `CHATGPT_HEADLESS` | `true` | Set `false` to watch the automated browser |

## Autostart (Windows / Mac)

Not set up yet — for now, start it manually (`npm start`) when you need it.
Planned: a Windows Task Scheduler entry and a macOS `launchd` agent, so it
starts automatically on login.

## Status

First cut, tested end-to-end against a live ChatGPT Enterprise account on
Windows. Not yet verified on Mac — the underlying browser-launch code
already handles Windows/Mac differences (see `src/browser.js`), but this
package itself has not been run there yet.
