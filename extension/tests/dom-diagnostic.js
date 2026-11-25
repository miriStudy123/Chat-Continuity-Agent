// Chat Continuity Agent - DOM diagnostic (manual, privacy-safe).
//
// Purpose: collect evidence about the live page structure of ChatGPT, Claude
// or Gemini so that extractor selectors are fixed from facts, not guesses.
//
// How to use: open a conversation, press F12, open the Console tab, paste this
// whole file and press Enter. Copy the printed JSON back.
//
// Privacy: the output contains ONLY counts, attribute values and class names.
// It never prints message text. Text is read in memory only to count empty
// and duplicate messages.
(() => {
  const host = location.hostname;
  const platform =
    host === "chatgpt.com" || host === "chat.openai.com"
      ? "chatgpt"
      : host === "claude.ai"
        ? "claude"
        : host === "gemini.google.com"
          ? "gemini"
          : "unknown";

  // Copied from extension/content/*.js (each comma-separated part is counted).
  const chatgptParts = (role) => [
    `main [data-message-author-role="${role}"]`,
    `[role="main"] [data-message-author-role="${role}"]`,
    `[data-testid^="conversation-turn-"] [data-message-author-role="${role}"]`,
    `[data-testid^="conversation-turn-"][data-message-author-role="${role}"]`,
    `main [data-testid="${role}-message"]`,
    `[role="main"] [data-testid="${role}-message"]`,
    `[data-testid^="conversation-turn-"] [data-testid="${role}-message"]`,
    `[data-testid^="conversation-turn-"][data-testid="${role}-message"]`,
    // Fallback tier 1 (unscoped) and tier 2 (turn containers):
    `[data-message-author-role="${role}"]`,
    `[data-testid="${role}-message"]`,
    `[data-turn="${role}"]`,
  ];
  const currentSelectors = {
    chatgpt: { user: chatgptParts("user"), assistant: chatgptParts("assistant") },
    claude: {
      user: ['main [data-testid="user-message"]'],
      assistant: ['main [data-testid="assistant-message"]', "main .font-claude-response"],
    },
    gemini: {
      user: [
        'main [data-message-author-role="user"]',
        'main [data-test-id="user-query"]',
        "main .user-query-bubble-with-background",
      ],
      assistant: [
        'main [data-message-author-role="assistant"]',
        'main [data-test-id="model-response"]',
        "main .model-response-text",
      ],
    },
  }[platform] || {};

  // Candidate structures seen on these sites in the past. Counted only, so
  // the result shows which ones exist on the live page today.
  const candidates = [
    "main",
    '[role="main"]',
    "article",
    '[data-testid^="conversation-turn-"]',
    "[data-turn]",
    "[data-message-author-role]",
    "[data-message-id]",
    '[data-testid="user-message"]',
    "[data-is-streaming]",
    ".font-claude-response",
    ".font-claude-message",
    ".font-user-message",
    "user-query",
    "model-response",
    "message-content",
    '[data-test-id="user-query"]',
    '[data-test-id="model-response"]',
  ];

  const count = (selector) => {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return "invalid selector";
    }
  };
  const valuesOf = (attribute) => {
    const values = {};
    for (const element of document.querySelectorAll(`[${attribute}]`)) {
      // Digits are masked so IDs such as conversation-turn-12 group together.
      const value = element.getAttribute(attribute).replace(/\d+/g, "#").slice(0, 60);
      values[value] = (values[value] || 0) + 1;
    }
    return values;
  };
  const messageLikeClasses = () => {
    const classes = {};
    for (const element of document.querySelectorAll("main [class]")) {
      for (const name of element.classList) {
        if (/message|response|query|turn|prose|markdown/i.test(name)) {
          classes[name] = (classes[name] || 0) + 1;
        }
      }
    }
    return Object.fromEntries(
      Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 40),
    );
  };

  const roles = {};
  for (const [role, parts] of Object.entries(currentSelectors)) {
    const elements = [...new Set(parts.flatMap((part) => [...document.querySelectorAll(part)]))];
    const outermost = elements.filter(
      (element) => !elements.some((other) => other !== element && other.contains(element)),
    );
    const texts = outermost.map((element) => (element.innerText || "").trim());
    const seen = new Map();
    for (const text of texts) seen.set(text, (seen.get(text) || 0) + 1);
    roles[role] = {
      perSelector: Object.fromEntries(parts.map((part) => [part, count(part)])),
      matchedElements: elements.length,
      afterNestingFilter: outermost.length,
      emptyText: texts.filter((text) => !text).length,
      duplicateTexts: [...seen.values()].filter((n) => n > 1).reduce((a, n) => a + n - 1, 0),
      outsideMain: outermost.filter((element) => !element.closest("main")).length,
      tagNames: [...new Set(outermost.map((element) => element.tagName.toLowerCase()))],
    };
  }

  const report = {
    platform,
    path: location.pathname.replace(/[0-9a-f-]{8,}/gi, "<id>"),
    currentSelectors: roles,
    candidateCounts: Object.fromEntries(candidates.map((s) => [s, count(s)])),
    attributeValues: {
      "data-message-author-role": valuesOf("data-message-author-role"),
      "data-turn": valuesOf("data-turn"),
      "data-testid": valuesOf("data-testid"),
      "data-test-id": valuesOf("data-test-id"),
    },
    messageLikeClassesInMain: messageLikeClasses(),
    scroll: (() => {
      const scrollers = [...document.querySelectorAll("main *")].filter(
        (element) => element.scrollHeight > element.clientHeight + 50 &&
          /(auto|scroll)/.test(getComputedStyle(element).overflowY),
      );
      return scrollers.slice(0, 3).map((element) => ({
        scrollTop: Math.round(element.scrollTop),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }));
    })(),
  };
  // --- Structure discovery (added for pages that match no known selector).
  // Values are printed only for these structural attributes; for every other
  // attribute only its NAME is printed, because values (aria-label, title...)
  // can contain conversation text.
  const valueAttributes = new Set([
    "role",
    "data-testid",
    "data-test-id",
    "data-turn",
    "data-message-author-role",
    "data-scroll-anchor",
    "dir",
  ]);
  const describe = (element) => {
    const attributes = [...element.attributes]
      .filter((attribute) => attribute.name !== "class" && attribute.name !== "style")
      .map((attribute) =>
        valueAttributes.has(attribute.name)
          ? `${attribute.name}=${attribute.value.replace(/\d+/g, "#").slice(0, 40)}`
          : attribute.name,
      );
    const classes = [...element.classList].slice(0, 4).map((name) => "." + name);
    return [element.tagName.toLowerCase(), ...classes, ...attributes.map((a) => `[${a}]`)]
      .join("");
  };
  const outline = (element, depth) => ({
    el: describe(element),
    children: element.children.length,
    ...(depth > 0 && element.children.length
      ? { first: [...element.children].slice(0, 6).map((child) => outline(child, depth - 1)) }
      : {}),
  });
  // Length of text directly inside an element (not in its children).
  const ownTextLength = (element) =>
    [...element.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .reduce((total, node) => total + node.textContent.trim().length, 0);
  const pathOf = (element) => {
    const parts = [];
    for (let node = element; node && node !== document.body && parts.length < 10; node = node.parentElement) {
      parts.unshift(describe(node));
    }
    return parts.join(" > ");
  };
  const textHolders = (() => {
    const groups = new Map();
    for (const element of document.body.querySelectorAll("*")) {
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) continue;
      const length = ownTextLength(element);
      if (length < 20) continue;
      const path = pathOf(element);
      const group = groups.get(path) || { path, elements: 0, totalTextLength: 0 };
      group.elements += 1;
      group.totalTextLength += length;
      groups.set(path, group);
    }
    return [...groups.values()]
      .sort((a, b) => b.totalTextLength - a.totalTextLength)
      .slice(0, 12);
  })();
  report.discovery = {
    mains: [...document.querySelectorAll("main")].map((main) => ({
      textLength: (main.innerText || "").length,
      outline: outline(main, 5),
    })),
    conversationTurns: [...document.querySelectorAll('[data-testid^="conversation-turn-"]')]
      .slice(0, 2)
      .map((turn) => ({
        insideMain: Boolean(turn.closest("main")),
        textLength: (turn.innerText || "").length,
        outline: outline(turn, 6),
      })),
    textHolders,
    hidden: {
      openShadowRoots: [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).length,
      iframes: [...document.querySelectorAll("iframe")].map((frame) => {
        try {
          return new URL(frame.src, location.href).hostname || "(no src)";
        } catch {
          return "(invalid src)";
        }
      }),
    },
    bodyTextLength: (document.body.innerText || "").length,
  };

  const json = JSON.stringify(report, null, 2);
  console.log(json);
  try {
    // DevTools console utility: puts the report on the clipboard.
    copy(json);
    return "Diagnostic printed above and copied to the clipboard. No message text.";
  } catch {
    return "Diagnostic printed above. It contains counts only, no message text.";
  }
})();
