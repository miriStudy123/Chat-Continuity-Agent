const API_BASE = "http://127.0.0.1:8000";
const MAX_TRANSCRIPT_LENGTH = 500_000;
const RESTORE_POLL_MS = 3000;
const CONTENT_SCRIPT_FILES = {
  chatgpt: ["content/shared.js", "content/chatgpt.js"],
  claude: ["content/shared.js", "content/claude.js"],
  gemini: ["content/shared.js", "content/gemini.js"],
};
const PLATFORM_NAMES = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
};

const elements = Object.fromEntries(
  [
    "platform",
    "status",
    "collect",
    "send",
    "restore",
    "review",
    "summary",
    "prompt",
    "approve",
    "reject",
    "copy",
  ].map((id) => [id, document.getElementById(id)]),
);
elements.collectionWarning = document.getElementById("collection-warning");
elements.approvalActions = document.getElementById("approval-actions");
elements.collectFull = document.getElementById("collect-full");
elements.fullCollectionNote = document.getElementById("full-collection-note");

let sourcePlatform = null;
let transcript = "";
let pendingThreadId = null;

function setStatus(message) {
  elements.status.textContent = message;
}

function getErrorMessage(error) {
  return typeof error?.message === "string"
    ? error.message
    : "אירעה שגיאה לא צפויה.";
}

async function requestConversationMessages(tabId) {
  const message = {
    type: "collect-conversation",
    platform: sourcePlatform,
  };
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const messageText = getErrorMessage(error);
    if (
      !messageText.includes("Receiving end does not exist") &&
      !messageText.includes("Could not establish connection")
    ) {
      throw error;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES[sourcePlatform],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function isMissingReceiver(error) {
  const messageText = getErrorMessage(error);
  return (
    messageText.includes("Receiving end does not exist") ||
    messageText.includes("Could not establish connection")
  );
}

// Full collection (ChatGPT only) runs over a port so the popup can show
// progress; closing the popup disconnects the port, which stops the scroll
// in the page and restores its position.
async function ensureChatGPTFullCollector(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "chatgpt-full-ping" });
  } catch (error) {
    if (!isMissingReceiver(error)) throw error;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES.chatgpt,
    });
  }
}

function runChatGPTFullCollection(tabId, onProgress) {
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "chatgpt-full-collection" });
    let finished = false;
    port.onMessage.addListener((message) => {
      if (message?.type === "progress") {
        onProgress(message.collected, message.percent);
      } else if (message?.type === "result") {
        finished = true;
        port.disconnect();
        resolve(message);
      }
    });
    port.onDisconnect.addListener(() => {
      if (!finished) reject(new Error("החיבור לעמוד נותק לפני סיום האיסוף."));
    });
  });
}

function setCollectButtonsDisabled(disabled) {
  elements.collect.disabled = disabled;
  elements.collectFull.disabled = disabled;
}

