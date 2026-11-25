const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const extensionPath = path.resolve(__dirname, "..");

function createPopupContext({
  initialStorage = {},
  onFetch,
  messages,
  onSendMessage,
  onExecuteScript,
  nextUuid = "00000000-0000-4000-8000-000000000000",
  tabUrl = "https://chatgpt.com/c/synthetic",
  onConnect,
} = {}) {
  const elements = new Map();
  const storedValues = { ...initialStorage };
  const storageWrites = [];
  const requests = [];
  const clipboard = { value: "" };
  const timers = [];

  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          disabled: false,
          hidden: false,
          textContent: "",
          listeners: {},
          addEventListener(name, callback) {
            this.listeners[name] = callback;
          },
        });
      }
      return elements.get(id);
    },
  };
  const chrome = {
    runtime: { id: "a".repeat(32) },
    tabs: {
      async query() {
        return [{ id: 8, url: tabUrl }];
      },
      async sendMessage(_tabId, message) {
        assert.ok(
          ["collect-conversation", "chatgpt-full-ping"].includes(message.type),
          message.type,
        );
        return onSendMessage
          ? onSendMessage(_tabId, message)
          : { ok: true, messages, warning: "אזהרת בדיקה" };
      },
      // Fake long-lived port: the test drives it through onConnect(port).
      connect(tabId, details) {
        const listeners = { message: [], disconnect: [] };
        const port = {
          tabId,
          name: details.name,
          disconnected: false,
          onMessage: { addListener: (callback) => listeners.message.push(callback) },
          onDisconnect: { addListener: (callback) => listeners.disconnect.push(callback) },
          disconnect() {
            port.disconnected = true;
          },
          emit(message) {
            for (const callback of listeners.message) callback(message);
          },
          drop() {
            for (const callback of listeners.disconnect) callback();
          },
        };
        setImmediate(() => onConnect?.(port));
        return port;
      },
    },
    scripting: {
      async executeScript(details) {
        if (onExecuteScript) return onExecuteScript(details);
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: storedValues[key] };
        },
        async set(values) {
          Object.assign(storedValues, values);
          storageWrites.push(values);
        },
        async remove(key) {
          delete storedValues[key];
        },
      },
    },
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    const body = await onFetch(url, options);
    if (body?.httpStatus) {
      return {
        ok: false,
        status: body.httpStatus,
        async json() { return { detail: body.detail }; },
      };
    }
    return { ok: true, async json() { return body; } };
  };
  const context = {
    chrome,
    document,
    fetch,
    navigator: { clipboard: { async writeText(text) { clipboard.value = text; } } },
    URL,
    crypto: { randomUUID: () => nextUuid },
    setTimeout: (callback) => timers.push(callback),
    console: { error() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(extensionPath, "popup.js"), "utf8"),
    context,
    { filename: "popup.js" },
  );

  return {
    elements,
    requests,
    clipboard,
    storageWrites,
    storedValues,
    timers,
    async ready() {
      await new Promise((resolve) => setImmediate(resolve));
    },
    async click(id) {
      await elements.get(id).listeners.click();
    },
  };
}

