/**
 * ChatGPT Enterprise Playwright client
 *
 * Drives a ChatGPT Enterprise subscription through the chatgpt.com web UI,
 * authenticated with the saved storageState session captured by the
 * "Setup ChatGPT Session" flow (./setup.js). Extracted from
 * itassist-incident-extract's utils/chatgptClient.js so any app — in any
 * language, via the HTTP server built on top of this module — can reuse the
 * same, hard-won automation logic instead of re-discovering it.
 *
 * Model selection: on session open we best-effort pick
 *   1. the LATEST model — the first `menuitemradio` in the picker whose
 *      label isn't a known reasoning-tier name (e.g. "GPT-5.6 Sol" today;
 *      the top item tracks whatever is newest, so this needs no hardcoded
 *      model name), and
 *   2. the requested reasoning tier ("Thinking effort" in the current UI).
 *      Callers default to "Instant"; a caller may request Medium or High.
 * As of 2026-09 the picker is a SINGLE flat menu: model choices and
 * reasoning-tier choices are sibling `menuitemradio` items in one group,
 * not a model submenu plus a separate "Intelligence" section (that older,
 * two-step structure this module originally targeted is gone — there is no
 * longer any nested submenu to open). A tier item can also be present but
 * `disabled` — confirmed in production this happens when the account has
 * hit its ChatGPT usage limit, not because of a selector mismatch — so that
 * case is detected and reported with its own explicit error rather than
 * timing out on an unclickable element.
 * The ChatGPT DOM changes over time, so the latest-model pick is fail-soft:
 * if a selector no longer matches, we log and continue with whatever model
 * the account has selected — a usable answer from the default model beats a
 * failed run. Reasoning-tier selection for Medium/High remains hard-fail
 * (see selectLatestModel below) so a run never silently misrepresents which
 * tier actually produced a document.
 *
 * Requests are strictly SEQUENTIAL over a single page: the web UI is one
 * conversation at a time, and parallel tabs invite rate limiting.
 *
 * Rate limiting: confirmed in production, ChatGPT's own rate-limit message
 * reads "we've temporarily limited access to your CONVERSATIONS to protect
 * your data" — this throttle keys off how often NEW conversations get
 * created, not just message-sending pace. It fired consistently at the same
 * point (the ~16th–17th new conversation) across repeated runs. Starting a
 * fresh chat on literally every ask() call — the original design, meant to
 * keep every batch's scoring fully isolated from every other's — was
 * exactly the pattern that triggers it.
 *
 * The fix: ask() now reuses ONE conversation across CHATGPT_BATCHES_PER_CONVERSATION
 * consecutive calls before starting a new one (default 10 - comfortably under
 * the observed ~16 threshold with margin), rather than one conversation
 * total (unbounded context growth, and any anchoring on earlier batches'
 * results would silently taint every later one) or one per call (the
 * observed failure). This is a real, deliberate tradeoff: within a chunk,
 * later batches are no longer scored in full isolation from earlier ones in
 * the same conversation — the periodic reset bounds how far that can drift.
 * A fresh conversation is also forced immediately after any rate-limit or
 * reload retry, since a flagged/wedged conversation should not be reused.
 *
 * On top of that, every ask() (1) waits a jittered CHATGPT_REQUEST_DELAY_MS
 * before sending, and (2) watches for a rate-limit toast/modal appearing
 * after send; if one shows up, it backs off (using ChatGPT's own stated
 * reset time when the message includes one, otherwise a growing default)
 * and retries the SAME prompt rather than failing the row/batch. Exact
 * rate-limit wording drifts, so detection matches broadly rather than one
 * fixed string.
 */

const { PROFILE_DIR, SESSION_STATE_PATH: CHATGPT_SESSION_STATE_PATH, CHATGPT_URL, chatgptSessionExists } = require('./setup');
const { launchBrowser, readChannel } = require('./browser');
const { child } = require('./logger');

const log = child('chatgptClient');

const BASE_URL = CHATGPT_URL;
// Human-readable label used in progress messages and run summaries.
const THINKING_LEVELS = Object.freeze(['instant', 'medium', 'high']);

