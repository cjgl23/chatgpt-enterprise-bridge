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
 * Model selection: on session open we choose the requested Thinking effort
 * first, then open its model list and choose the first GPT model (the top
 * entry tracks whatever is newest, so no model name is hardcoded). Callers
 * default to "Instant"; a caller may request Medium or High.
 * The picker has changed shape several times, so selectLatestModel() handles
 * each one seen so far: the current "Select ChatGPT model" button with an
 * effort slider and a simple/advanced view toggle, an effort row that opens
 * a nested model submenu, and the 2026-09 flat menu where model and tier
 * choices were sibling `menuitemradio` items. A tier item can also be present
 * but `disabled` — confirmed in production this happens when the account has
 * hit its ChatGPT usage limit, not because of a selector mismatch — so that
 * case is reported with its own explicit error rather than timing out on an
 * unclickable element.
 * The model pick is fail-soft: if a selector no longer matches, we log and
 * continue with whatever model the account has selected — a usable answer
 * from the default model beats a failed run. Reasoning-tier selection for
 * Medium/High remains hard-fail (see selectLatestModel below) so a run never
 * silently misrepresents which tier actually produced a document.
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
const SEND_SELECTOR = '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]';
const STOP_SELECTOR = '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label*="Stop"]';
const ASSISTANT_MSG_SELECTOR = '[data-message-author-role="assistant"], [data-turn="assistant"], [data-role="assistant"], [data-testid="assistant-message"], [data-markdown-text-style="assistant-message"]';
const CHAT_MESSAGE_SELECTOR = '[data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-markdown-text-style], [data-message-author-role], [data-turn="assistant"], [data-turn="user"], [data-role="assistant"], [data-role="user"], [data-testid^="conversation-turn-"]';

// Use the same reader for baselines, polling and diagnostics. A turn wrapper
// and its legacy message child can both match; count each turn only once and
// read its content rather than its copy/share/feedback controls.
function assistantSnapshotInDocument(selector) {
  const seen = new Set();
  const messages = [];
  for (const el of document.querySelectorAll(selector)) {
    const turn = el.closest('[data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-testid^="conversation-turn-"], article') || el;
    if (turn.matches('[data-turn="user"], [data-role="user"]') ||
        el.closest('[data-message-author-role="user"]')) continue;
    if (seen.has(turn)) continue;
    seen.add(turn);
    const content = turn.querySelector('[data-message-author-role="assistant"], [data-testid="assistant-message"], [data-markdown-text-style="assistant-message"], .markdown') || el;
    // A reply can be split across several sibling markdown blocks with no
    // legacy wrapper around them; reading only the first would hand back a
    // truncated reply. Join the top-level ones.
    const md = '[data-markdown-text-style="assistant-message"]';
    const blocks = content.matches(md)
      ? Array.from(turn.querySelectorAll(md)).filter(block => !block.parentElement.closest(md))
      : [];
    messages.push((blocks.length ? blocks : [content]).map(block => (block.innerText || '').trim()).join('\n').trim());
  }
  return { count: messages.length, text: messages.at(-1) || '' };
}

