/**
 * Minimal structured logger, self-contained so this package has no dependency
 * on the host app's own logging setup. Pretty console output by default;
 * set LOG_PRETTY=false for plain JSON lines (e.g. when a process manager
 * captures stdout itself).
 *
 * PII rule — same as the host app this was extracted from: log calls must
 * only pass counts, ids, durations, and enum-like labels. Never log a raw
 * prompt or reply body, since those can contain whatever the caller sent.
 */

const pino = require('pino');

const LOG_PRETTY = process.env.LOG_PRETTY !== 'false';

const root = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: LOG_PRETTY ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
  base: { 'service.name': 'chatgpt-enterprise-bridge', pid: process.pid },
});

function child(name) {
  return root.child({ 'log.logger': name });
}

module.exports = { logger: root, child };