function validateThinkingLevel(value = 'instant') {
  const level = String(value == null ? 'instant' : value).trim().toLowerCase();
  if (!THINKING_LEVELS.includes(level)) {
    throw Object.assign(new Error('Thinking level must be Instant, Medium, or High.'), { status: 400 });
  }
  return level;
}

function thinkingLevelLabel(value = 'instant') {
  const level = validateThinkingLevel(value);
  return level[0].toUpperCase() + level.slice(1);
}

function modelLabel(value = 'instant') {
  return `ChatGPT Enterprise (latest model, ${thinkingLevelLabel(value)})`;
}

/**
 * Match a reasoning-tier menu item by its visible label. Anchored to the
 * START of the item's text (not just a word boundary) because "High" is a
 * substring of "Extra High" — an unanchored match would hit both. The start
 * anchor tolerates a run of leading non-letter characters (a checkmark glyph
 * or a visually-hidden "Selected" text node can precede the label in DOM
 * order for the currently-active tier, independent of its visual position).
 * The END of the label only needs a non-letter boundary (not specifically
 * whitespace) — confirmed in production: the picker's actual text is
 * "Instant5.5" with NO space between the tier name and the version number
 * (adjacent DOM nodes with no whitespace text node between them, unlike the
 * genuinely two-word "Extra High"), so requiring `\s` after the label missed
 * every match despite "Instant" being the checked/current item.
 */
function intelligenceLabelPattern(label) {
  return new RegExp(`^[^a-z]*${label}(?:[^a-z]|$)`, 'i');
}

const MODEL_LABEL = modelLabel('instant');

// Medium and High can spend materially longer reasoning before they start
// streaming the final answer. The legacy CHATGPT_TIMEOUT_MS remains a global
// override; level-specific overrides take precedence when supplied.
const DEFAULT_REQUEST_TIMEOUT_MS = Object.freeze({
  instant: 300000,
  medium: 600000,
  high: 900000,
});

function requestTimeoutFor(value = 'instant') {
  const level = validateThinkingLevel(value);
  const specific = process.env[`CHATGPT_TIMEOUT_${level.toUpperCase()}_MS`];
  return Number(specific || process.env.CHATGPT_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS[level]);
}

const REQUEST_TIMEOUT_MS = requestTimeoutFor('instant');
// Headed mode (CHATGPT_HEADLESS=false) is the escape hatch if chatgpt.com
// ever challenges the headless browser.
const HEADLESS = process.env.CHATGPT_HEADLESS !== 'false';

// Base delay before every request; actual delay is jittered ±25% so a long
// run doesn't read as a metronome. See module header — this exists because
// ChatGPT's abuse detection tripped without it.
const REQUEST_DELAY_MS = Number(process.env.CHATGPT_REQUEST_DELAY_MS || 15000);
// Rate-limit backoff is a SEPARATE, more generous retry budget than the
// generic one-reload-retry below — a rate limit is expected to clear given
// enough time, unlike a genuine navigation/composer failure.
const RATE_LIMIT_MAX_RETRIES = Number(process.env.CHATGPT_RATE_LIMIT_MAX_RETRIES || 5);
const RATE_LIMIT_DEFAULT_BACKOFF_MS = Number(process.env.CHATGPT_RATE_LIMIT_BACKOFF_MS || 90000);
// How many consecutive ask() calls share one conversation before a fresh one
// is started. See module header for why this exists and how the value was
// chosen (comfortably under the observed ~16-conversation threshold).
const BATCHES_PER_CONVERSATION = Math.max(1, Number(process.env.CHATGPT_BATCHES_PER_CONVERSATION || 10));

// Completion-detection tuning for waitForResponseComplete(). These are about
// distinguishing "the model stopped writing" from "the model paused
// mid-sentence", so they are deliberately generous: capturing a truncated
// reply costs a whole wasted request, while waiting an extra second costs
// only that second.
const POLL_MS = Number(process.env.CHATGPT_POLL_MS || 400);
const QUIET_MS = Number(process.env.CHATGPT_QUIET_MS || 2500);
const STOP_HIDDEN_MAX_MS = Number(process.env.CHATGPT_STOP_HIDDEN_MAX_MS || 30000);
const RELAXED_QUIET_MS = Number(process.env.CHATGPT_RELAXED_QUIET_MS || 800);
const STUCK_QUIET_MS = Number(process.env.CHATGPT_STUCK_QUIET_MS || 20000);

