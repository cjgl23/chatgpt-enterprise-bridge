/**
 * Local HTTP wrapper around chatgptClient.js — so any app, in any language,
 * can drive a saved ChatGPT Enterprise session with plain HTTP calls instead
 * of embedding Playwright itself. Designed to run on localhost only, on the
 * same machine as the saved login (see README.md).
 *
 * Auth: every route except /health requires an `x-api-key` header matching
 * CHATGPT_BRIDGE_API_KEY. If that env var is not set, a random key is
 * generated on startup and printed once — this is a LOCAL tool, but it can
 * still act on a real logged-in ChatGPT account, so it should never be left
 * wide open by default.
 */

const crypto = require('crypto');
const express = require('express');
const chatgpt = require('./chatgptClient');
const setup = require('./setup');
const { child } = require('./logger');

const log = child('server');

const PORT = Number(process.env.CHATGPT_BRIDGE_PORT || 4747);
const API_KEY = process.env.CHATGPT_BRIDGE_API_KEY || crypto.randomBytes(24).toString('hex');

// In-memory only — sessions do not survive a server restart, by design (a
// restart means the browser process is gone too). Callers should treat a
// 404 on an unknown sessionId as "open a new one."
const sessions = new Map();

// SSE clients for the one setup flow in progress, if any (mirrors the
// pattern from itassist-incident-extract's index.js).
let setupClients = [];
setupClients._resolve = null;

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header.' });
  }
  next();
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, platform: process.platform }));

  app.use(requireApiKey);

  app.get('/session/status', (_req, res) => {
    res.json({ ready: setup.chatgptSessionExists() });
  });

  app.post('/session/setup/start', (_req, res) => {
    setupClients = [];
    setupClients._resolve = null;
    setup.runChatgptSetup(setupClients).catch(err => {
      log.error({ err, 'event.action': 'setup.start.failed' }, 'ChatGPT setup failed to start');
    });
    res.json({ started: true });
  });

  app.get('/session/setup/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    setupClients.push(res);
    req.on('close', () => { setupClients = setupClients.filter(c => c !== res); });
  });

  app.post('/session/setup/done', (_req, res) => {
    if (setupClients._resolve) {
      setupClients._resolve();
      setupClients._resolve = null;
    }
    res.json({ ok: true });
  });

  app.post('/session/setup/clear', (_req, res) => {
    res.json({ cleared: setup.clearSession() });
  });

  // Open a new ChatGPT session (launches a headless browser using the saved
  // login). Body: { thinkingLevel?: 'instant'|'medium'|'high' }
  app.post('/session/open', async (req, res) => {
    try {
      const { thinkingLevel } = req.body || {};
      const session = await chatgpt.openSession({ thinkingLevel });
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, session);
      log.info({ 'event.action': 'bridge.session.opened', labels: { sessionId } }, 'Session opened');
      res.json({ sessionId });
    } catch (err) {
      log.error({ err, 'event.action': 'bridge.session.open.failed' }, 'Failed to open session');
      res.status(err.status || 500).json({ error: err.message || String(err) });
    }
  });

  // Send a prompt on an open session and wait for the reply.
  // Body: { prompt: string }
  app.post('/session/:id/ask', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Unknown or expired sessionId — open a new session.' });
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Body must include a non-empty "prompt" string.' });
    }
    try {
      const reply = await session.ask(prompt);
      res.json({ reply });
    } catch (err) {
      const status = chatgpt.isSessionExpiredError(err) ? 409 : chatgpt.isRateLimitError(err) ? 429 : 500;
      log.error({ err, 'event.action': 'bridge.session.ask.failed', labels: { sessionId: req.params.id } }, 'ask() failed');
      res.status(status).json({ error: err.message || String(err) });
    }
  });

  app.post('/session/:id/close', async (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Unknown or already-closed sessionId.' });
    try { await session.close(); } catch (_) {}
    sessions.delete(req.params.id);
    res.json({ closed: true });
  });

  // Not persisted anywhere on disk — only ever printed once, at startup.
  app.get('/session/_apikey-hint', (_req, res) => {
    res.json({ hint: 'Set CHATGPT_BRIDGE_API_KEY to pin this across restarts; see server startup log for the current key.' });
  });

  return app;
}

function start() {
  const app = createApp();
  const server = app.listen(PORT, '127.0.0.1', () => {
    log.info(
      { 'event.action': 'bridge.started', labels: { port: PORT, platform: process.platform } },
      `chatgpt-enterprise-bridge listening on http://127.0.0.1:${PORT}`
    );
    if (!process.env.CHATGPT_BRIDGE_API_KEY) {
      // Printed directly (not through the structured logger) so it's easy to
      // copy-paste, and clearly marked as generated-this-run.
      console.log(`\n  No CHATGPT_BRIDGE_API_KEY set — generated for this run only:\n  ${API_KEY}\n`);
    }
  });
  return server;
}

module.exports = { createApp, start, PORT };
