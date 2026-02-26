# DuperMemory — Architecture & Logic Reference

## What It Is

A Chrome extension (Manifest V3) that lets ChatGPT and Claude collaborate automatically.

The user talks to ChatGPT. They click one button. The extension:
1. Asks ChatGPT to summarize its own conversation into structured JSON
2. Opens Claude in a new tab
3. Injects that context into Claude's input and auto-submits
4. Waits for Claude's response
5. Sends Claude's response back to ChatGPT as a critique
6. ChatGPT revises its answer

No backend. No database. No user accounts. Everything is local and in-memory.

---

## Folder Structure

```
dupermemory/
├── manifest.json           Chrome extension config
├── background.js           Service worker — message router and tab manager
├── utils/
│   ├── summarize.js        Injected into chatgpt.com — asks ChatGPT to summarize itself
│   └── format.js           Loaded by background.js — formats summary into Claude's prompt
└── content/
    ├── chatgpt.js          Injected into chatgpt.com — button + critique receiver
    └── claude.js           Injected into claude.ai — injection, submit, response capture
```

---

## manifest.json

**Manifest V3.** No popup. No storage permission. Minimal surface area.

```
permissions:      ["tabs"]
host_permissions: ["https://chatgpt.com/*", "https://claude.ai/*"]
background:       service_worker → background.js
```

Content scripts are declared in the manifest (auto-injected, no scripting permission needed):

| Site | Scripts loaded (in order) | Run at |
|---|---|---|
| chatgpt.com | `utils/summarize.js`, `content/chatgpt.js` | document_idle |
| claude.ai | `content/claude.js` | document_idle |

**Why `summarize.js` is listed before `chatgpt.js`:** Both files are loaded into the same content script scope. Functions defined in `summarize.js` (`injectPromptIntoInput`, `submitInput`, `delay`, etc.) become globals that `chatgpt.js` can call directly — no imports needed.

**Why only `tabs` permission:** Content scripts auto-inject via manifest declaration (no `scripting` needed). `chrome.tabs.create` and `chrome.tabs.sendMessage` work with host permissions alone. `tabs` is needed only to read `tab.url` in `onUpdated` — but we use the PULL model instead (see background.js), so `tabs` is needed only for `chrome.tabs.create` and `chrome.tabs.sendMessage`.

---

## Message Protocol

All inter-component communication goes through `chrome.runtime`.

```
chatgpt.js  →  background    { type: "CAPTURE",        summary: {...} }
claude.js   →  background    { type: "CLAUDE_READY" }
background  →  claude.js     { type: "INJECT",         contextBlock: "..." }   ← sendResponse
claude.js   →  background    { type: "CLAUDE_RESPONSE", content: "..." }
background  →  chatgpt.js    { type: "INJECT_CRITIQUE", content: "..." }        ← tabs.sendMessage
```

**Two delivery mechanisms are used:**

- `chrome.runtime.sendMessage` + `sendResponse`: used for CLAUDE_READY → INJECT. Claude pulls its context; background responds synchronously. Race-free because background's listener is always alive.
- `chrome.tabs.sendMessage`: used for INJECT_CRITIQUE. Background pushes to a specific tab by ID. Can fail silently if the tab was closed — handled with `chrome.runtime.lastError`.

**CAPTURE has no callback.** Background doesn't call `sendResponse` for CAPTURE. Passing a callback when no response comes causes a "message port closed" error. The call is fire-and-forget.

---

## background.js — Service Worker

The only file with no DOM access. Pure message routing and tab management.

### State

```js
pendingContext[claudeTabId] = { contextBlock, sourceTabId }
pendingReview[claudeTabId]  = sourceTabId
```

**Why two maps instead of one:**
- `pendingContext` is consumed when `CLAUDE_READY` arrives (the context is delivered, no longer needed)
- But we still need to know the source tab ID to send the critique back later
- `pendingReview` preserves that mapping from CLAUDE_READY until CLAUDE_RESPONSE arrives

### Message handling

**CAPTURE** (`chatgpt.js` → background):
1. Calls `formatContextBlock(summary)` → plain-text context block
2. Opens `https://claude.ai` in a new tab
3. Stores `pendingContext[newTabId] = { contextBlock, sourceTabId: sender.tab.id }`

**CLAUDE_READY** (`claude.js` → background):
1. Looks up `pendingContext[sender.tab.id]`
2. If found: responds with `{ type: "INJECT", contextBlock }`, moves sourceTabId to `pendingReview`
3. If not found: responds with `null` (regular claude.ai visit, nothing to do)
4. Returns `false` — sendResponse is synchronous, no need to keep the channel open

