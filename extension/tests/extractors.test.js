const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

function createExtractor(platform, selectorElements) {
  // Like Chrome, keep every onMessage listener and offer each message to all
  // of them; the first that keeps the channel open (returns true) answers.
  const callbacks = [];
  const listener = {
    callback(message, sender, sendResponse) {
      return callbacks.some((callback) => callback(message, sender, sendResponse) === true);
    },
  };
  const document = {
    querySelectorAll(selector) {
      return typeof selectorElements === "function"
        ? selectorElements(selector)
        : selectorElements[selector] || [];
    },
  };
  const context = {
    document,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    chrome: {
      runtime: {
        id: "synthetic-extension-id",
        onMessage: {
          addListener(callback) {
            callbacks.push(callback);
          },
        },
      },
    },
    setTimeout,
  };
  context.globalThis = context;

  for (const file of [
    "content/shared.js",
    `content/${platform}.js`,
  ]) {
    vm.runInNewContext(
      fs.readFileSync(path.join(extensionPath, file), "utf8"),
      context,
      { filename: file },
    );
  }

  return {
    extractor: context.ChatContinuityExtractors[platform],
    listener: listener.callback,
    extensionId: context.chrome.runtime.id,
  };
}

async function runExtractor(platform, selectorElements) {
  return createExtractor(platform, selectorElements).extractor();
}

const OUTSIDE_SIDEBAR = ":not(nav *):not(aside *)";
const CHATGPT_CURRENT_USER = [
  `.bg-user-message${OUTSIDE_SIDEBAR}`,
  `.text-user-message${OUTSIDE_SIDEBAR}`,
  `[class~="group/user-message"]:not(:has(.bg-user-message, .text-user-message))${OUTSIDE_SIDEBAR}`,
].join(", ");
const CHATGPT_CURRENT_ASSISTANT =
  `[data-content-search-unit-key][data-chatgpt-search-unit-key] > div[data-response-body]${OUTSIDE_SIDEBAR}`;

function chatGPTSelector(role) {
  return [
    `main [data-message-author-role="${role}"]`,
    `[role="main"] [data-message-author-role="${role}"]`,
    `[data-testid^="conversation-turn-"] [data-message-author-role="${role}"]`,
    `[data-testid^="conversation-turn-"][data-message-author-role="${role}"]`,
    `main [data-testid="${role}-message"]`,
    `[role="main"] [data-testid="${role}-message"]`,
    `[data-testid^="conversation-turn-"] [data-testid="${role}-message"]`,
    `[data-testid^="conversation-turn-"][data-testid="${role}-message"]`,
    role === "user" ? CHATGPT_CURRENT_USER : CHATGPT_CURRENT_ASSISTANT,
  ].join(", ");
}

function element(text, documentIndex) {
  return {
    innerText: text,
    textContent: text,
    contains() {
      return false;
    },
    compareDocumentPosition(other) {
      return documentIndex < other.documentIndex ? 4 : 2;
    },
    documentIndex,
  };
}

const fixtures = [
  {
    platform: "chatgpt",
    selectors: {
      [chatGPTSelector("user")]: [
        element("שאלה 1", 0),
        element("שאלה 2", 2),
      ],
      [chatGPTSelector("assistant")]: [element("תשובה 1", 1)],
    },
  },
  {
    platform: "claude",
    selectors: {
      'main [data-testid="user-message"]': [element("בקשה", 0)],
      'main [data-testid="assistant-message"], main .font-claude-response': [
        element("תשובה", 1),
      ],
    },
  },
  {
    platform: "gemini",
    selectors: {
      'main [data-message-author-role="user"], main [data-test-id="user-query"], main .user-query-bubble-with-background':
        [element("שאלה", 0)],
      'main [data-message-author-role="assistant"], main [data-test-id="model-response"], main .model-response-text':
        [element("תשובה", 1)],
    },
  },
];