async function readAssistantSnapshot(page) {
  return page.evaluate(assistantSnapshotInDocument, ASSISTANT_MSG_SELECTOR);
}
// Confirmed in production (2026-09): the composer's "Add files and more"
// button (`data-testid="composer-plus-btn"`) ALSO carries `aria-haspopup="menu"`
// and sits earlier in DOM order than the reasoning-tier picker button — so the
// old bare `form button[aria-haspopup="menu"]` fallback's `.first()` silently
// clicked the wrong button (the attach-file menu, not the picker), and the
// picker never opened. `:not([data-testid="composer-plus-btn"])` excludes it.
// This is now only a fallback: openPicker() prefers the current dedicated
// model button, then the keyboard shortcut, before trying these legacy selectors.
const MODEL_PICKER_SELECTOR = '[data-testid="model-switcher-dropdown-button"], button[aria-label*="Model selector"], button[aria-label="Select ChatGPT model"], form button[aria-haspopup="menu"]:not([data-testid="composer-plus-btn"]), button[aria-label*="Thinking effort"]';
const MENU_SELECTOR = ':is([role="menu"], [data-radix-popper-content-wrapper]):visible';
// Wrapped in :is(...) so a suffix appended by string concatenation (e.g.
// `${MENU_ITEM_SELECTOR}[aria-haspopup="menu"]`) applies to BOTH roles.
// Without the :is() wrapper, concatenating a comma-separated selector list
// with a suffix only binds the suffix to the last comma-branch — the first
// branch silently loses the filter and matches far too broadly (this bit us:
// see chatgptClient bugfix history). `:not([data-trailing-button])` and
// `:visible` additionally exclude nested per-row trailing icon buttons (e.g.
// a "Pro effort options" control) that also carry role="menuitem"
// aria-haspopup="menu" but are hidden until their parent row is hovered.
const MENU_ITEM_SELECTOR = ':is([role="menuitem"], [role="menuitemradio"]):not([data-trailing-button]):not([inert] *):not([aria-hidden="true"] *):visible';

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
  const snapshot = await readAssistantSnapshot(page).catch(() => ({ count: 0, text: '' }));
  const diag = await page.evaluate(() => ({
    title: document.title,
    bodySnippet: (document.body && document.body.innerText || '').trim().slice(0, 500),
    turnAttributes: Array.from(document.querySelectorAll('[data-content-search-unit-key], article, [data-testid^="conversation-turn-"]')).slice(-4).map(el => ({
      role: el.getAttribute('data-message-author-role'), turn: el.getAttribute('data-turn'),
      dataRole: el.getAttribute('data-role'), testId: el.getAttribute('data-testid'),
      searchUnit: el.getAttribute('data-content-search-unit-key'),
      hasAssistantMarkdown: !!el.querySelector('[data-markdown-text-style="assistant-message"]'),
    })),
  })).catch(err => ({ evalError: (err && err.message) || String(err) }));
  diag.assistantMessageCount = snapshot.count;
  diag.lastAssistantMessage = snapshot.text.slice(0, 1500) || null;
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
  }, CHAT_MESSAGE_SELECTOR).catch(() => '');
  const match = text.match(RATE_LIMIT_TEXT_RE);
  if (!match) return null;
  return { snippet: match[0].slice(0, 200), waitMs: extractWaitMs(text) };
}