**CLAUDE_RESPONSE** (`claude.js` → background):
1. Looks up `pendingReview[sender.tab.id]` → gets sourceTabId
2. Formats the critique: `"Another AI reviewed your answer. Revise your response considering this critique:\n\n" + content`
3. Sends `INJECT_CRITIQUE` to the original ChatGPT tab via `chrome.tabs.sendMessage`

### format.js (loaded via importScripts)

`importScripts("utils/format.js")` makes `formatContextBlock` available as a global in the service worker. ES module syntax (`import/export`) cannot be used here.

**Input:** `{ topic, user_goal, important_facts, decisions_made, current_task }`

**Output format:**
```
I am continuing a conversation from another AI. Here is the structured context:

{
  "topic": "...",
  "user_goal": "...",
  "important_facts": [...],
  "decisions_made": [...],
  "current_task": "..."
}

Please help me continue with: <current_task>
```

---

## utils/summarize.js — ChatGPT Self-Summarizer

Runs on `chatgpt.com` as a content script. Defines globals used by both itself and `chatgpt.js`.

### Side effect warning

This module sends a real message in the user's ChatGPT conversation. The summary prompt and ChatGPT's JSON response will be visible in the chat history. This is unavoidable without an external API.

### summarizeConversation()

```
1. Count existing assistant messages (baseline)
2. Inject SUMMARY_PROMPT into ChatGPT's input field
3. Wait 300ms for React to process the input event
4. Submit the prompt
5. Wait for a new assistant message to appear AND stabilize (2s no change)
6. Parse the response as JSON → return structured summary object
```

### SUMMARY_PROMPT

Instructs ChatGPT to return only a JSON object with five fields. The constraint "No other text" is stated twice — models tend to add preambles regardless of instructions.

### injectPromptIntoInput(text)

ChatGPT's input field has changed between versions:

| Version | Element | Injection method |
|---|---|---|
| Older | `<textarea id="prompt-textarea">` | Native HTMLTextAreaElement setter + `input` event |
| Newer | `<div id="prompt-textarea" contenteditable="true">` | `execCommand('selectAll') + execCommand('insertText')` |

**Why the native setter for textarea:** React controls the textarea through a synthetic event system. Setting `.value = "..."` directly bypasses React's internal state. The native setter (retrieved via `Object.getOwnPropertyDescriptor`) triggers the real DOM setter, which React intercepts correctly.

**Why `execCommand` for contenteditable:** `execCommand('insertText')` fires a native `InputEvent` that React, ProseMirror, and Lexical all listen for. Direct DOM mutation (`textContent = ...`) desynchronizes the framework's internal representation.

Fallback chain:
1. `#prompt-textarea` as textarea → native setter
2. `#prompt-textarea` as contenteditable → execCommand
3. Any contenteditable in the lower half of the viewport (positional fallback)

### submitInput()

Tries three approaches in order:
1. `[data-testid="send-button"]:not([disabled])` — ChatGPT's own test attribute
2. `button[aria-label*="Send"]:not([disabled])` — aria-label match
3. `form button[type="submit"]:not([disabled])` — generic HTML fallback
4. Enter keydown on `#prompt-textarea` — last resort

### waitForNewResponse(countBefore)

Two-phase poll at 500ms intervals:
- **Phase 1:** Wait for `assistantMessageCount > countBefore` AND content is non-empty
- **Phase 2:** Wait for `innerText` to be identical for 4 consecutive polls (2 seconds of no change)
- **Timeout:** 90 seconds

### parseSummary(rawText)

ChatGPT sometimes wraps JSON in markdown code fences even when explicitly told not to. The function strips ` ```json ` and ` ``` ` fences before calling `JSON.parse`.

On parse failure: returns a degraded object with `current_task` set to the raw text, preserving the information even without structure.

---

## content/chatgpt.js — ChatGPT Content Script

Two responsibilities: injecting the button and receiving the critique.

### Button injection

A fixed-position button (`position: fixed`, top-right corner, `z-index: 2147483647`) is appended to `document.body`.

**Why fixed position instead of anchoring to a ChatGPT DOM element:** ChatGPT's page structure changes frequently. A fixed-position element in `document.body` survives all of those changes — no DOM anchor needed, no selector to maintain.

**Double-injection guard:** Checks `document.getElementById(BUTTON_ID)` before creating the button. Guards against SPA soft-navigations that may re-run the content script.

