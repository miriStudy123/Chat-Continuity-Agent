# Chat Continuity Agent

> **Note (2026-11-25):** the status, test-count, LangSmith and limitation
> sections below describe the state on 2026-11-24 and are kept as history.
> Current setup (the extension ID now has a built-in default), test results,
> LangSmith results, ChatGPT full collection and verification status are in
> the [main README](../README.md).

The project contains a Manifest V3 Chrome extension and a local FastAPI
backend. The extension has separate DOM extractors for ChatGPT, Claude, and
Gemini. Their selectors depend on each site's changing markup and have not yet
been verified against authenticated live conversations in the current
environment.

## Architecture

1. The popup identifies the source site and asks its content script to collect
   messages from the active tab. The extractors query the page DOM and do not
   scroll it (since 2026-11-25, ChatGPT additionally offers a separate full
   collection that scrolls; see the main README).
2. Collection and sending are separate actions. The popup shows a count and
   requires a separate user action before posting the transcript to
   `http://127.0.0.1:8000`.
3. FastAPI starts the existing LangGraph workflow: validate the transcript,
   analyze it with Gemini, check output quality, prepare a review, and pause at
   the human-approval interrupt. The user can approve or reject; approved
   project state is saved through the existing SQLite storage/checkpointer.
4. The extension stores only a pending `thread_id`, not the transcript.
5. LangSmith configuration is loaded by the backend at startup. Production
   requests explicitly disable tracing so real conversation text is not sent
   to LangSmith without a separate user-consent flow. The dedicated
   `backend.langsmith_eval` command enables tracing only for synthetic runs.

The DOM selectors are scoped to page regions, but the code does not currently
prove that every matched element is within the visible viewport. The warning
also notes that messages not loaded into the page may be missing. Do not treat
collection as complete without checking the count and testing the relevant
authenticated page.

## Installation and startup

Run these commands from the repository root in PowerShell:

```powershell
py -m venv backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install fastapi langgraph langgraph-checkpoint-sqlite python-dotenv google-genai langsmith uvicorn
```

The dependency list is maintained in `backend/pyproject.toml`; dependency
versions are not pinned in a lock file.

Configure `GEMINI_API_KEY` locally in `backend/.env`. Do not put it in the
extension, commit it, or share its value.

In the same PowerShell session, load the unpacked extension from the project's
`extension` folder at `chrome://extensions`, then set the extension ID shown by
Chrome and start the backend:

```powershell
$env:CHAT_CONTINUITY_EXTENSION_ID = "<ID shown by chrome://extensions>"
.\backend\.venv\Scripts\python.exe -m backend.server
```

The server binds to `127.0.0.1:8000`. Keep the server process running while
using the extension. The extension ID is a public Chrome identifier, not an
API secret.

## Tests and verification status

Run the local tests from the repository root:

```powershell
node --test extension/tests/*.test.js
.\backend\.venv\Scripts\python.exe -m unittest backend.test_graph -v
```

The extractor tests use synthetic DOM fixtures. The backend tests replace the
Gemini client with a fake client. They validate local logic, not the current
DOM of any AI site or a live Gemini API request.

Latest local run: 11 extension tests and 5 backend tests passed; JavaScript
syntax and Manifest parsing checks passed.

Live DOM inspection was attempted without reading or returning message text.
The available ChatGPT page was logged out and had no matching message
elements. The Claude page was a login/security-verification page; its broad
`.font-claude-response` fallback matched page headings as well as other
elements, so that selector must not be considered proof of a chat message. The
Gemini page was unauthenticated and the current network returned NetFree
blocking responses. None of these page-shell observations validates
collection from a real conversation.

## LangSmith status

The installed LangSmith SDK is version 0.16.0. The backend `.env` settings
were checked without displaying their values: tracing is enabled, the project
matches `Chat-Continuity-Agent`, and the SDK credential is present. The
backend now loads `.env` before serving requests. Real API requests still
disable LangSmith tracing to prevent real conversation content from leaving
the machine without a separate consent flow.

Run the synthetic trace and evaluation command from the repository root on a
network that can verify LangSmith's TLS certificate:

```powershell
.\backend\.venv\Scripts\python.exe -m backend.langsmith_eval
```

The command uses the existing LangGraph with a local synthetic analyzer,
reaches the existing approval interrupt, and makes no Gemini API calls. It
creates/reuses a two-example synthetic Dataset and runs a before/after
Evaluation of the existing quality-retry behavior. No real conversation
content is included.

The actual LangSmith run attempted on 2026-11-24 failed TLS certificate
verification against `api.smith.langchain.com`. The trace could not be
confirmed in the account; Dataset creation and remote Evaluation were not
reached. A separate local single-example smoke check passed: the no-retry
baseline matched 8/9 expected fields (0.889), while the existing retry path
matched 9/9 (1.000). This is a local synthetic Mock result, not a LangSmith
experiment and not a Gemini result.

## Known limitations and remaining validation

- ChatGPT and Gemini selectors still need validation and, if necessary,
  correction against authenticated live conversations. The current network
  prevents completing that check for Gemini.
- Claude previously returned five messages in a user-run test, but no
  authenticated Claude conversation was available for independent
  verification here. Its broad fallback can match non-chat page content.
- No live Gemini API analysis was run. The current network blocks the Google
  Generative Language API; do not bypass that block or disable TLS verification.
- LangSmith Dataset creation, remote automatic Evaluation, remote before/after
  experiment, verified Traces, and a trace-derived insight remain incomplete
  until the command succeeds in a network trusted for LangSmith.
- No transcript was sent to Gemini during the LangSmith checks. The LangSmith
  command is limited to synthetic examples.

## Screenshots required for project evidence

Capture these manually using synthetic conversation content only. Redact
account identifiers and any unrelated private page content.

1. The extension recognizing each source platform and showing the collected
   message count.
2. The review screen showing the summary and continuation prompt before
   approval.
3. The explicit send-consent step and the final approved prompt-copy state.
4. After the LangSmith command succeeds: the synthetic Dataset, before/after
   Evaluation results, and one redacted graph Trace showing the workflow and
   approval interrupt.

No screenshot should be labeled as evidence of a live test unless that exact
test was performed.