const COMPOSER_SELECTOR = '#prompt-textarea, form div[contenteditable="true"]';
const LOGIN_SELECTOR = '[data-testid="login-button"], [data-testid="welcome-login-button"], button:has-text("Log in")';
const SEND_SELECTOR = '[data-testid="send-button"], button[aria-label="Send prompt"], form[data-chatgpt-composer] button[type="submit"][aria-label="Send"]';
const STOP_SELECTOR = '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label*="Stop"]';
// The current ChatGPT UI (2026-09) uses search-unit keys instead of the old
// author-role attribute. Keep both selectors so saved conversations and older
// UI variants still work.
const ASSISTANT_MSG_SELECTOR = '[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"]';

function assistantMessageText(message) {
  // The search unit includes a visible "ChatGPT said:" label. Return only the
  // reply body, which callers may parse as JSON. Legacy messages have no
  // markdown-text-style descendant and retain their original innerText.
  const markdown = message.querySelectorAll('[data-markdown-text-style="assistant-message"]');
  if (markdown.length) return Array.from(markdown, el => el.innerText || '').join('\n').trim();
  if (message.hasAttribute('data-chatgpt-search-unit-key')) return '';
  return (message.innerText || '').trim();
}

async function lastAssistantMessageText(messages) {
  return messages.last().evaluate(assistantMessageText).catch(() => '');
}
// Confirmed in production (2026-09): the composer's "Add files and more"
// button (`data-testid="composer-plus-btn"`) ALSO carries `aria-haspopup="menu"`
// and sits earlier in DOM order than the reasoning-tier picker button — so a
// bare `form button[aria-haspopup="menu"]` fallback's `.first()` can silently
// click the wrong button (the attach-file menu, not the picker).
// `:not([data-testid="composer-plus-btn"])` excludes it. This selector is now
// only a fallback: openPicker() below tries the "Thinking effort" keyboard
// shortcut (Ctrl+Shift+M, shown in the button's own tooltip) first, since a
// keyboard shortcut is not tied to which button DOM order puts first.
const MODEL_PICKER_SELECTOR = '[data-testid="model-switcher-dropdown-button"], button[aria-label*="Model selector"], form button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"])';
const MENU_SELECTOR = '[role="menu"]';
// Wrapped in :is(...) so a suffix appended by string concatenation (e.g.
// `${MENU_ITEM_SELECTOR}[aria-haspopup="menu"]`) applies to BOTH roles.
// Without the :is() wrapper, concatenating a comma-separated selector list
// with a suffix only binds the suffix to the last comma-branch — the first
// branch silently loses the filter and matches far too broadly.
// `:not([data-trailing-button])` and `:visible` additionally exclude nested
// per-row trailing icon buttons that also carry role="menuitem"
// aria-haspopup="menu" but are hidden until their parent row is hovered.
const MENU_ITEM_SELECTOR = ':is([role="menuitem"], [role="menuitemradio"]):not([data-trailing-button]):visible';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sessionExpiredError() {
  return new Error(
    'ChatGPT session is missing or has expired — run the setup flow and log in again. '
    + '(If this keeps happening immediately after a fresh login, check network access to chatgpt.com instead.)'
  );
}

// Best-effort snapshot of what the page actually shows at the point of an
// otherwise-opaque failure. Never throws: diagnostics must not mask the real
// error.
async function capturePageDiagnostics(page) {
  const diag = await page.evaluate((selector) => {
    const assistantEls = document.querySelectorAll(selector);
    const last = assistantEls[assistantEls.length - 1];
    const markdown = last?.querySelectorAll('[data-markdown-text-style="assistant-message"]') || [];
    const lastText = markdown.length
      ? Array.from(markdown, el => el.innerText || '').join('\n').trim()
      : last?.hasAttribute('data-chatgpt-search-unit-key') ? '' : (last?.innerText || '').trim();
    return {
      title: document.title,
      bodySnippet: (document.body && document.body.innerText || '').trim().slice(0, 500),
      assistantMessageCount: assistantEls.length,
      lastAssistantMessage: last ? lastText.slice(0, 1500) : null,
    };
  }, ASSISTANT_MSG_SELECTOR).catch(err => ({ evalError: (err && err.message) || String(err) }));
  return { url: page.url(), ...diag };
}

