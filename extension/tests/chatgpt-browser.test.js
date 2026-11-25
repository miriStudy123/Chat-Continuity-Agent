// Real-browser test of ChatGPT full collection on a synthetic virtualized
// thread (extension/tests/browser/chatgpt-virtualized.html).
//
// Runs Chrome (or Edge) headless with a temporary, empty profile; no network
// and no real account are used. Skipped when no Chromium browser is found.
// Set CHROME_PATH to use a specific browser executable.
//
// The page runs in REAL time and is driven over the Chrome DevTools
// Protocol (Node's built-in WebSocket). Virtual-time modes such as
// --virtual-time-budget do not deliver scroll events between timers, so a
// virtualizer never re-renders there and the test would be meaningless.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

const browserPath = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && fs.existsSync(candidate));

const fixture = path.join(__dirname, "browser", "chatgpt-virtualized.html");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function runFixture(query, timeoutMs = 150_000) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cca-chrome-"));
  const url = `${pathToFileURL(fixture).href}?${new URLSearchParams(query)}`;
  const browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--allow-file-access-from-files",
      "--window-size=1200,800",
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let socket;
  try {
    // Chrome writes the chosen debugging port into the profile directory.
    const portFile = path.join(profile, "DevToolsActivePort");
    const port = await waitFor(
      () => fs.existsSync(portFile) && fs.readFileSync(portFile, "utf8").split("\n")[0],
      30_000,
      "the DevTools port",
    );
    const targets = await waitFor(async () => {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((target) => target.type === "page") && list;
      } catch {
        return null;
      }
    }, 30_000, "a page target");
    const page = targets.find((target) => target.type === "page");

    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        nextId += 1;
        pending.set(nextId, resolve);
        socket.send(JSON.stringify({ id: nextId, method, params }));
      });

    await send("Page.navigate", { url });
    const text = await waitFor(async () => {
      const response = await send("Runtime.evaluate", {
        expression: "document.getElementById('out')?.textContent || ''",
        returnByValue: true,
      });
      const value = response.result?.result?.value || "";
      return value.startsWith("RESULT=") && value;
    }, timeoutMs, "the fixture result");

    const result = JSON.parse(text.slice("RESULT=".length));
    assert.equal(result.error, undefined, result.error);
    return result;
  } finally {
    socket?.close();
    // Wait for Chrome to exit before deleting its profile (Windows keeps
    // the files locked while the process runs).
    await new Promise((resolve) => {
      if (browser.exitCode !== null) return resolve();
      browser.once("exit", resolve);
      browser.kill();
      setTimeout(resolve, 10_000);
    });
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      // A leftover temporary profile is harmless; it never fails the test.
    }
  }
}

function expectedMessages(totalTurns) {
  const messages = [];
  for (let index = 0; index < totalTurns; index += 1) {
    messages.push({ role: "user", text: `USER-${index} שאלה ${index}` });
    messages.push({ role: "assistant", text: `ASSISTANT-${index} תשובה ${index}\ncode ${index}` });
  }
  return messages;
}

function assertCompleteConversation(result) {
  const { full } = result;
  const expected = expectedMessages(result.totalTurns);
  // The page itself only ever holds a small window of turns.
  assert.ok(result.domTurnsAtBottom <= 8, `DOM held ${result.domTurnsAtBottom} turns`);
  assert.ok(result.visibleCount < expected.length, "visible collection should be partial");
  const collected = full.messages
    .map(({ text }) => (text.match(/^(USER|ASSISTANT)-(\d+)/) || ["?"])[0])
    .join(" ");
  assert.equal(full.complete, true, `${full.warning}\ncollected: ${collected}`);
  assert.equal(full.messages.length, expected.length, `collected: ${collected}`);
  // Exact content and order: every user/assistant message once, in sequence.
  assert.deepEqual(
    full.messages.map(({ role, text }) => ({ role, text: text.replace(/\s*\n\s*/g, "\n") })),
    expected,
  );
  const texts = full.messages.map(({ text }) => text);
  assert.equal(new Set(texts).size, texts.length, "duplicate messages");
  for (const text of texts) {
    assert.doesNotMatch(text, /SIDEBAR|You said|EDIT|COPY/);
  }
  // The user's scroll position is restored.
  assert.equal(result.finalTop, result.originalTop);
  assertWalksForwardOnly(result);
  // Real progress: the reported position only grows and reaches the end.
  const percents = result.progress.map(({ percent }) => percent);
  for (let index = 1; index < percents.length; index += 1) {
    assert.ok(percents[index] >= percents[index - 1], `progress went back: ${percents}`);
  }
  assert.equal(percents.at(-1), 100);
}

// After the top is reached, the walk must only move down: no going back up
// to retry the same area (the "up a little and back" loop).
function assertWalksForwardOnly(result) {
  const positions = result.scrollPositions.slice(0, -1); // drop the final restore
  let topIndex = -1;
  positions.forEach((position, index) => {
    if (position <= 1) topIndex = index;
  });
  assert.ok(topIndex >= 0, "the walk never reached the top");
  const walk = positions.slice(topIndex);
  for (let index = 1; index < walk.length; index += 1) {
    assert.ok(
      walk[index] >= walk[index - 1] - 2,
      `scrolled back up from ${walk[index - 1]} to ${walk[index]}`,
    );
  }
}

const skip = browserPath ? false : "no Chrome/Edge executable found";

test("browser: full collection of a virtualized thread scrolled inside a container", { skip }, async () => {
  const result = await runFixture({ mode: "inner", turns: 60 });
  assertCompleteConversation(result);
  assert.match(result.visibleWarning, /איסוף שיחה מלאה/);
});

test("browser: full collection when the document itself scrolls", { skip }, async () => {
  assertCompleteConversation(await runFixture({ mode: "document", turns: 60 }));
});

test("browser: full collection loads older turns at the top before walking down", { skip }, async () => {
  assertCompleteConversation(await runFixture({ mode: "prepend", turns: 50 }));
});

test("browser: stopping early returns a partial, marked result and restores scroll", { skip }, async () => {
  const result = await runFixture({ mode: "inner", turns: 60, abortAfterMs: 1500 });
  const { full } = result;
  assert.equal(full.aborted, true);
  assert.equal(full.complete, false);
  assert.ok(full.messages.length > 0 && full.messages.length < 120);
  assert.equal(result.finalTop, result.originalTop);
});

test("browser: very tall turns (long answers) are collected completely, moving forward only", { skip }, async () => {
  // Each turn is twice the viewport height, so only one or two turns exist
  // in the DOM at a time.
  assertCompleteConversation(await runFixture({ mode: "inner", turns: 30, turnHeight: 1500 }));
});

test("browser: a page that keeps pulling the scroll back stops quickly with a clear reason", { skip }, async () => {
  const result = await runFixture({ mode: "inner", turns: 60, sticky: "1" });
  const { full } = result;
  assert.equal(full.complete, false);
  assert.equal(full.stopReason, "pulled-back");
  assert.match(full.warning, /החזיר את הגלילה/);
  // It must give up within seconds, not loop until the 120-second limit.
  assert.ok(result.elapsedMs < 30_000, `took ${result.elapsedMs} ms`);
  assert.equal(result.finalTop, result.originalTop);
});