for (const fixture of fixtures) {
  test(`${fixture.platform} extractor preserves message roles and order`, async () => {
    const result = await runExtractor(fixture.platform, fixture.selectors);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify(
          result.messages.map(({ role, text }) => [role, text]),
        ),
      ),
      fixture.platform === "chatgpt"
        ? [
            ["user", "שאלה 1"],
            ["assistant", "תשובה 1"],
            ["user", "שאלה 2"],
          ]
        : [
            ["user", fixture.platform === "claude" ? "בקשה" : "שאלה"],
            ["assistant", "תשובה"],
          ],
    );
    assert.match(result.warning, /ייתכן שחלק מהשיחה לא נטען/);
  });
}

test("ChatGPT waits briefly for messages that appear after the popup is clicked", async () => {
  const userMessage = element("Synthetic user message", 0);
  const assistantMessage = element("Synthetic assistant message", 1);
  let messagesLoaded = false;
  const extractor = createExtractor("chatgpt", (selector) => {
    if (!messagesLoaded) return [];
    if (selector === chatGPTSelector("user")) return [userMessage];
    if (selector === chatGPTSelector("assistant")) return [assistantMessage];
    return [];
  });
  setTimeout(() => {
    messagesLoaded = true;
  }, 100);

  const result = await new Promise((resolve) => {
    const channelKeptOpen = extractor.listener(
      { type: "collect-conversation", platform: "chatgpt" },
      { id: extractor.extensionId },
      resolve,
    );
    assert.equal(channelKeptOpen, true);
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(result.messages.map(({ role }) => role)),
    ),
    ["user", "assistant"],
  );
});

test("Gemini waits briefly for messages that appear after the popup is clicked", async () => {
  const userSelector =
    'main [data-message-author-role="user"], main [data-test-id="user-query"], main .user-query-bubble-with-background';
  const assistantSelector =
    'main [data-message-author-role="assistant"], main [data-test-id="model-response"], main .model-response-text';
  const userMessage = element("Synthetic user message", 0);
  const assistantMessage = element("Synthetic assistant message", 1);
  let messagesLoaded = false;
  const extractor = createExtractor("gemini", (selector) => {
    if (!messagesLoaded) return [];
    if (selector === userSelector) return [userMessage];
    if (selector === assistantSelector) return [assistantMessage];
    return [];
  });
  setTimeout(() => {
    messagesLoaded = true;
  }, 100);

  const result = await new Promise((resolve) => {
    const channelKeptOpen = extractor.listener(
      { type: "collect-conversation", platform: "gemini" },
      { id: extractor.extensionId },
      resolve,
    );
    assert.equal(channelKeptOpen, true);
  });
  assert.equal(result.ok, true);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(result.messages.map(({ role }) => role)),
    ),
    ["user", "assistant"],
  );
});