async function fetchJson(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        // Chrome may omit Origin on extension GET requests; the server
        // accepts this header from the configured extension ID instead.
        "X-Chat-Continuity-Extension": chrome.runtime.id,
        ...options.headers,
      },
    });
  } catch {
    throw new Error("לא ניתן להתחבר לשרת המקומי. בדקי שהשרת פועל.");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("השרת החזיר תשובה לא תקינה.");
  }

  if (!response.ok) {
    const error = new Error(
      typeof body.detail === "string"
        ? body.detail
        : `השרת החזיר שגיאה (${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function showReview(result) {
  elements.summary.textContent = result.summary;
  elements.prompt.textContent = result.continuation_prompt;
  elements.review.hidden = false;
  elements.approvalActions.hidden = false;
  elements.copy.hidden = true;
  elements.approve.disabled = false;
  elements.reject.disabled = false;
}

async function clearPendingThread() {
  pendingThreadId = null;
  await chrome.storage.local.remove("pendingThreadId");
  enableCollectButtonsForPlatform();
}

function enableCollectButtonsForPlatform() {
  elements.collect.disabled = !sourcePlatform;
  elements.collectFull.disabled = sourcePlatform !== "chatgpt";
}

async function restorePendingReview() {
  const stored = await chrome.storage.local.get("pendingThreadId");
  pendingThreadId = stored.pendingThreadId || null;
  if (!pendingThreadId) {
    enableCollectButtonsForPlatform();
    return;
  }

  setCollectButtonsDisabled(true);
  setStatus("מנסה לשחזר את הסקירה הממתינה…");
  elements.restore.hidden = true;
  try {
    const result = await fetchJson(
      `/conversations/${encodeURIComponent(pendingThreadId)}`,
    );
    if (result.status === "processing") {
      setStatus("הניתוח עדיין מתבצע בשרת. בודקת שוב בעוד כמה שניות…");
      setTimeout(restorePendingReview, RESTORE_POLL_MS);
      return;
    }
    showReview(result);
    setStatus("נמצאה סקירה שממתינה לאישור.");
  } catch (error) {
    const message = getErrorMessage(error);
    if (error.status === 404 || error.status === 409) {
      await clearPendingThread();
      setStatus(
        "לא נמצאה סקירה ממתינה (ייתכן שהניתוח הקודם נכשל). אפשר להתחיל מחדש.",
      );
      return;
    }
    setStatus(`לא ניתן לשחזר כרגע: ${message}`);
    elements.restore.hidden = false;
  }
}

async function detectPlatform() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const hostname = new URL(tab?.url || "about:blank").hostname;
  if (hostname === "chatgpt.com" || hostname === "chat.openai.com") {
    sourcePlatform = "chatgpt";
  } else if (hostname === "claude.ai") {
    sourcePlatform = "claude";
  } else if (hostname === "gemini.google.com") {
    sourcePlatform = "gemini";
  }

  elements.platform.textContent = sourcePlatform
    ? `פלטפורמת מקור: ${PLATFORM_NAMES[sourcePlatform]}`
    : "האתר הנוכחי אינו נתמך.";
  elements.collect.disabled = !sourcePlatform;
  const fullCollectionAvailable = sourcePlatform === "chatgpt";
  elements.collectFull.hidden = !fullCollectionAvailable;
  elements.fullCollectionNote.hidden = !fullCollectionAvailable;
  elements.collectFull.disabled = !fullCollectionAvailable;
}

// Shared by visible and full collection: validates the messages, builds the
// transcript and shows the explicit send step.
function acceptCollectionResult(result) {
  if (!result?.ok || !Array.isArray(result.messages)) {
    throw new Error(result?.error || "לא ניתן לאסוף את השיחה מהעמוד.");
  }

  transcript = result.messages
      .map(({ role, text }) => {
        if (
          !["user", "assistant"].includes(role) ||
          typeof text !== "string" ||
          !text.trim()
        ) {
          throw new Error("העמוד החזיר הודעה במבנה לא תקין.");
        }
        const label = role === "user" ? "משתמשת" : "עוזר";
        return `${label}:\n${text.trim()}`;
      })
      .join("\n\n");

    if (transcript.length > MAX_TRANSCRIPT_LENGTH) {
      transcript = "";
      throw new Error(
        "השיחה ארוכה מדי לשליחה אחת. לא נשלח תוכן; נסי שיחה קצרה יותר.",
      );
    }

    elements.collectionWarning.textContent =
      `${result.warning} נמצאו ${result.messages.length} הודעות.`;
    elements.collectionWarning.hidden = false;
    elements.send.hidden = false;
    setStatus(
      "האיסוף הושלם. לחצי על שליחה רק אם את מסכימה להעביר את תוכן השיחה.",
    );
}

function startCollection(statusMessage) {
  setCollectButtonsDisabled(true);
  setStatus(statusMessage);
  elements.collectionWarning.hidden = true;
  elements.send.hidden = true;
}

function failCollection(error) {
  setStatus(`האיסוף נכשל: ${getErrorMessage(error)}`);
  enableCollectButtonsForPlatform();
}

elements.collect.addEventListener("click", async () => {
  startCollection("אוספת את ההודעות שמופיעות בשיחה…");
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    acceptCollectionResult(await requestConversationMessages(tab.id));
  } catch (error) {
    failCollection(error);
  }
});

elements.collectFull.addEventListener("click", async () => {
  startCollection(
    "גוללת את השיחה מתחילתה ואוספת את כל ההודעות… השאירי את החלון פתוח.",
  );
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    await ensureChatGPTFullCollector(tab.id);
    const result = await runChatGPTFullCollection(tab.id, (collected, percent) =>
      setStatus(
        `גוללת ואוספת… ${Number.isFinite(percent) ? `${percent}% מהשיחה, ` : ""}` +
          `נאספו עד עכשיו ${collected} הודעות. השאירי את החלון פתוח.`,
      ),
    );
    acceptCollectionResult(result);
  } catch (error) {
    failCollection(error);
  }
});

elements.send.addEventListener("click", async () => {
  elements.send.disabled = true;

  // The ID is stored before sending so that closing the popup during the
  // analysis does not lose the result: reopening restores it from the server.
  const threadId = crypto.randomUUID();
  let threadIdStored = false;
  try {
    await chrome.storage.local.set({ pendingThreadId: threadId });
    threadIdStored = true;
  } catch {
    // Continue; the review can still be approved while the popup stays open.
  }
  pendingThreadId = threadId;
  setStatus(
    threadIdStored
      ? "שולחת לשרת המקומי וממתינה לניתוח (עשוי להימשך דקה או יותר). אפשר לסגור את החלון; התוצאה תשוחזר כשתפתחי אותו שוב."
      : "שולחת לשרת המקומי וממתינה לניתוח. השאירי את החלון פתוח עד לסיום.",
  );

  try {
    const result = await fetchJson("/conversations", {
      method: "POST",
      body: JSON.stringify({
        conversation_text: transcript,
        thread_id: threadId,
      }),
    });
    pendingThreadId = result.thread_id;
    transcript = "";
    elements.send.hidden = true;
    showReview(result);
    setStatus(
      threadIdStored
        ? "הניתוח הושלם. בדקי את הסיכום והפרומפט לפני החלטה."
        : "הניתוח הושלם, אך שמירת מזהה התהליך בתוסף נכשלה. אשרי עכשיו כדי לא לאבד את הסקירה.",
    );
  } catch (error) {
    try {
      await clearPendingThread();
    } catch {
      // A stale ID is cleared on the next popup open (server returns 404).
    }
    setStatus(`השליחה או הניתוח נכשלו: ${getErrorMessage(error)}`);
    enableCollectButtonsForPlatform();
  } finally {
    elements.send.disabled = false;
  }
});

async function submitApproval(approved) {
  if (!pendingThreadId) {
    setStatus("אין תהליך ממתין לאישור.");
    return;
  }

  elements.approve.disabled = true;
  elements.reject.disabled = true;
  setStatus(approved ? "שומרת את הפרומפט שאישרת…" : "שולחת את החלטת הדחייה…");
  try {
    const result = await fetchJson(
      `/conversations/${encodeURIComponent(pendingThreadId)}/approval`,
      {
        method: "POST",
        body: JSON.stringify({ approved }),
      },
    );
    elements.approvalActions.hidden = true;
    if (approved && result.status === "saved") {
      elements.copy.hidden = false;
      setStatus("ההתקדמות נשמרה. אפשר להעתיק את הפרומפט ולהדביק בכל מודל AI.");
    } else {
      elements.review.hidden = true;
      setStatus("התוצאה נדחתה ולא נשמרה.");
    }
    try {
      await clearPendingThread();
    } catch {
      setCollectButtonsDisabled(true);
      setStatus(
        "השרת השלים את ההחלטה, אך ניקוי מזהה התהליך מהאחסון נכשל. פתיחה מחדש תנסה לנקות אותו.",
      );
    }
  } catch (error) {
    elements.approve.disabled = false;
    elements.reject.disabled = false;
    setStatus(`לא ניתן להשלים את ההחלטה: ${getErrorMessage(error)}`);
  }
}

elements.approve.addEventListener("click", () => submitApproval(true));
elements.reject.addEventListener("click", () => submitApproval(false));

elements.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.prompt.textContent);
    setStatus("הפרומפט הועתק ללוח.");
  } catch {
    setStatus("ההעתקה נכשלה. סמני והעתיקי את הטקסט ידנית.");
  }
});

elements.restore.addEventListener("click", restorePendingReview);

async function initializePopup() {
  try {
    await detectPlatform();
    await restorePendingReview();
  } catch (error) {
    setStatus(`לא ניתן לאתחל את התוסף: ${getErrorMessage(error)}`);
  }
}

initializePopup();
