const test = require('node:test');
const assert = require('node:assert/strict');

const chatgpt = require('../src/chatgptClient');

test('ChatGPT thinking-level helpers preserve Instant as the default', () => {
  assert.equal(chatgpt.validateThinkingLevel(), 'instant');
  assert.equal(chatgpt.thinkingLevelLabel(), 'Instant');
  assert.equal(chatgpt.modelLabel(), 'ChatGPT Enterprise (latest model, Instant)');
  assert.equal(chatgpt.modelLabel('medium'), 'ChatGPT Enterprise (latest model, Medium)');
  assert.equal(chatgpt.modelLabel('HIGH'), 'ChatGPT Enterprise (latest model, High)');
  assert.throws(() => chatgpt.validateThinkingLevel('pro'), /Instant, Medium, or High/);
});

test('intelligenceLabelPattern matches the label at the start, ignoring leading non-letter noise', () => {
  const instant = chatgpt.intelligenceLabelPattern('Instant');
  // The plain, un-decorated menu item text.
  assert.match('Instant', instant);
  // Confirmed in production: the picker's real text is "Instant5.5" — a
  // version number directly abutting the label with NO whitespace between
  // them (unlike the genuinely two-word "Extra High").
  assert.match('Instant5.5', instant);
  // Also tolerate a space, in case the DOM structure varies by tier/build.
  assert.match('Instant  5.5', instant);
  // Confirmed in production: a checkmark/hidden "Selected" text node can
  // precede the label in DOM order for the currently-active tier, even
  // though it renders visually after the label.
  assert.match('✓ Instant5.5', instant);
  assert.doesNotMatch('Not Instant', instant);
});

test('intelligenceLabelPattern disambiguates "High" from "Extra High"', () => {
  const high = chatgpt.intelligenceLabelPattern('High');
  assert.match('High', high);
  assert.doesNotMatch('Extra High', high);

  const extraHigh = chatgpt.intelligenceLabelPattern('Extra High');
  assert.match('Extra High', extraHigh);
  assert.doesNotMatch('High', extraHigh);
});

test('response timeouts expand for reasoning levels while supporting overrides', () => {
  const keys = [
    'CHATGPT_TIMEOUT_MS',
    'CHATGPT_TIMEOUT_INSTANT_MS',
    'CHATGPT_TIMEOUT_MEDIUM_MS',
    'CHATGPT_TIMEOUT_HIGH_MS',
  ];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    assert.equal(chatgpt.requestTimeoutFor('instant'), 300000);
    assert.equal(chatgpt.requestTimeoutFor('medium'), 600000);
    assert.equal(chatgpt.requestTimeoutFor('high'), 900000);

    process.env.CHATGPT_TIMEOUT_MS = '420000';
    process.env.CHATGPT_TIMEOUT_HIGH_MS = '1200000';
    assert.equal(chatgpt.requestTimeoutFor('medium'), 420000);
    assert.equal(chatgpt.requestTimeoutFor('high'), 1200000);
  } finally {
    for (const key of keys) {
      if (original[key] == null) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});

function messageNode(text, { turn = null, content = null, user = false } = {}) {
  return {
    innerText: text,
    closest(selector) {
      if (selector.includes('conversation-turn')) return turn;
      if (selector.includes('author-role="user"')) return user ? this : null;
      return null;
    },
    matches() { return user; },
    querySelector() { return content; },
  };
}

function snapshot(nodes) {
  const previous = global.document;
  global.document = { querySelectorAll: () => nodes };
  try { return chatgpt.assistantSnapshotInDocument('fixture'); }
  finally {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  }
}

test('response reader handles assistant turn wrappers without the legacy attribute', () => {
  const markdown = messageNode('{"title":"IVR hours"}');
  const turn = messageNode('response and feedback controls', { content: markdown });
  assert.deepEqual(snapshot([turn]), { count: 1, text: '{"title":"IVR hours"}' });
});

test('response reader counts nested legacy content and assistant wrapper as one turn', () => {
  const content = messageNode('{"title":"new response"}');
  const turn = messageNode('wrapper plus controls', { content });
  content.closest = selector => selector.includes('conversation-turn') ? turn : null;
  assert.deepEqual(snapshot([turn, content]), { count: 1, text: '{"title":"new response"}' });
});

test('response reader excludes user messages and returns the latest assistant reply', () => {
  const user = messageNode('user prompt containing JSON', { user: true });
  assert.deepEqual(snapshot([messageNode('old reply'), user, messageNode('new reply')]), {
    count: 2, text: 'new reply',
  });
  assert.deepEqual(snapshot([]), { count: 0, text: '' });
});

test('response reader joins a reply split across sibling markdown blocks', () => {
  const md = '[data-markdown-text-style="assistant-message"]';
  const block = text => ({
    innerText: text,
    matches: selector => selector === md,
    parentElement: { closest: () => null },
  });
  const blocks = [block('first block'), block('second block')];
  const turn = messageNode('ChatGPT said: first block second block Copy', { content: blocks[0] });
  turn.querySelectorAll = () => blocks;
  assert.deepEqual(snapshot([turn]), { count: 1, text: 'first block\nsecond block' });
});
