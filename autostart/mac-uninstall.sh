#!/bin/bash
# Removes the chatgpt-enterprise-bridge launchd autostart entry.
set -euo pipefail

LABEL="com.chatgpt-enterprise-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST_PATH"
echo "Removed launchd agent '${LABEL}' (if it existed)."
