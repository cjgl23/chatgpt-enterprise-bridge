/**
 * Browser launch helpers — extracted from itassist-incident-extract's
 * automation/browser.js, generalized for standalone use. See that file's
 * history for why each guard exists; kept close to verbatim on purpose since
 * these are hard-won, production-confirmed fixes, not guesses.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const IS_WINDOWS = process.platform === 'win32';

const CHANNEL_MARKER = 'channel.json';
const LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];

function channelMarkerPath(profileDir) {
  return path.join(profileDir, CHANNEL_MARKER);
}

function recordChannel(profileDir, channel) {
  try {
    fs.writeFileSync(channelMarkerPath(profileDir), JSON.stringify({ channel }), 'utf8');
  } catch (_) {}
}

function readChannel(profileDir) {
  try {
    const raw = fs.readFileSync(channelMarkerPath(profileDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.channel === 'string' ? parsed.channel : null;
  } catch (_) {
    return null;
  }
}

function isLockError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return /SingletonLock|ProcessSingleton|profile (?:appears to be )?in use|Failed to create a ProcessSingleton|cannot create.*lock|Opening in existing browser session/i.test(msg);
}

function isBrowserMissingError(err) {
  const msg = (err && (err.message || String(err))) || '';
  return /Executable doesn't exist|npx playwright install|Please run the following command/i.test(msg);
}

// System browser channel to drive. Microsoft Edge is the default because it
// is commonly the corporate-managed, SSO-wired browser on BOTH Windows and
// Mac — but this is a default, not an assumption baked into the logic below.
// Override with CHATGPT_BRIDGE_BROWSER_CHANNEL (e.g. 'chrome') per machine.
function channelCandidates(preferredChannel) {
  const override = process.env.CHATGPT_BRIDGE_BROWSER_CHANNEL;
  if (override) return [override];
  if (preferredChannel) return [preferredChannel];
  return ['msedge'];
}

function noSystemBrowserError(cause) {
  return new Error(
    'Could not launch the system browser. This drives your installed browser (not a bundled one). '
    + 'Make sure Microsoft Edge is installed, or set CHATGPT_BRIDGE_BROWSER_CHANNEL=chrome to use Google Chrome instead.',
    { cause }
  );
}

function systemProfileLockedError() {
  return new Error(
    'The browser is still running in the background on your default profile. Close every browser '
    + 'process for this profile (on Windows, check Task Manager for msedge.exe/chrome.exe; on Mac, '
    + 'Cmd+Q the browser fully, not just close the window), then try again.'
  );
}

function clearStaleLocks(profileDir) {
  for (const name of LOCK_FILES) {
    try { fs.rmSync(path.join(profileDir, name), { force: true }); } catch (_) {}
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Launch a persistent Chromium context against `profileDir`. Used by the
 * headed SSO setup flow, which needs a real on-disk profile.
 */
async function launchProfile({ profileDir, contextOptions, preferredChannel, record = false, stateDir, allowLockClear = true }) {
  const candidates = channelCandidates(preferredChannel);
  const channelStateDir = stateDir || profileDir;

  let lastErr;
  for (const channel of candidates) {
    const launchOpts = { ...contextOptions, channel };
    try {
      const browser = await launchWithLockRetry(profileDir, launchOpts, allowLockClear);
      if (record) recordChannel(channelStateDir, channel);
      return { browser, channel };
    } catch (err) {
      lastErr = err;
      continue;
    }
  }

  if (isBrowserMissingError(lastErr)) throw noSystemBrowserError(lastErr);
  if (!allowLockClear && isLockError(lastErr)) throw systemProfileLockedError();
  throw lastErr;
}

/**
 * Launch a NON-persistent system browser (real Browser, not a context) for
 * headless use. The session is supplied separately via storageState on
 * newContext(), so there is no profile to reuse and no profile lock to fight.
 */
async function launchBrowser({ preferredChannel, headless = true, args, ignoreDefaultArgs } = {}) {
  const candidates = channelCandidates(preferredChannel);

  let lastErr;
  for (const channel of candidates) {
    try {
      const browser = await chromium.launch({ headless, channel, args, ignoreDefaultArgs });
      return { browser, channel };
    } catch (err) {
      lastErr = err;
      continue;
    }
  }

  if (isBrowserMissingError(lastErr)) throw noSystemBrowserError();
  throw lastErr;
}

// Attempt a launch, and on Windows retry after clearing stale profile locks.
// Mac/Linux release the profile lock synchronously on close, so this retry
// loop is a no-op there (maxAttempts collapses to 1).
async function launchWithLockRetry(profileDir, launchOpts, allowLockClear = true) {
  const maxAttempts = IS_WINDOWS && allowLockClear ? 4 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await chromium.launchPersistentContext(profileDir, launchOpts);
    } catch (err) {
      lastErr = err;
      if (IS_WINDOWS && allowLockClear && isLockError(err) && attempt < maxAttempts) {
        clearStaleLocks(profileDir);
        await sleep(500 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Wait for the profile lock to be released after closing a browser.
 * Windows-only: on Mac/Linux the profile is released synchronously on close.
 */
async function waitForProfileRelease(profileDir, { timeoutMs = 8000, allowLockClear = true } = {}) {
  if (!IS_WINDOWS) return;
  const lockPath = path.join(profileDir, 'SingletonLock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(lockPath)) return;
    await sleep(200);
  }
  if (allowLockClear) clearStaleLocks(profileDir);
}

module.exports = {
  launchProfile,
  launchBrowser,
  readChannel,
  recordChannel,
  waitForProfileRelease,
  channelMarkerPath,
  CHANNEL_MARKER,
};