/** Is a saved ChatGPT Enterprise session available? (cheap, no browser) */
function isAvailable() {
  return chatgptSessionExists();
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
    // Current composer exposes a dedicated model button. Prefer it to the
    // shortcut, which can open a different picker view. Older UIs fall back
    // to the shortcut and then the legacy composer selector.
    const currentPicker = page.getByRole('button', { name: 'Select ChatGPT model', exact: true });
    if (await currentPicker.count()) {
      await currentPicker.click({ timeout: 8000 });
      await page.locator(MENU_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 });
      await sleep(400);
      return;
    }
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

  // Pass 1: select the requested reasoning tier by its visible label. Label
  // matching is more robust than relying on menu position now that callers
  // can request Medium or High.
  //
  // The label is anchored to the START of the item's text — not just a
  // word-boundary match — because "High" is a substring of "Extra High" and
  // an unanchored/word-boundary regex would match both. But the anchor must
  // tolerate leading non-letter noise (a checkmark glyph or visually-hidden
  // "Selected" text ahead of the label in DOM order for the currently-active
  // tier, which need not match its visual position) — confirmed in
  // production: a request for "Instant" failed to match even though it was
  // the checked/current item in the picker.
  try {
    await openPicker();
    // Committing the current model closes its list view. A checked item
    // still needs its selection callback; Escape alone preserves that view.
    const pickerView = page.locator('[data-model-picker-view]:visible').last();
    if (await pickerView.count() && await pickerView.getAttribute('data-model-picker-view') === 'advanced') {
      await page.locator(`${MENU_SELECTOR} [role="menuitemradio"][aria-checked="true"]:not([inert] *):visible`).first().click({ timeout: 5000 });
      await closePicker();
      await openPicker();
    }
    const slider = page.locator(':is([data-reasoning-slider="true"], [role="slider"]):not([inert] *):not([aria-hidden="true"] *)').first();
    if (await slider.count() && (await slider.getAttribute('data-reasoning-slider') || await slider.isVisible())) {
      await slider.focus();
      if (await slider.getAttribute('data-reasoning-slider')) {
        for (let i = 0; i < 10; i++) await slider.press('ArrowLeft');
      } else {
        await slider.press('Home');
      }
      await sleep(150);
      // Discover the label at each slider position; do not hardcode indexes
      // because workspaces expose different effort ranges (including Low).
      let matched = false;
      for (let i = 0; i < 10; i++) {
        const selected = await slider.getAttribute('aria-valuetext');
        const effortLabel = page.locator('[data-effort-only="true"]:visible').first();
        const visibleLabel = await effortLabel.count() ? await effortLabel.innerText()
          : await page.locator(MENU_SELECTOR).filter({ has: slider }).last().innerText();
        if (intelligenceLabelPattern(requestedLabel).test(selected || visibleLabel.trim())) {
          matched = true;
          break;
        }
        const before = await slider.getAttribute('aria-valuenow');
        await slider.press('ArrowRight');
        await sleep(150);
        if (before !== null && before === await slider.getAttribute('aria-valuenow')) break;
      }
      if (!matched) throw new Error(`Could not verify ${requestedLabel} in the Thinking effort slider.`);
      log.info({ 'event.action': 'chatgpt.intelligence.selected', labels: { intelligence: requestedLabel } }, 'Selected requested reasoning tier');
    } else {
      const items = page.locator(`${MENU_SELECTOR} ${MENU_ITEM_SELECTOR}`);
      const requested = items.filter({ hasText: intelligenceLabelPattern(requestedLabel) }).first();
      if (!(await requested.count())) {
        // Diagnostic: log what the picker actually shows so a mismatch here is
        // fixable from the log alone next time, without needing a screenshot.
        const available = await items.evaluateAll(els => els.map(el => (el.textContent || '').trim().slice(0, 60))).catch(() => []);
        throw Object.assign(
          new Error(`${requestedLabel} is not available in this workspace's ChatGPT model picker.`),
          { availableLabels: available }
        );
      }
      // Confirmed in production: a tier can be PRESENT in the menu but
      // `disabled` — this happens when the ChatGPT account/workspace has hit
      // its usage limit, not because of a stale selector. Detect this
      // explicitly so the failure is actionable (upgrade/wait for reset)
      // rather than reading as a generic timeout from clicking an unclickable
      // element.
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
    }
  } catch (err) {
    log.warn(
      { err, 'event.action': 'chatgpt.intelligence.select.failed', labels: { requestedLevel, availableLabels: err.availableLabels || [] } },
      'Could not select requested reasoning tier'
    );
    await closePicker();
    // Instant retains the historical fail-soft behavior. Medium/High are an
    // explicit quality choice, so silently continuing at another level would
    // misrepresent the generated documents to the user.
    if (requestedLevel !== 'instant') throw err;
  }
  // Choose the model AFTER effort: the current UI nests models beneath
  // the effort label. Keep the flat radio-list path for older workspaces.
  try {
    if (!(await page.locator(MENU_SELECTOR).count())) await openPicker();
    const submenu = page.locator(`${MENU_SELECTOR} ${MENU_ITEM_SELECTOR}`).filter({ hasText: intelligenceLabelPattern(requestedLabel) }).first();
    const effortButton = page.locator(MENU_SELECTOR).getByRole('button', { name: intelligenceLabelPattern(requestedLabel) }).last();
    const viewToggle = page.locator('[data-model-picker-view-toggle="true"]:not([inert] *):not([aria-hidden="true"] *):visible').first();
    const advancedView = page.locator('[data-model-picker-view="advanced"]:visible');
    if (!(await advancedView.count()) && await viewToggle.count()) {
      await viewToggle.focus();
      await viewToggle.press('Enter');
      await sleep(300);
    } else if (!(await advancedView.count()) && await submenu.count() && await submenu.getAttribute('aria-haspopup')) {
      await submenu.click({ timeout: 5000 });
    } else if (!(await advancedView.count()) && await effortButton.isVisible().catch(() => false)) {
      await effortButton.click({ timeout: 5000 });
    }
    const radios = page.locator(MENU_SELECTOR).locator(`${MENU_ITEM_SELECTOR}, button:not([inert] *):not([aria-hidden="true"] *):visible`);
    const radioCount = await radios.count();
    let modelItem = null;
    let modelLabelText = '';
    for (let i = 0; i < radioCount; i++) {
      const item = radios.nth(i);
      const text = (await item.innerText().catch(() => '')).split('\n')[0].trim();
      if (/^GPT[-\s]/i.test(text)) {
        modelItem = item;
        modelLabelText = text;
        break;
      }
    }
    if (modelItem) {
      const alreadySelected = (await modelItem.getAttribute('aria-checked').catch(() => null)) === 'true';
      await modelItem.click({ timeout: 5000 });
      await sleep(400);
      log.info({ 'event.action': 'chatgpt.model.selected', labels: { model: modelLabelText, alreadySelected } }, 'Selected latest ChatGPT model');
    } else {
      log.warn({ 'event.action': 'chatgpt.model.select.skipped' }, 'No model choice found in picker — continuing with the account default');
    }
    await closePicker();
  } catch (err) {
    log.warn({ err, 'event.action': 'chatgpt.model.select.failed' }, 'Could not select latest model — continuing with the account default');
    await closePicker();
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


    // A rate-limit toast can appear immediately after send, before any reply
    // starts streaming — give it a moment to render, then check.
    await sleep(500);
    let limited = await checkRateLimit(page);
    if (limited) throw new RateLimitError(limited.snippet, limited.waitMs);

    // Best-effort: confirm generation actually started before polling for
    // its end. If the stop button never appears within 15s — a fast reply,
    // DOM drift on this selector, or a rate limit that replaced the normal
    // flow entirely — fall straight through to the completion poll rather
    // than blocking here; that poll checks for a rate limit on every
    // iteration too.
    await stop.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});

    // Every poll first establishes NEWNESS, then applies the two done-signals
    // above. Newness exists because in a reused conversation `.last()` points
    // at the PREVIOUS turn's already-finished reply until the new bubble
    // mounts — returning that would hand back a complete, well-formed answer
    // belonging to a different cluster's prompt (confirmed in production).
    //
    // Newness is satisfied by EITHER a grown message count OR the last
    // message's text differing from what was there before we sent. Counting
    // alone is not enough: ChatGPT virtualizes long conversations, so an old
    // bubble can unmount as the new one mounts, leaving the count flat
    // forever. A count-only gate then blocks until the full timeout while the
    // answer is plainly visible in the browser — confirmed in production, with
    // the reply captured intact in this run's own retry diagnostics.
    // Completion is decided on how long the text has been QUIET, not on a
    // fixed number of consecutive equal polls. Poll-count comparisons capture
    // truncated replies: a mid-stream pause longer than the poll interval
    // makes two consecutive reads match while the model is still writing.
    // Confirmed in production — a run where the only change was this gate
    // opening earlier went from 1 to 6 unparseable (truncated) replies.
    let prevText = null;
    let lastChangeAt = Date.now();
    let stopHiddenAt = null;

    while (Date.now() < deadline) {
      const { count, text } = await readAssistantSnapshot(page);
      const stopVisible = await stop.isVisible().catch(() => false);
      const isNew = count > baseline.count || (!!text && text !== baseline.text);
      const now = Date.now();

      if (!isNew || !text) {
        // Still looking at the previous turn's reply — do not let its
        // (already stable) text start the quiet clock.
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
          // Rescue for reasoning-style models that keep a "thinking" control
          // on screen long after the visible answer is finished: accept the
          // reply once it has been completely unchanged for STUCK_QUIET_MS.
          if (now - lastChangeAt >= STUCK_QUIET_MS) return text;
        } else {
          if (stopHiddenAt === null) stopHiddenAt = now;
          // Normal path: streaming control gone AND the text has stopped
          // changing for QUIET_MS, so trailing tokens have flushed.
          if (now - lastChangeAt >= QUIET_MS) return text;
          // Backstop for cosmetic DOM churn that never lets the full quiet
          // window elapse. It still REQUIRES a quiet window, just a shorter
          // one — never a bare timer, which would fire mid-stream and
          // capture a partial reply.
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
        baseline = await readAssistantSnapshot(page);

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
  assistantSnapshotInDocument,
  readAssistantSnapshot,
  waitForResponseComplete,
  selectLatestModel,
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
