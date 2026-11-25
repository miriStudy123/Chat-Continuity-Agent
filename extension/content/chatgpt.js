(() => {
  const chatGPTMessageSelector = (role) =>
    [
      `main [data-message-author-role="${role}"]`,
      `[role="main"] [data-message-author-role="${role}"]`,
      `[data-testid^="conversation-turn-"] [data-message-author-role="${role}"]`,
      `[data-testid^="conversation-turn-"][data-message-author-role="${role}"]`,
      `main [data-testid="${role}-message"]`,
      `[role="main"] [data-testid="${role}-message"]`,
      `[data-testid^="conversation-turn-"] [data-testid="${role}-message"]`,
      `[data-testid^="conversation-turn-"][data-testid="${role}-message"]`,
    ].join(", ");

  // Current ChatGPT structure, taken from the live DOM diagnostic (2026-11-25):
  // - user messages: a bubble with the classes bg-user-message /
  //   text-user-message inside a "group/user-message" wrapper;
  // - assistant messages: div[data-response-body] directly inside an element
  //   that has both data-content-search-unit-key and
  //   data-chatgpt-search-unit-key.
  // Every selector excludes <nav> and <aside> so sidebar conversation titles
  // are never collected.
  const outsideSidebar = ":not(nav *):not(aside *)";
  const currentUserSelector = [
    // The bubble holds only the message text, not the edit/copy buttons.
    `.bg-user-message${outsideSidebar}`,
    `.text-user-message${outsideSidebar}`,
    // The wrapper is used only when it has no bubble inside it.
    `[class~="group/user-message"]:not(:has(.bg-user-message, .text-user-message))${outsideSidebar}`,
  ].join(", ");
  const currentAssistantSelector =
    `[data-content-search-unit-key][data-chatgpt-search-unit-key] > div[data-response-body]${outsideSidebar}`;

  const messageSelector = (role) =>
    [
      chatGPTMessageSelector(role),
      role === "user" ? currentUserSelector : currentAssistantSelector,
    ].join(", ");

  // Fallback tier 1: the older message-level attributes without requiring a
  // <main> or conversation-turn ancestor.
  const unscopedMessageSelector = (role) =>
    [
      `[data-message-author-role="${role}"]`,
      `[data-testid="${role}-message"]`,
    ].join(", ");

  // Fallback tier 2: turn-level containers marked with data-turn. Used only
  // when no message-level element exists, because a turn container can also
  // hold the visually hidden "You said:" label.
  const turnSelector = (role) => `[data-turn="${role}"]`;

  const roleSelectors = (selectorFor) => [
    { role: "user", selector: selectorFor("user") },
    { role: "assistant", selector: selectorFor("assistant") },
  ];

  const register = globalThis.ChatContinuityRegisterExtractor;
  const extractors = globalThis.ChatContinuityExtractors ??= {};

  register("chatgpt", roleSelectors(messageSelector), {
    stableForMs: 180,
    maxWaitMs: 1200,
    pollIntervalMs: 75,
  });
  const primaryExtractor = extractors.chatgpt;

  // Reuse the shared collector (nesting filter, document order, empty-text
  // filter) for the fallback tiers, without exposing them as platforms.
  const fallbackExtractors = [
    ["chatgpt-unscoped", unscopedMessageSelector],
    ["chatgpt-turns", turnSelector],
  ].map(([name, selectorFor]) => {
    register(name, roleSelectors(selectorFor));
    const extractor = extractors[name];
    delete extractors[name];
    return extractor;
  });

  const count = (selector) => document.querySelectorAll(selector).length;

  // ---------------------------------------------------------------------
  // Long conversations. ChatGPT virtualizes the thread: only about six turns
  // (each holding a user message and an assistant reply) exist in the DOM,
  // and turns are removed entirely as they leave the viewport. Visible
  // collection therefore sees only that window. Full collection scrolls the
  // thread from top to bottom and merges what each position renders.
  // ---------------------------------------------------------------------
  const anyMessageSelector = `${messageSelector("user")}, ${messageSelector("assistant")}`;

  const isScrollable = (element) => {
    if (!element || element.scrollHeight <= element.clientHeight + 20) {
      return false;
    }
    if (element === document.scrollingElement) return true;
    const overflowY = globalThis.getComputedStyle?.(element).overflowY || "";
    return /(auto|scroll|overlay)/.test(overflowY);
  };

  // Decided by behaviour, not by name: a candidate counts only if assigning
  // scrollTop really moves it. Candidates: every ancestor of the first
  // message (up to <html>), the thread containers seen on ChatGPT, and the
  // document itself.
  // probe=false only checks scroll sizes and never moves the page.
  const findScroller = ({ probe = true } = {}) => {
    const anchor =
      document.querySelectorAll("[data-turn-key]")[0] ||
      document.querySelectorAll(anyMessageSelector)[0];
    if (!anchor) return null;
    const ancestors = [];
    for (let node = anchor.parentElement; node; node = node.parentElement) {
      ancestors.push(node);
    }
    const threadContainers = [
      ...document.querySelectorAll(".thread-scroll-container, [data-thread-reading]"),
    ];
    const moves = (element) => {
      if (!isScrollable(element)) return false;
      if (!probe) return true;
      const before = element.scrollTop;
      element.scrollTop = before > 0 ? before - 1 : before + 1;
      const moved = element.scrollTop !== before;
      element.scrollTop = before;
      return moved;
    };
    // Prefer an element that actually contains the messages; otherwise
    // accept a thread container that scrolls.
    return (
      [...ancestors, document.scrollingElement].find(
        (element) => element && element.contains(anchor) && moves(element),
      ) ||
      threadContainers.find(moves) ||
      null
    );
  };

  // Messages rendered right now, each with a key that stays the same when
  // ChatGPT re-renders the turn: turn key + role + position in the turn.
  const renderedMessages = () => {
    const found = [];
    for (const { role, selector } of roleSelectors(messageSelector)) {
      for (const element of document.querySelectorAll(selector)) {
        if (!found.some((item) => item.element === element)) {
          found.push({ element, role });
        }
      }
    }
    const positions = new Map();
    return found
      .filter(
        ({ element }) =>
          !found.some((other) => other.element !== element && other.element.contains(element)),
      )
      .sort((left, right) =>
        left.element.compareDocumentPosition(right.element) &
        Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      )
      .map(({ element, role }) => {
        const turn = element.closest("[data-turn-key]");
        const turnKey = turn ? turn.getAttribute("data-turn-key") : null;
        const positionKey = `${turnKey}|${role}`;
        const position = positions.get(positionKey) || 0;
        positions.set(positionKey, position + 1);
        return {
          key: turnKey ? `${positionKey}|${position}` : null,
          role,
          text: (element.innerText || element.textContent || "").trim(),
        };
      })
      .filter((message) => message.key && message.text);
  };

  // Resolves once the page has had no DOM changes for quietMs (the
  // virtualizer has finished rendering), or after maxMs.
  const waitForQuiet = ({ quietMs = 250, maxMs = 2000 } = {}) =>
    new Promise((resolve) => {
      let finished = false;
      let quietTimer;
      const finish = () => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      quietTimer = setTimeout(finish, quietMs);
      const maxTimer = setTimeout(finish, maxMs);
    });

  // After assigning scrollTop: wait for the scroll event (a busy page can
  // deliver it late), then for the virtualizer to finish rendering, then
  // make sure what is rendered is really in view (not the previous window).
  const scrollEventTarget = (scroller) =>
    scroller === document.scrollingElement ? globalThis : scroller;
  const scrollTo = async (scroller, top, quiet) => {
    const scrolled = new Promise((resolve) => {
      scrollEventTarget(scroller).addEventListener("scroll", resolve, { once: true });
      setTimeout(resolve, 600);
    });
    scroller.scrollTop = top;
    await scrolled;
    await waitForQuiet(quiet);
    for (let check = 0; check < 3 && !renderedInView(scroller); check += 1) {
      await waitForQuiet(quiet);
    }
  };
  const renderedInView = (scroller) => {
    const view =
      scroller === document.scrollingElement
        ? { top: 0, bottom: globalThis.innerHeight }
        : scroller.getBoundingClientRect();
    // A whole turn counts too: in the middle of a very long answer no
    // message element starts inside the viewport, but its turn does cover it.
    return [
      ...document.querySelectorAll(`[data-turn-key], ${anyMessageSelector}`),
    ].some((element) => {
      const box = element.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom;
    });
  };

  // Ordered, de-duplicated merge. New keys are inserted next to the keys
  // they were rendered with, so order holds even when older turns are
  // prepended. A batch sharing no key with what was collected is appended
  // (the walk goes downward) and reported as a possible gap.
  const createMerger = () => {
    const order = [];
    const byKey = new Map();
    let possibleGap = false;
    const merge = (batch) => {
      const firstKnown = batch.findIndex((message) => byKey.has(message.key));
      if (firstKnown === -1 && order.length && batch.length) possibleGap = true;
      let insertAt =
        firstKnown === -1 ? order.length : order.indexOf(batch[firstKnown].key);
      for (const message of batch) {
        const existing = byKey.get(message.key);
        if (existing) {
          // Keep the most complete rendering of the same message.
          if (message.text.length > existing.text.length) existing.text = message.text;
          insertAt = order.indexOf(message.key) + 1;
          continue;
        }
        byKey.set(message.key, { role: message.role, text: message.text });
        order.splice(insertAt, 0, message.key);
        insertAt += 1;
      }
    };
    return {
      merge,
      get size() {
        return order.length;
      },
      get possibleGap() {
        return possibleGap;
      },
      messages: () => order.map((key) => ({ ...byKey.get(key) })),
    };
  };

  const FULL_COLLECTION_LIMIT_MS = 120_000;

  async function collectFullConversation({
    isAborted = () => false,
    onProgress = () => {},
    limitMs = FULL_COLLECTION_LIMIT_MS,
  } = {}) {
    const scroller = findScroller();
    if (!scroller) {
      const visible = await extractors.chatgpt();
      return {
        ...visible,
        complete: false,
        warning: `${visible.warning} לא נמצא אזור גלילה, ולכן נאספו רק ההודעות המוצגות.`,
      };
    }

    const merger = createMerger();
    const originalTop = scroller.scrollTop;
    const deadline = Date.now() + limitMs;
    const timeLeft = () => Date.now() < deadline && !isAborted();
    const maxScroll = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    // Real progress: how far down the conversation the walk has reached.
    const percentDone = () =>
      maxScroll() ? Math.min(100, Math.round((scroller.scrollTop / maxScroll()) * 100)) : 100;
    let stopReason = null;
    let reachedPercent = 0;
    const collectHere = () => {
      merger.merge(renderedMessages());
      onProgress(merger.size, percentDone());
    };

    try {
      // 1. Reach the real top. The thread may load older turns there and
      //    push content down, so keep going until the top is stable twice
      //    in a row. Nothing is collected on the way up: older turns loaded
      //    later would otherwise share no messages with what was collected
      //    and could end up out of order.
      //    Bounded: if the page keeps moving the scroll away from the top
      //    without loading anything, stop instead of retrying for minutes.
      let stableAtTop = 0;
      let pulledAway = 0;
      for (let attempt = 0; attempt < 20 && stableAtTop < 2 && timeLeft(); attempt += 1) {
        const heightBefore = scroller.scrollHeight;
        await scrollTo(scroller, 0, { quietMs: 600, maxMs: 4000 });
        const loadedOlder = scroller.scrollHeight !== heightBefore;
        if (scroller.scrollTop <= 1 && !loadedOlder) {
          stableAtTop += 1;
        } else {
          stableAtTop = 0;
          pulledAway = loadedOlder ? 0 : pulledAway + 1;
          if (pulledAway >= 3) break;
        }
      }
      if (stableAtTop < 2 && timeLeft()) {
        stopReason = pulledAway >= 3 ? "pulled-back" : "no-progress";
      }
      collectHere();

      // 2. Walk down in fixed steps of half a viewport and NEVER back up:
      //    every step moves forward, so the walk always ends. If the page
      //    moves the scroll back (or it stops moving) three times in a row,
      //    stop with a clear reason instead of looping.
      let notMoving = 0;
      while (!stopReason && timeLeft() && scroller.scrollTop < maxScroll() - 2) {
        const before = scroller.scrollTop;
        const step = Math.max(80, Math.floor(scroller.clientHeight * 0.5));
        await scrollTo(scroller, Math.min(before + step, maxScroll()));
        collectHere();
        if (scroller.scrollTop > before + 1) {
          notMoving = 0;
        } else if (++notMoving >= 3) {
          stopReason = scroller.scrollTop < before - 1 ? "pulled-back" : "no-progress";
        }
      }
    } finally {
      reachedPercent = percentDone();
      scroller.scrollTop = originalTop;
    }

    const aborted = isAborted();
    const timedOut = !aborted && !stopReason && Date.now() >= deadline;
    let messages = merger.messages();
    if (!messages.length) {
      // Messages without turn keys (older layouts): fall back to visible.
      const visible = await extractors.chatgpt();
      return { ...visible, complete: false };
    }

    const notes = [];
    if (stopReason === "pulled-back") {
      notes.push(
        `האיסוף נעצר כי ChatGPT החזיר את הגלילה שוב ושוב (הגיע ל־${reachedPercent}% מהשיחה). נאספו רק חלק מההודעות.`,
      );
    } else if (stopReason === "no-progress") {
      notes.push(
        `האיסוף נעצר כי הגלילה הפסיקה להתקדם (הגיע ל־${reachedPercent}% מהשיחה). נאספו רק חלק מההודעות.`,
      );
    }
    if (timedOut) {
      notes.push(
        `האיסוף המלא נעצר במגבלת הזמן (הגיע ל־${reachedPercent}% מהשיחה); ייתכן שחסרות הודעות.`,
      );
    }
    if (merger.possibleGap) {
      notes.push("ייתכן שדולגו הודעות במהלך הגלילה; בדקי את המספר מול השיחה.");
    }
    return {
      platform: "chatgpt",
      messages,
      complete: !timedOut && !aborted && !stopReason && !merger.possibleGap,
      stopReason,
      reachedPercent,
      aborted,
      warning: notes.length
        ? notes.join(" ")
        : "השיחה נגללה מתחילתה ועד סופה, והגלילה הוחזרה למקומה.",
    };
  }

  // Visible collection cannot see turns outside the rendered window; point
  // the user to full collection when the thread scrolls.
  const withLongConversationHint = (result) =>
    findScroller({ probe: false })
      ? {
          ...result,
          warning:
            `${result.warning} בשיחה ארוכה ChatGPT מציג רק חלק מההודעות; ` +
            "לאיסוף כל השיחה השתמשי ב'איסוף שיחה מלאה'.",
        }
      : result;

  // Privacy-safe evidence for an empty result: counts of structural elements
  // only, never message text. Shown in the popup through the error name.
  const structureEvidence = () =>
    [
      `main=${count("main")}`,
      `author-role=${count("[data-message-author-role]")}`,
      `user-bubble=${count(".bg-user-message, .text-user-message")}`,
      `response-body=${count("[data-response-body]")}`,
      `turn-key=${count("[data-turn-key]")}`,
      `virtualized=${count("[data-virtualized-turn]")}`,
      `turn-testid=${count('[data-testid^="conversation-turn-"]')}`,
      `data-turn=${count("[data-turn]")}`,
    ].join(" ");

  extractors.chatgpt = async () => {
    const primary = await primaryExtractor();
    if (primary.messages.length) return withLongConversationHint(primary);

    for (const fallback of fallbackExtractors) {
      const result = await fallback();
      if (result.messages.length) {
        return withLongConversationHint({ ...result, platform: "chatgpt" });
      }
    }

    const error = new Error("No ChatGPT messages matched");
    error.name = `ChatGPTNoMessages: ${structureEvidence()}`;
    throw error;
  };

  // Exposed for the automated browser test only.
  globalThis.ChatContinuityChatGPTFullCollection = collectFullConversation;

  // Full collection runs over a long-lived port: the popup receives progress,
  // and if the popup closes the port disconnects, the walk stops and the
  // original scroll position is restored. Installed once per content world
  // even if the script is injected again.
  if (!globalThis.ChatContinuityChatGPTFullListener) {
    globalThis.ChatContinuityChatGPTFullListener = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || message?.type !== "chatgpt-full-ping") {
        return false;
      }
      sendResponse({ ok: true });
      return false;
    });

    chrome.runtime.onConnect?.addListener((port) => {
      if (
        port.name !== "chatgpt-full-collection" ||
        port.sender?.id !== chrome.runtime.id
      ) {
        return;
      }
      let aborted = false;
      port.onDisconnect.addListener(() => {
        aborted = true;
      });
      const send = (message) => {
        if (!aborted) port.postMessage(message);
      };
      collectFullConversation({
        isAborted: () => aborted,
        onProgress: (collected, percent) => send({ type: "progress", collected, percent }),
      })
        .then((result) =>
          send(
            result.messages.length
              ? { type: "result", ok: true, ...result }
              : { type: "result", ok: false, error: "לא נמצאו הודעות בשיחה הפתוחה." },
          ),
        )
        .catch((error) => {
          const errorType =
            typeof error?.name === "string" && error.name ? error.name : "UnknownError";
          send({ type: "result", ok: false, error: `שגיאה באיסוף מהעמוד (${errorType}).` });
        });
    });
  }
})();
