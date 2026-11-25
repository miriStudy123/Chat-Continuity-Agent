(() => {
  function collectMessages(roleSelectors) {
    const candidates = [];
    for (const { role, selector } of roleSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!candidates.some((candidate) => candidate.element === element)) {
          candidates.push({ element, role });
        }
      }
    }

    return candidates
      .filter(
        ({ element }) =>
          !candidates.some(
            (candidate) =>
              candidate.element !== element &&
              candidate.element.contains(element),
          ),
      )
      .sort(
        (left, right) =>
          left.element.compareDocumentPosition(right.element) &
          Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
      )
      .map(({ element, role }) => ({
        role,
        text: (element.innerText || element.textContent || "").trim(),
      }))
      .filter((message) => message.text.length > 0);
  }

  function getMessageSignature(messages) {
    return messages
      .map(({ role, text }) => `${role}:${text.length}:${text.slice(-32)}`)
      .join("|");
  }

  async function collectStableMessages(roleSelectors, options) {
    const deadline = Date.now() + options.maxWaitMs;
    let messages = collectMessages(roleSelectors);
    let signature = getMessageSignature(messages);
    let stableSince = Date.now();

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
      const currentMessages = collectMessages(roleSelectors);
      const currentSignature = getMessageSignature(currentMessages);
      if (currentSignature !== signature) {
        signature = currentSignature;
        stableSince = Date.now();
      }
      messages = currentMessages;

      if (
        messages.length > 0 &&
        Date.now() - stableSince >= options.stableForMs
      ) {
        return messages;
      }
    }

    return collectMessages(roleSelectors);
  }

  function registerExtractor(platform, roleSelectors, waitOptions = null) {
    globalThis.ChatContinuityExtractors ??= {};
    globalThis.ChatContinuityExtractors[platform] = async () => {
      const messages = waitOptions
        ? await collectStableMessages(roleSelectors, waitOptions)
        : collectMessages(roleSelectors);
      return {
        platform,
        messages,
        warning:
          "נאספו רק הודעות שמופיעות כרגע בעמוד. ייתכן שחלק מהשיחה לא נטען.",
      };
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== chrome.runtime.id ||
      message?.type !== "collect-conversation"
    ) {
      return false;
    }

    const extractor = globalThis.ChatContinuityExtractors?.[message.platform];
    if (!extractor) {
      sendResponse({ ok: false, error: "לא נמצא אוסף שיחות עבור האתר הזה." });
      return false;
    }

    Promise.resolve()
      .then(extractor)
      .then((result) => {
        sendResponse(
          result.messages.length
            ? { ok: true, ...result }
            : { ok: false, error: "לא נמצאו הודעות בשיחה הפתוחה." },
        );
      })
      .catch((error) => {
        const errorType =
          typeof error?.name === "string" && error.name
            ? error.name
            : "UnknownError";
        sendResponse({
          ok: false,
          error: `שגיאה באיסוף מהעמוד (${errorType}).`,
        });
      });
    return true;
  });

  globalThis.ChatContinuityRegisterExtractor = registerExtractor;
})();
