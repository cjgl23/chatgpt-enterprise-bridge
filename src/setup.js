/**
 * ChatGPT-only saved-session setup — extracted from itassist-incident-extract's
 * automation/setup.js. The ServiceNow/ITAssist half of that file is dropped
 * here on purpose: it was this app's own second login target, not a generic
 * concern of "drive ChatGPT Enterprise."
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { launchProfile, waitForProfileRelease } = require('./browser');
const { child } = require('./logger');

const log = child('setup');

const PROFILE_DIR = process.env.CHATGPT_BRIDGE_PROFILE_DIR || path.join(os.homedir(), '.chatgpt-enterprise-bridge');
const CHATGPT_URL = process.env.CHATGPT_URL || 'https://chatgpt.com/';
const SESSION_STATE_PATH = path.join(PROFILE_DIR, 'chatgpt-session.json');

function sessionFileUsable(sessionStatePath) {
  try {
    if (!fs.statSync(sessionStatePath).size) return false;
    const parsed = JSON.parse(fs.readFileSync(sessionStatePath, 'utf8'));
    return Array.isArray(parsed.cookies) && parsed.cookies.length > 0;
  } catch (_) {
    return false;
  }
}

function chatgptSessionExists() {
  return sessionFileUsable(SESSION_STATE_PATH);
}

async function runChatgptSetup(clients) {
  const broadcast = (event) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try { client.write(data); } catch (_) {}
    }
  };

  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  broadcast({ type: 'progress', message: 'Launching browser...' });

  let browser;
  try {
    // See browser.js / the original app's setup.js for why these flags
    // matter: they hide the two most common CDP-automation fingerprints,
    // which is what ChatGPT's bot-management challenge keys off — even in a
    // real, human-driven headed session.
    const contextOptions = {
      headless: false,
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      args: ['--new-window', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    };

    ({ browser } = await launchProfile({ profileDir: PROFILE_DIR, contextOptions, record: true }));

    const page = browser.pages()[0] || await browser.newPage();
    broadcast({ type: 'progress', message: 'Opening ChatGPT — please log in...' });

    try {
      await page.goto(CHATGPT_URL, { waitUntil: 'commit', timeout: 15000 });
    } catch (err) {
      log.error({ err, 'event.action': 'setup.navigation_failed' }, 'Initial navigation did not commit');
      broadcast({ type: 'progress', message: `Navigation issue: ${err.message || err}` });
    }

    broadcast({
      type: 'awaiting_user',
      message: 'The browser is open. Sign in to ChatGPT with your Enterprise account (including SSO/MFA). Once you can see the ChatGPT chat screen, call POST /session/setup/done.',
    });
    log.info({ 'event.action': 'setup.awaiting_user', 'event.category': ['authentication'] }, 'Awaiting user SSO login');

    await new Promise(resolve => { clients._resolve = resolve; });

    broadcast({ type: 'progress', message: 'Saving session profile...' });
    await browser.storageState({ path: SESSION_STATE_PATH });
    await browser.close();
    browser = null;

    await waitForProfileRelease(PROFILE_DIR);

    broadcast({ type: 'done', message: 'ChatGPT session saved.' });
    log.info({ 'event.action': 'setup.session.saved', 'event.category': ['authentication'], 'event.outcome': 'success' }, 'Session profile saved');
  } catch (err) {
    broadcast({ type: 'error', message: err.message || String(err) });
    log.error({ err, 'event.action': 'setup.error', 'event.category': ['authentication'], 'event.outcome': 'failure' }, 'Setup failed');
    try { await browser?.close(); } catch (_) {}
  }
}

function clearSession() {
  try {
    fs.unlinkSync(SESSION_STATE_PATH);
    log.info({ 'event.action': 'setup.session.cleared', 'event.category': ['authentication'], 'event.outcome': 'success' }, 'Session cleared');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

module.exports = {
  runChatgptSetup,
  clearSession,
  chatgptSessionExists,
  PROFILE_DIR,
  SESSION_STATE_PATH,
  CHATGPT_URL,
};