// OpenAI's exact rate-limit wording drifts, so this matches broadly rather
// than pinning one string. A false positive just costs a wasted
// backoff-and-retry; a false negative falls through to the normal response
// timeout, which is also recoverable (see the caller's retry loop).
const RATE_LIMIT_TEXT_RE = /you.?ve (?:hit|reached).{0,80}(?:usage cap|message limit|rate limit|reasoning limit|weekly limit|model limit|limit for)|too many (?:messages|requests)|you.?re sending messages too (?:fast|quickly)|please slow down|rate.?limited|temporarily unavailable until|try again (?:in|after|later)/i;
const RATE_LIMIT_WAIT_RE = /(?:in|after)\s+(\d+)\s*(second|minute|hour)s?/i;
// Confirmed in production: ChatGPT shows a MODAL (not just a toast) when
// rate-limited, which sits over the composer and intercepts pointer events.
const RATE_LIMIT_MODAL_SELECTOR = '[data-testid="modal-conversation-history-rate-limit"], #modal-conversation-history-rate-limit';

class RateLimitError extends Error {
  constructor(snippet, waitMs) {
    super(`ChatGPT rate limit: "${snippet}"`);
    this.name = 'RateLimitError';
    this.waitMs = waitMs;
  }
}

function extractWaitMs(text) {
  const waitMatch = text.match(RATE_LIMIT_WAIT_RE);
  if (!waitMatch) return null;
  const n = Number(waitMatch[1]);
  const unit = waitMatch[2].toLowerCase();
  return unit === 'hour' ? n * 3600000 : unit === 'minute' ? n * 60000 : n * 1000;
}

async function checkRateLimit(page) {
  const modal = page.locator(RATE_LIMIT_MODAL_SELECTOR).first();
  if (await modal.isVisible().catch(() => false)) {
    const modalText = await modal.innerText().catch(() => 'rate-limit modal shown');
    return { snippet: modalText.slice(0, 200), waitMs: extractWaitMs(modalText) };
  }

  // Fallback: scan the page CHROME (not chat message content) for rate-limit
  // phrasing. Two false-positive traps, both hit in production, both guarded:
  //
  // 1. Message bubbles must be excluded — the regex's generic phrases (e.g.
  //    "try again later") can also appear inside a legitimate AI reply.
  // 2. innerText MUST be read from the LIVE, RENDERED body, not a detached
  //    clone — a clone degrades to textContent, pulling in inline JSON
  //    payloads that contain flag names like "rate_limited".
  const text = await page.evaluate((selector) => {
    let chromeText = document.body.innerText || '';
    for (const el of document.querySelectorAll(selector)) {
      const messageText = el.innerText;
      if (messageText) chromeText = chromeText.split(messageText).join('\n');
    }
    return chromeText;
  }, '[data-message-author-role], [data-chatgpt-search-unit-key]').catch(() => '');
  const match = text.match(RATE_LIMIT_TEXT_RE);
  if (!match) return null;
  return { snippet: match[0].slice(0, 200), waitMs: extractWaitMs(text) };
}

/** Is a saved ChatGPT Enterprise session available? (cheap, no browser) */
function isAvailable() {
  return chatgptSessionExists();
}

// Reasoning-tier labels that can appear as menuitemradio siblings of the
// model choices in today's single flat picker menu. Used to tell "this radio
// is a model" apart from "this radio is a tier" now that both live in the
// same group with no structural (role/nesting) difference between them —
// only the label text distinguishes them. Kept lowercase for comparison.
const KNOWN_TIER_LABELS = ['instant', 'medium', 'high', 'extra high', 'pro'];

function isKnownTierLabel(text) {
  return KNOWN_TIER_LABELS.includes(text.trim().toLowerCase());
}

/**
 * Best-effort model selection plus explicit reasoning-tier selection. Instant
 * keeps the historical fail-soft picker behavior; a requested Medium/High
 * level throws when unavailable so the run never silently uses a lower tier.
 */