### handleClick() — async

```
1. captureMessages() — read current conversation from DOM
2. If empty → alert user
3. setBusy(true) — disable button, show "Summarizing…"
4. await summarizeConversation() — injects prompt, waits, parses
5. chrome.runtime.sendMessage({ type: "CAPTURE", summary }) — no callback
6. setBusy(false) — restore button
```

On error: detects `"Extension context invalidated"` specifically (extension was reloaded, tab needs refresh) and shows a targeted message instead of the generic error.

### captureMessages()

Reads all `[data-message-author-role]` elements from the DOM.

**Why this selector:** It is a semantic data attribute — it describes what the element represents, not how it looks. Class names in ChatGPT are generated (Tailwind/CSS Modules) and change constantly. Data attributes are tied to behavior and meaning, so ChatGPT is unlikely to rename them without breaking their own code.

Roles captured: `"user"` and `"assistant"` only. `"tool"` (code interpreter output) is skipped.

### extractContent(messageEl)

**Problem:** `messageEl.innerText` includes button labels ("Copy", "Edit", "Regenerate", thumb icons) alongside the actual message text.

**Solution:** Clone the element, remove all `button` and `[role="button"]` elements and `[aria-hidden="true"]` elements from the clone, then read `innerText`. This is structural — it does not depend on any class names.

### INJECT_CRITIQUE listener

`chrome.runtime.onMessage` listener registered at script load time. When `INJECT_CRITIQUE` arrives from background:

1. Calls `injectPromptIntoInput(content)` — reuses the global from `summarize.js`
2. Waits 300ms
3. Calls `submitInput()` — reuses the global from `summarize.js`

No duplication: both functions are already defined in `summarize.js`, which shares the same content script scope.

---

## content/claude.js — Claude Content Script

### Startup: CLAUDE_READY signal (PULL model)

On load, immediately sends `{ type: "CLAUDE_READY" }` to background.

**Why PULL instead of PUSH:** The alternative (background pushing via `chrome.tabs.sendMessage` after `onUpdated` fires) has a race condition — the content script may not have registered its listener yet when background sends. In the PULL model, the content script initiates contact, so background's listener (always alive) is guaranteed to receive it.

If background responds with `null` → regular claude.ai visit, do nothing.
If background responds with `{ type: "INJECT", contextBlock }` → run `runInjectionFlow`.

### runInjectionFlow(contextBlock) — async

```
1. await waitForInput()       — MutationObserver waits for input to appear in DOM
2. injectText(inputEl, ...)   — inject context block into Claude's input
3. await delay(300)           — let framework process injection
4. snapshot = scopeEl.innerText  — baseline AFTER injection (key: injected text is now in baseline)
5. submitClaudeInput(inputEl) — click send button
6. await waitForClaudeResponse(scopeEl, snapshot)  — poll until stable
7. chrome.runtime.sendMessage({ type: "CLAUDE_RESPONSE", content })
```

### waitForInput()

Returns a Promise. Tries `findClaudeInput()` immediately (fast path). If not found, sets up a `MutationObserver` on `document.body` watching for `childList` + `subtree` changes. Resolves when the input appears. Rejects after 15 seconds.

**Why MutationObserver instead of polling:** Event-driven. No wasted CPU between DOM mutations. More reliable for SPA rendering where elements appear asynchronously after React hydration.

### findClaudeInput()

Selector priority (no class names):

| Priority | Selector | Reason |
|---|---|---|
| 1 | `[contenteditable="true"][role="textbox"]` | ARIA textbox role is the definitive semantic signal |
| 2 | `[contenteditable="true"][aria-label]` | Any explicitly-labelled contenteditable is intentional |
| 3 | `textarea` | Fallback if Claude ships a textarea version |
| 4 | Wide contenteditable in lower viewport | Geometric fallback — last resort |

### injectText(el, text)

Handles both `<textarea>` (native setter pattern) and contenteditable (`execCommand` pattern). Same logic as in `summarize.js` — Claude's input is also React-controlled.

### submitClaudeInput(inputEl)

Priority chain:
1. `button[aria-label*="Send"]:not([disabled])` — case variants
2. Walk up from input to find the nearest container (`closest("form")` or `parentElement`), then find a button inside it — works regardless of aria-label or test-id
3. Enter keydown with `composed: true` — helps cross shadow DOM boundaries

### Snapshot strategy for response capture

**Problem:** `body.innerText` includes Claude's sidebar (past conversation titles), which changes independently of the response and pollutes the diff.