test("content script returns a safe error type when collection throws", async () => {
  const extractor = createExtractor("chatgpt", () => {
    throw new TypeError("Synthetic private text");
  });
  const result = await new Promise((resolve) => {
    extractor.listener(
      { type: "collect-conversation", platform: "chatgpt" },
      { id: extractor.extensionId },
      resolve,
    );
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /TypeError/);
  assert.doesNotMatch(result.error, /Synthetic private text/);
});

test("extractors report a warning for long visible conversations", async () => {
  const users = [];
  const assistants = [];
  for (let index = 0; index < 1200; index += 1) {
    (index % 2 === 0 ? users : assistants).push(
      element(`synthetic message ${index}`, index),
    );
  }

  const result = await runExtractor("chatgpt", {
    [chatGPTSelector("user")]: users,
    [chatGPTSelector("assistant")]: assistants,
  });
  assert.equal(result.messages.length, 1200);
  assert.match(result.warning, /רק הודעות שמופיעות כרגע בעמוד/);
});

test("popup renders conversation-derived text without using HTML injection", () => {
  const popup = fs.readFileSync(
    path.join(extensionPath, "popup.js"),
    "utf8",
  );
  assert.match(popup, /elements\.summary\.textContent/);
  assert.match(popup, /elements\.prompt\.textContent/);
  assert.doesNotMatch(popup, /\.innerHTML\s*=/);
});

// --- ChatGPT fallback tiers (used only when the original selectors match nothing)

function chatGPTUnscopedSelector(role) {
  return [
    `[data-message-author-role="${role}"]`,
    `[data-testid="${role}-message"]`,
  ].join(", ");
}

async function collectChatGPT(selectorElements) {
  const { listener, extensionId } = createExtractor("chatgpt", selectorElements);
  return new Promise((resolve) => {
    listener(
      { type: "collect-conversation", platform: "chatgpt" },
      { id: extensionId },
      resolve,
    );
  });
}

function rolesAndTexts(messages) {
  return JSON.parse(JSON.stringify(messages.map(({ role, text }) => [role, text])));
}

test("ChatGPT finds messages outside <main> and keeps user/assistant order", async () => {
  const result = await collectChatGPT({
    [chatGPTUnscopedSelector("user")]: [
      element("שאלה ראשונה", 0),
      element("שאלה שנייה", 2),
    ],
    [chatGPTUnscopedSelector("assistant")]: [
      element("תשובה ראשונה", 1),
      element("תשובה שנייה", 3),
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.platform, "chatgpt");
  assert.deepEqual(rolesAndTexts(result.messages), [
    ["user", "שאלה ראשונה"],
    ["assistant", "תשובה ראשונה"],
    ["user", "שאלה שנייה"],
    ["assistant", "תשובה שנייה"],
  ]);
});

test("ChatGPT falls back to data-turn containers in document order", async () => {
  const result = await collectChatGPT({
    '[data-turn="user"]': [element("Synthetic Q1", 0), element("Synthetic Q2", 2)],
    '[data-turn="assistant"]': [element("Synthetic A1", 1)],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(rolesAndTexts(result.messages), [
    ["user", "Synthetic Q1"],
    ["assistant", "Synthetic A1"],
    ["user", "Synthetic Q2"],
  ]);
});

test("ChatGPT prefers the original selectors over the fallback tiers", async () => {
  const queried = [];
  const primaryUser = element("Primary user", 0);
  const primaryAssistant = element("Primary assistant", 1);
  const result = await collectChatGPT((selector) => {
    queried.push(selector);
    if (selector === chatGPTSelector("user")) return [primaryUser];
    if (selector === chatGPTSelector("assistant")) return [primaryAssistant];
    if (selector.startsWith("[data-turn=")) return [element("Turn text", 5)];
    return [];
  });
  assert.deepEqual(rolesAndTexts(result.messages), [
    ["user", "Primary user"],
    ["assistant", "Primary assistant"],
  ]);
  assert.equal(queried.some((selector) => selector.startsWith("[data-turn=")), false);
});

test("ChatGPT without messages reports structure counts only, never text", async () => {
  const result = await collectChatGPT((selector) => {
    if (selector === "main") return [element("Private page text", 0)];
    if (selector === '[data-testid^="conversation-turn-"]') {
      return [element("Private turn text", 1), element("Private turn text", 2)];
    }
    return [];
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ChatGPTNoMessages/);
  assert.match(result.error, /main=1/);
  assert.match(result.error, /turn-testid=2/);
  assert.match(result.error, /author-role=0/);
  assert.doesNotMatch(result.error, /Private/);
});

// --- Current ChatGPT structure (from the live DOM diagnostic, 2026-11-25).
// The mock document answers only the exact selectors the collector uses, so
// these tests check that the collector asks for the observed structure and
// keeps role, order and de-duplication. Real CSS matching (including :has,
// :not(nav *) and the "/" class) is checked separately in a real browser.

test("ChatGPT collects the current user bubbles and assistant response bodies in order", async () => {
  const result = await collectChatGPT({
    [chatGPTSelector("user")]: [element("שאלה 1", 0), element("שאלה 2", 2)],
    [chatGPTSelector("assistant")]: [element("תשובה 1", 1), element("תשובה 2", 3)],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(rolesAndTexts(result.messages), [
    ["user", "שאלה 1"],
    ["assistant", "תשובה 1"],
    ["user", "שאלה 2"],
    ["assistant", "תשובה 2"],
  ]);
});

test("ChatGPT current-structure selectors exclude the sidebar and target the observed elements", () => {
  // Split on top-level commas only (not the one inside :has(...)).
  const topLevelParts = CHATGPT_CURRENT_USER.split(/, (?![^(]*\))/);
  assert.equal(topLevelParts.length, 3);
  for (const part of topLevelParts.concat(CHATGPT_CURRENT_ASSISTANT)) {
    assert.ok(part.endsWith(OUTSIDE_SIDEBAR), part);
  }
  assert.match(CHATGPT_CURRENT_ASSISTANT, /^\[data-content-search-unit-key\]\[data-chatgpt-search-unit-key\] > div\[data-response-body\]/);
  assert.match(CHATGPT_CURRENT_USER, /\.bg-user-message/);
  // The outer group/user-message wrapper is used only without an inner bubble.
  assert.match(CHATGPT_CURRENT_USER, /group\/user-message"\]:not\(:has\(/);
});

test("ChatGPT does not count a message twice when a bubble and its inner text both match", async () => {
  const bubble = element("Synthetic question", 0);
  const innerText = element("Synthetic question", 0);
  bubble.contains = (other) => other === innerText;
  const result = await collectChatGPT({
    [chatGPTSelector("user")]: [bubble, innerText],
    [chatGPTSelector("assistant")]: [element("Synthetic answer", 1)],
  });
  assert.deepEqual(rolesAndTexts(result.messages), [
    ["user", "Synthetic question"],
    ["assistant", "Synthetic answer"],
  ]);
});

// The earlier turn-count warning was removed: each ChatGPT turn holds two
// messages and turns outside the viewport are removed entirely, so comparing
// turns with messages never detected missing history. Visible collection now
// points to full collection when the thread scrolls (checked in the real
// browser test, where scrolling exists); without a scroll area, no hint.
test("ChatGPT visible collection adds no long-conversation hint when nothing scrolls", async () => {
  const turns = [0, 1, 2, 3, 4, 5].map((index) => element("", index));
  const result = await collectChatGPT((selector) => {
    if (selector === chatGPTSelector("user")) return [element("Q", 4)];
    if (selector === chatGPTSelector("assistant")) return [element("A", 5)];
    if (selector === "[data-turn-key]") return turns;
    return [];
  });
  assert.equal(result.ok, true);
  assert.equal(result.messages.length, 2);
  assert.doesNotMatch(result.warning, /איסוף שיחה מלאה|תורות שיחה/);
});

test("ChatGPT adds no virtualization warning when every marked turn was collected", async () => {
  const result = await collectChatGPT((selector) => {
    if (selector === chatGPTSelector("user")) return [element("Q", 0)];
    if (selector === chatGPTSelector("assistant")) return [element("A", 1)];
    if (selector === "[data-turn-key]") return [element("", 0), element("", 1)];
    return [];
  });
  assert.doesNotMatch(result.warning, /תורות שיחה/);
});

test("ChatGPT empty-result evidence includes the current structure counts", async () => {
  const result = await collectChatGPT((selector) => {
    if (selector === "[data-turn-key]") return [element("x", 0), element("x", 1)];
    if (selector === "[data-response-body]") return [element("Private", 1)];
    return [];
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /response-body=1/);
  assert.match(result.error, /turn-key=2/);
  assert.match(result.error, /user-bubble=0/);
  assert.doesNotMatch(result.error, /Private/);
});