async function selectLatestModel(page, thinkingLevel = 'instant') {
  const requestedLevel = validateThinkingLevel(thinkingLevel);
  const requestedLabel = thinkingLevelLabel(requestedLevel);
  const openPicker = async () => {
    // Primary: the "Thinking effort" keyboard shortcut. Robust against DOM
    // changes because it doesn't depend on which button matches a selector
    // first — see MODEL_PICKER_SELECTOR's comment for the exact failure this
    // sidesteps.
    try {
      await page.keyboard.press('Control+Shift+M');
      await page.locator(MENU_SELECTOR).first().waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch (_) {
      // Fall through to the click-based fallback below.
    }
    const picker = page.locator(MODEL_PICKER_SELECTOR).first();
    await picker.click({ timeout: 8000 });
    await page.locator(MENU_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 });
  };
  const closePicker = async () => {
    try { await page.keyboard.press('Escape'); await sleep(300); } catch (_) {}
  };

  // Pass 1: latest model = first menuitemradio in the picker whose label is
  // NOT a known reasoning-tier name. There is no longer a nested submenu to
  // open (see module header) — model and tier choices are flat siblings in
  // one group, so the "first item" a caller cares about is simply the first
  // one whose label isn't "Instant"/"Medium"/etc.
  try {
    await openPicker();
    const radios = page.locator(`${MENU_SELECTOR} [role="menuitemradio"]`);
    const radioCount = await radios.count();
    let modelItem = null;
    let modelLabelText = '';
    for (let i = 0; i < radioCount; i++) {
      const item = radios.nth(i);
      const text = (await item.innerText().catch(() => '')).split('\n')[0].trim();
      if (text && !isKnownTierLabel(text)) {
        modelItem = item;
        modelLabelText = text;
        break;
      }
    }
    if (modelItem) {
      const alreadySelected = (await modelItem.getAttribute('aria-checked').catch(() => null)) === 'true';
      if (!alreadySelected) {
        await modelItem.click({ timeout: 5000 });
        await sleep(400);
      }
      log.info({ 'event.action': 'chatgpt.model.selected', labels: { model: modelLabelText, alreadySelected } }, 'Selected latest ChatGPT model');
    } else {
      log.warn({ 'event.action': 'chatgpt.model.select.skipped' }, 'No model choice found in picker — continuing with the account default');
    }
    await closePicker();
  } catch (err) {
    log.warn({ err, 'event.action': 'chatgpt.model.select.failed' }, 'Could not select latest model — continuing with the account default');
    await closePicker();
  }

  // Pass 2: select the requested reasoning tier by its visible label.
  try {
    await openPicker();
    const items = page.locator(`${MENU_SELECTOR} ${MENU_ITEM_SELECTOR}`);
    const requested = items.filter({ hasText: intelligenceLabelPattern(requestedLabel) }).first();
    if (!(await requested.count())) {
      const available = await items.evaluateAll(els => els.map(el => (el.textContent || '').trim().slice(0, 60))).catch(() => []);
      throw Object.assign(
        new Error(`${requestedLabel} is not available in this workspace's ChatGPT model picker.`),
        { availableLabels: available }
      );
    }
    // Confirmed in production: a tier can be PRESENT in the menu but
    // `disabled` — this happens when the ChatGPT account/workspace has hit
    // its usage limit, not because of a stale selector.
    const isDisabled = await requested.evaluate(
      el => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
    ).catch(() => false);
    if (isDisabled) {
      throw new Error(
        `${requestedLabel} is shown in the ChatGPT picker but is disabled — this is usually the account/workspace `
        + `usage limit ("Usage limit reached" banner in the ChatGPT UI), not a bug. Wait for the limit to reset, or `
        + `use a lower tier, then try again.`
      );
    }
    const label = (await requested.innerText().catch(() => requestedLabel)).split('\n')[0].trim();
    await requested.click({ timeout: 5000 });
    log.info({ 'event.action': 'chatgpt.intelligence.selected', labels: { intelligence: label } }, 'Selected requested reasoning tier');
    await sleep(400);
  } catch (err) {
    log.warn(
      { err, 'event.action': 'chatgpt.intelligence.select.failed', labels: { requestedLevel, availableLabels: err.availableLabels || [] } },
      'Could not select requested reasoning tier'
    );
    await closePicker();
    // Instant retains the historical fail-soft behavior. Medium/High are an
    // explicit quality choice, so silently continuing at another level would
    // misrepresent the generated documents to the caller.
    if (requestedLevel !== 'instant') throw err;
  }
}

