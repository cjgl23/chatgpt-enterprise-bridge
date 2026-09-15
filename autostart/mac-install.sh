#!/bin/bash
# Registers chatgpt-enterprise-bridge to start automatically when you log in
# to macOS, using launchd (the standard macOS way to run background services
# for a user — no separate tool to install).
#
# OPTIONAL. The bridge service works fine with plain `npm start` and does not
# need this. Run this script only if you want it to start on its own.
#
# If your Mac is corporate-managed (MDM), a configuration profile may block
# installing LaunchAgents. If `launchctl bootstrap` below fails with an
# "Operation not permitted" or similar error, that's a policy restriction,
# not a bug in this script — just keep starting the service by hand
# (`npm start`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"
LABEL="com.chatgpt-enterprise-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/chatgpt-enterprise-bridge"

NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
  echo "node not found on PATH. Install Node.js first (e.g. via nvm or brew), then re-run this script." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# CHATGPT_BRIDGE_API_KEY, if already set in this shell, is baked into the
# plist so the key stays stable across restarts (launchd does not inherit
# your shell's environment — a service it starts only sees what's explicitly
# listed here). Without this, a new random key is generated and printed to
# the log every time the service starts.
ENV_BLOCK=""
if [ -n "${CHATGPT_BRIDGE_API_KEY:-}" ]; then
  ENV_BLOCK="    <key>EnvironmentVariables</key>
    <dict>
        <key>CHATGPT_BRIDGE_API_KEY</key>
        <string>${CHATGPT_BRIDGE_API_KEY}</string>
    </dict>"
  echo "Baking the current CHATGPT_BRIDGE_API_KEY into the launchd agent."
else
  echo "No CHATGPT_BRIDGE_API_KEY set in this shell — a new random key will be generated (and logged) every time the service starts. Set CHATGPT_BRIDGE_API_KEY and re-run this script to pin it instead."
fi

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${PACKAGE_DIR}/bin/start.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PACKAGE_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
${ENV_BLOCK}
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>
PLIST

# Modern launchctl syntax (macOS 10.11+): bootstrap into the user's GUI
# domain. bootout first so re-running this script updates a live agent
# cleanly instead of erroring "already bootstrapped".
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

echo "Installed and started launchd agent '${LABEL}'."
echo "It will start automatically next time you log in."
echo "Logs: ${LOG_DIR}/stdout.log and stderr.log"
echo "To remove it later: autostart/mac-uninstall.sh"