**Solution:** Scope to `document.querySelector("main") || document.body`.

**Snapshot timing:** Taken AFTER `injectText` + 300ms settle. If taken before injection, the injected text would appear in the diff as "new content." By including it in the baseline, only Claude's actual response shows up as new.

### waitForClaudeResponse(scopeEl, snapshot)

Two-phase poll on `scopeEl.innerText.length` at 500ms intervals:
- **Phase 1:** Wait for length to exceed `snapshot.length + 50` (50 chars minimum to ignore tiny UI changes)
- **Phase 2:** Wait for length to be identical for 4 consecutive polls (2 seconds stable)
- **Timeout:** 90 seconds

### extractResponse(beforeText, afterText)

Slices `afterText` from `beforeText.length` onward. Splits by newline, filters out lines shorter than 10 characters (button labels: "Copy", "Share", single tokens during streaming). Joins remaining lines.

---

## Complete End-to-End Flow

```
[chatgpt.com tab]
User clicks "Ask another AI"
  → handleClick()
  → captureMessages()               reads [data-message-author-role] elements
  → summarizeConversation()
      → inject SUMMARY_PROMPT       into #prompt-textarea
      → submitInput()               clicks send button
      → waitForNewResponse()        polls until new assistant message stabilizes
      → parseSummary()              strips fences, JSON.parse, normalizes shape
  → sendMessage CAPTURE { summary }

[background.js]
  receives CAPTURE
  → formatContextBlock(summary)     builds plain-text prompt for Claude
  → chrome.tabs.create(claude.ai)
  → pendingContext[claudeTabId] = { contextBlock, sourceTabId }

[claude.ai tab — new]
  claude.js loads at document_idle
  → sendMessage CLAUDE_READY

[background.js]
  receives CLAUDE_READY
  → pendingContext[claudeTabId] consumed
  → pendingReview[claudeTabId] = chatgptTabId
  → sendResponse { type: "INJECT", contextBlock }

[claude.ai tab]
  receives INJECT response
  → waitForInput()                  MutationObserver until input appears
  → injectText()                    execCommand into contenteditable
  → delay(300)
  → snapshot = main.innerText       baseline after injection
  → submitClaudeInput()             click send button
  → waitForClaudeResponse()         poll scopeEl.innerText until stable 2s
  → extractResponse()               slice diff, filter short lines
  → sendMessage CLAUDE_RESPONSE { content }

[background.js]
  receives CLAUDE_RESPONSE
  → pendingReview[claudeTabId] consumed
  → builds critique: "Another AI reviewed your answer..."
  → tabs.sendMessage(chatgptTabId, INJECT_CRITIQUE)

[chatgpt.com tab]
  receives INJECT_CRITIQUE
  → injectCritique()
  → injectPromptIntoInput(critique) puts critique in ChatGPT input
  → delay(300)
  → submitInput()                   sends to ChatGPT

ChatGPT revises its answer.
```

---

## Known Limitations

| Limitation | Detail |
|---|---|
| Summarization prompt is visible | The JSON summary request and response appear in the ChatGPT chat history. Unavoidable without an external API. |
| Auto-submit in Claude unconfirmed | Claude's send button selector is not confirmed from a live DOM inspection. The container-walk fallback may match the wrong button. |
| Response capture is approximate | The `main.innerText` diff approach filters short lines but may still include UI chrome if Claude adds long labels to controls. |
| Extension reload requires tab refresh | After reloading the extension, the ChatGPT tab's content script is orphaned. The user must press F5. The error is now caught and reported clearly. |
| SPA navigation not fully handled | If the user navigates to a new ChatGPT conversation without a page reload, the injected button persists (correct) but captured messages may include messages from the previous conversation. |
| `document.execCommand` deprecated | Still functional in Chrome as of 2025. No direct replacement exists for contenteditable injection. |

---

## Selector Reference

| Site | What | Selector | Confidence |
|---|---|---|---|
| ChatGPT | Message containers | `[data-message-author-role]` | High — semantic data attribute |
| ChatGPT | Message role value | `.dataset.messageAuthorRole` | High |
| ChatGPT | Input field | `#prompt-textarea` | High — stable ID |
| ChatGPT | Send button | `[data-testid="send-button"]` | Medium — test attributes can change |
| Claude | Input field | `[contenteditable="true"][role="textbox"]` | Medium — not confirmed on live DOM |
| Claude | Send button | `button[aria-label*="Send"]` | Low — not confirmed on live DOM |
| Claude | Conversation area | `main` | Medium — standard semantic HTML |