// Wait until the model has finished streaming its reply. See the original
// itassist-incident-extract module for the full production history behind
// each of these three exit paths — kept verbatim here.
async function waitForResponseComplete(page, timeoutMs, baseline) {
  const deadline = Date.now() + timeoutMs;
  const timeoutError = () => new Error('ChatGPT did not finish responding within the timeout.');

  async function poll() {
    const stop = page.locator(STOP_SELECTOR).first();
    const messages = page.locator(ASSISTANT_MSG_SELECTOR);

    await sleep(500);
    let limited = await checkRateLimit(page);
    if (limited) throw new RateLimitError(limited.snippet, limited.waitMs);

    let prevText = null;
    let lastChangeAt = Date.now();
    let stopHiddenAt = null;

    while (Date.now() < deadline) {
      const count = await messages.count().catch(() => 0);
      const text = await lastAssistantMessageText(messages);
      const stopVisible = await stop.isVisible().catch(() => false);
      const isNew = count > baseline.count || (!!text && text !== baseline.text);
      const now = Date.now();

      if (!isNew || !text) {
        prevText = null;
        lastChangeAt = now;
        stopHiddenAt = null;
      } else {
        if (text !== prevText) {
          prevText = text;
          lastChangeAt = now;
        }
        if (stopVisible) {
          stopHiddenAt = null;
          if (now - lastChangeAt >= STUCK_QUIET_MS) return text;
        } else {
          if (stopHiddenAt === null) stopHiddenAt = now;
          if (now - lastChangeAt >= QUIET_MS) return text;
          if (now - stopHiddenAt >= STOP_HIDDEN_MAX_MS && now - lastChangeAt >= RELAXED_QUIET_MS) return text;
        }
      }

      limited = await checkRateLimit(page);
      if (limited) throw new RateLimitError(limited.snippet, limited.waitMs);
      await sleep(POLL_MS);
    }
    throw timeoutError();
  }

  return Promise.race([
    poll(),
    new Promise((_, reject) => setTimeout(() => reject(timeoutError()), timeoutMs)),
  ]);
}

/**
 * Open an authenticated ChatGPT browser session.
 *
 * @returns {Promise<{ask: (prompt: string) => Promise<string>, close: () => Promise<void>}>}
 */