test("popup requires explicit send consent and stores only pending thread ID", async () => {
  const threadId = "2bb6efde-065c-4faa-b268-75698894c457";
  const prompt = "Synthetic continuation prompt";
  const storedValuesRef = { value: null };
  const popup = createPopupContext({
    nextUuid: threadId,
    messages: [
      { role: "user", text: "Synthetic question" },
      { role: "assistant", text: "Synthetic response" },
    ],
    onFetch: async (url, options) => {
      if (url.endsWith("/conversations")) {
        assert.equal(options.method, "POST");
        assert.match(options.body, /Synthetic question/);
        assert.equal(JSON.parse(options.body).thread_id, threadId);
        assert.equal(
          options.headers["X-Chat-Continuity-Extension"],
          "a".repeat(32),
        );
        // The ID must already be stored while the analysis is running.
        assert.equal(storedValuesRef.value.pendingThreadId, threadId);
        return {
          thread_id: threadId,
          summary: "Synthetic summary",
          continuation_prompt: prompt,
        };
      }
      if (url.endsWith(`/conversations/${threadId}/approval`)) {
        assert.equal(options.method, "POST");
        assert.equal(options.body, JSON.stringify({ approved: true }));
        return { status: "saved" };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  storedValuesRef.value = popup.storedValues;
  await popup.ready();

  await popup.click("collect");
  assert.equal(popup.requests.length, 0);
  assert.equal(popup.elements.get("send").hidden, false);

  await popup.click("send");
  assert.equal(popup.requests.length, 1);
  assert.equal(popup.storedValues.pendingThreadId, threadId);
  assert.equal(
    JSON.stringify(popup.storedValues).includes("Synthetic question"),
    false,
  );
  assert.equal(popup.elements.get("summary").textContent, "Synthetic summary");

  await popup.click("approve");
  assert.equal(popup.requests.length, 2);
  assert.equal(popup.storedValues.pendingThreadId, undefined);
  await popup.click("copy");
  assert.equal(popup.clipboard.value, prompt);
});

test("popup restores a pending review using its stored thread ID", async () => {
  const threadId = "e371468e-c708-4c62-9edf-5c0ef1057dce";
  const popup = createPopupContext({
    initialStorage: { pendingThreadId: threadId },
    onFetch: async (url) => {
      assert.equal(url, `http://127.0.0.1:8000/conversations/${threadId}`);
      return {
        thread_id: threadId,
        status: "awaiting_approval",
        summary: "Restored synthetic summary",
        continuation_prompt: "Restored synthetic prompt",
      };
    },
  });
  await popup.ready();

  assert.equal(popup.elements.get("summary").textContent, "Restored synthetic summary");
  assert.equal(popup.elements.get("collect").disabled, true);
  assert.equal(popup.requests.length, 1);
});

test("popup injects ChatGPT content scripts once when the tab has no listener", async () => {
  let sendAttempts = 0;
  let injectedFiles = null;
  const popup = createPopupContext({
    messages: [
      { role: "user", text: "Synthetic question" },
      { role: "assistant", text: "Synthetic response" },
    ],
    onSendMessage: async () => {
      sendAttempts += 1;
      if (sendAttempts === 1) {
        throw new Error(
          "Could not establish connection. Receiving end does not exist.",
        );
      }
      return {
        ok: true,
        messages: [
          { role: "user", text: "Synthetic question" },
          { role: "assistant", text: "Synthetic response" },
        ],
        warning: "Synthetic warning",
      };
    },
    onExecuteScript: async (details) => {
      injectedFiles = details.files;
    },
  });
  await popup.ready();

  await popup.click("collect");

  assert.equal(sendAttempts, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(injectedFiles)),
    ["content/shared.js", "content/chatgpt.js"],
  );
  assert.equal(popup.elements.get("send").hidden, false);
});

test("popup keeps checking while the server is still analyzing", async () => {
  const threadId = "5f0c2d1e-8a49-4c43-9b8e-0d6a3f1b2c7d";
  let calls = 0;
  const popup = createPopupContext({
    initialStorage: { pendingThreadId: threadId },
    onFetch: async (url) => {
      assert.equal(url, `http://127.0.0.1:8000/conversations/${threadId}`);
      calls += 1;
      return calls === 1
        ? { thread_id: threadId, status: "processing" }
        : {
            thread_id: threadId,
            status: "awaiting_approval",
            summary: "Late synthetic summary",
            continuation_prompt: "Late synthetic prompt",
          };
    },
  });
  await popup.ready();

  assert.match(popup.elements.get("status").textContent, /עדיין מתבצע/);
  assert.equal(popup.timers.length, 1);
  await popup.timers[0]();
  assert.equal(popup.elements.get("summary").textContent, "Late synthetic summary");
  assert.equal(popup.storedValues.pendingThreadId, threadId);
});

test("popup clears the stored ID when sending fails", async () => {
  const threadId = "9d7e6f5a-4b3c-4d2e-8f1a-0b9c8d7e6f5a";
  const popup = createPopupContext({
    nextUuid: threadId,
    messages: [
      { role: "user", text: "Synthetic question" },
      { role: "assistant", text: "Synthetic response" },
    ],
    onFetch: async () => ({
      httpStatus: 503,
      detail: "Gemini עמוס או לא זמין כרגע",
    }),
  });
  await popup.ready();
  await popup.click("collect");
  await popup.click("send");

  assert.equal(popup.storedValues.pendingThreadId, undefined);
  assert.match(popup.elements.get("status").textContent, /Gemini עמוס/);
  assert.equal(popup.elements.get("collect").disabled, false);
});

// --- ChatGPT full collection (auto-scroll) from the popup.

const fullMessages = [
  { role: "user", text: "Synthetic Q1" },
  { role: "assistant", text: "Synthetic A1" },
  { role: "user", text: "Synthetic Q2" },
  { role: "assistant", text: "Synthetic A2" },
];

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("popup shows full collection only for ChatGPT", async () => {
  const chatgpt = createPopupContext({ onFetch: async () => ({}) });
  await chatgpt.ready();
  assert.equal(chatgpt.elements.get("collect-full").hidden, false);
  assert.equal(chatgpt.elements.get("full-collection-note").hidden, false);

  const claude = createPopupContext({
    tabUrl: "https://claude.ai/chat/synthetic",
    onFetch: async () => ({}),
  });
  await claude.ready();
  assert.equal(claude.elements.get("collect-full").hidden, true);
  assert.equal(claude.elements.get("collect").disabled, false);
});

test("popup full collection shows progress and the explicit send step", async () => {
  let connectedPort = null;
  const pings = [];
  const popup = createPopupContext({
    onFetch: async () => {
      throw new Error("Nothing may be sent before consent");
    },
    onSendMessage: async (_tabId, message) => {
      pings.push(message.type);
      return { ok: true };
    },
    onConnect: (port) => {
      connectedPort = port;
      port.emit({ type: "progress", collected: 2 });
    },
  });
  await popup.ready();

  const clicked = popup.click("collect-full");
  await settle();
  assert.equal(connectedPort.name, "chatgpt-full-collection");
  assert.match(popup.elements.get("status").textContent, /נאספו עד עכשיו 2 הודעות/);
  assert.equal(popup.elements.get("collect").disabled, true);
  connectedPort.emit({
    type: "result",
    ok: true,
    messages: fullMessages,
    warning: "השיחה נגללה מתחילתה ועד סופה.",
  });
  await clicked;

  assert.deepEqual(pings, ["chatgpt-full-ping"]);
  assert.equal(connectedPort.disconnected, true);
  assert.equal(popup.requests.length, 0);
  assert.equal(popup.elements.get("send").hidden, false);
  assert.match(popup.elements.get("collection-warning").textContent, /נמצאו 4 הודעות/);
});

test("popup full collection injects the content scripts when the tab has none", async () => {
  let injected = null;
  const popup = createPopupContext({
    onFetch: async () => ({}),
    onSendMessage: async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    },
    onExecuteScript: async (details) => {
      injected = details.files;
    },
    onConnect: (port) =>
      port.emit({ type: "result", ok: true, messages: fullMessages, warning: "ok" }),
  });
  await popup.ready();
  await popup.click("collect-full");

  assert.deepEqual(JSON.parse(JSON.stringify(injected)), [
    "content/shared.js",
    "content/chatgpt.js",
  ]);
  assert.equal(popup.elements.get("send").hidden, false);
});

test("popup full collection reports a dropped connection and re-enables collection", async () => {
  const popup = createPopupContext({
    onFetch: async () => ({}),
    onSendMessage: async () => ({ ok: true }),
    onConnect: (port) => port.drop(),
  });
  await popup.ready();
  await popup.click("collect-full");

  assert.match(popup.elements.get("status").textContent, /האיסוף נכשל: החיבור לעמוד נותק/);
  assert.equal(popup.elements.get("send").hidden, true);
  assert.equal(popup.elements.get("collect").disabled, false);
  assert.equal(popup.elements.get("collect-full").disabled, false);
});

test("popup full collection shows the page's error without sending anything", async () => {
  const popup = createPopupContext({
    onFetch: async () => {
      throw new Error("Nothing may be sent");
    },
    onSendMessage: async () => ({ ok: true }),
    onConnect: (port) =>
      port.emit({ type: "result", ok: false, error: "לא נמצאו הודעות בשיחה הפתוחה." }),
  });
  await popup.ready();
  await popup.click("collect-full");

  assert.match(popup.elements.get("status").textContent, /לא נמצאו הודעות/);
  assert.equal(popup.requests.length, 0);
});