async function openSession(options = {}) {
  if (!isAvailable()) throw sessionExpiredError();
  const thinkingLevel = validateThinkingLevel(options.thinkingLevel);
  const requestTimeoutMs = requestTimeoutFor(thinkingLevel);

  const { browser } = await launchBrowser({
    preferredChannel: readChannel(PROFILE_DIR),
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  let context;
  let page;
  try {
    context = await browser.newContext({ storageState: CHATGPT_SESSION_STATE_PATH });
    page = await context.newPage();

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
    if (ua.includes('HeadlessChrome')) {
      await context.close();
      context = await browser.newContext({
        storageState: CHATGPT_SESSION_STATE_PATH,
        userAgent: ua.replace(/HeadlessChrome/g, 'Chrome'),
      });
      page = await context.newPage();
    }

    await gotoNewChat(page);
    await selectLatestModel(page, thinkingLevel);
  } catch (err) {
    try { await browser.close(); } catch (_) {}
    throw err;
  }

  let closed = false;
  let batchesSinceNewChat = 1;

  async function ask(prompt) {
    let reloadAttempts = 0;
    let rateLimitRetries = 0;
    let baseline = { count: 0, text: '' };
    for (;;) {
      await sleep(REQUEST_DELAY_MS * (0.75 + Math.random() * 0.5));
      try {
        const limitedBeforeAct = await checkRateLimit(page);
        if (limitedBeforeAct) throw new RateLimitError(limitedBeforeAct.snippet, limitedBeforeAct.waitMs);

        if (batchesSinceNewChat === 0) await gotoNewChat(page);
        batchesSinceNewChat = (batchesSinceNewChat + 1) % BATCHES_PER_CONVERSATION;

        const composer = page.locator(COMPOSER_SELECTOR).first();
        baseline = {
          count: await page.locator(ASSISTANT_MSG_SELECTOR).count().catch(() => 0),
          text: await lastAssistantMessageText(page.locator(ASSISTANT_MSG_SELECTOR)),
        };

        try {
          await composer.click({ timeout: 10000 });
          await composer.fill(prompt, { timeout: 15000 });

          const send = page.locator(SEND_SELECTOR).first();
          if (await send.count()) {
            await send.click({ timeout: 10000 });
          } else {
            await page.keyboard.press('Enter');
          }
        } catch (composeErr) {
          const limited = await checkRateLimit(page);
          if (limited) throw new RateLimitError(limited.snippet, limited.waitMs);
          throw composeErr;
        }

        return await waitForResponseComplete(page, requestTimeoutMs, baseline);
      } catch (err) {
        if (isSessionExpiredError(err) || closed) throw err;

        if (err instanceof RateLimitError) {
          rateLimitRetries++;
          if (rateLimitRetries > RATE_LIMIT_MAX_RETRIES) throw err;
          const backoff = err.waitMs != null ? err.waitMs + 2000 : RATE_LIMIT_DEFAULT_BACKOFF_MS * rateLimitRetries;
          log.warn(
            { err, 'event.action': 'chatgpt.rate_limited', labels: { retry: rateLimitRetries, backoffMs: backoff } },
            'ChatGPT rate-limited this request — backing off and retrying'
          );
          await sleep(backoff);
          batchesSinceNewChat = 0;
          continue;
        }

        reloadAttempts++;
        if (reloadAttempts >= 2) throw err;
        const diag = await capturePageDiagnostics(page);
        log.warn(
          {
            err,
            'event.action': 'chatgpt.ask.retry',
            labels: { ...diag, baselineCount: baseline.count, baselineTextLength: baseline.text.length },
          },
          'ChatGPT request failed — retrying once with a fresh page'
        );
        try { page = await context.newPage(); } catch (_) {}
        batchesSinceNewChat = 0;
      }
    }
  }

  async function close() {
    closed = true;
    try { await browser.close(); } catch (_) {}
  }

  return { ask, close };
}

function isSessionExpiredError(err) {
  return /session is missing or has expired/i.test((err && err.message) || '');
}

function isRateLimitError(err) {
  return err instanceof RateLimitError;
}

// Navigate to a fresh chat and confirm we are logged in (composer visible).
// A login screen instead means the saved session has expired.
async function gotoNewChat(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const composer = page.locator(COMPOSER_SELECTOR).first();
  const login = page.locator(LOGIN_SELECTOR).first();
  try {
    await Promise.race([
      composer.waitFor({ state: 'visible', timeout: 45000 }),
      login.waitFor({ state: 'visible', timeout: 45000 }),
    ]);
  } catch (_) {
    // Neither the chat composer nor a plain "Log in" button showed up within
    // the timeout. Confirmed in production (itassist-incident-extract): this
    // is usually NOT a network problem — it's a stale saved session landing
    // on something that matches neither selector (a partial SSO/IdP
    // redirect, an intermediate consent screen, a blank page while re-auth
    // silently fails). Treating this as an expired session instead of a
    // generic "network" error points at the actual next step (re-run setup)
    // in the overwhelming majority of real cases.
    const diag = await capturePageDiagnostics(page);
    log.error(
      { 'event.action': 'chatgpt.gotoNewChat.failed', labels: { ...diag, currentUrl: page.url() } },
      'ChatGPT did not reach the composer or login screen within the timeout — treating as a likely expired session'
    );
    throw sessionExpiredError();
  }
  const limited = await checkRateLimit(page);
  if (limited) throw new RateLimitError(limited.snippet, limited.waitMs);
  if (!(await composer.isVisible().catch(() => false))) throw sessionExpiredError();
}

module.exports = {
  isAvailable,
  openSession,
  isSessionExpiredError,
  isRateLimitError,
  validateThinkingLevel,
  thinkingLevelLabel,
  modelLabel,
  intelligenceLabelPattern,
  requestTimeoutFor,
  THINKING_LEVELS,
  MODEL_LABEL,
  BASE_URL,
  REQUEST_TIMEOUT_MS,
};
