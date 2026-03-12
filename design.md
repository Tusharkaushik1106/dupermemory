# DuperMemory — MVP Design

## What It Does (exactly)

User is on a ChatGPT conversation page.
User clicks "Ask another AI" (a button injected by the extension).

The extension:
1. Extracts the conversation from the ChatGPT DOM
2. Formats it into a structured context block
3. Opens `claude.ai` in a new tab
4. Injects the context block into Claude's input field

That's the entire MVP. Nothing else.

---

## Flow

```
[User on chatgpt.com, mid-conversation]
         ↓
[Clicks "Ask another AI" button]
         ↓
[content/chatgpt.js reads messages from DOM]
         ↓
[Sends messages to background.js via chrome.runtime.sendMessage]
         ↓
[background.js formats messages into a context block]
         ↓
[background.js opens claude.ai in a new tab]
         ↓
[content/claude.js receives the context block]
         ↓
[content/claude.js injects text into Claude's input field]
```

---

## Files

```
dupermemory/
├── manifest.json
├── background.js
├── content/
│   ├── chatgpt.js      ← runs on chatgpt.com
│   └── claude.js       ← runs on claude.ai
└── popup/ (omitted from MVP — no popup needed)
```

---

## manifest.json

Manifest V3.

Permissions:
- `tabs` — to open a new Claude tab
- `scripting` — to send messages to content scripts

Host permissions:
- `https://chatgpt.com/*`
- `https://claude.ai/*`

---

## content/chatgpt.js

Runs on `chatgpt.com`.

Responsibilities:
1. Inject an "Ask another AI" button into the page
2. On click: read all messages from the DOM and send them to background.js

DOM capture:
- Messages live in elements with `data-message-author-role` attribute
- Attribute value is `"user"` or `"assistant"`
- Text content is the message body

Note: Selectors must be confirmed against the live DOM before writing code.

---

## background.js

Service worker. No DOM access.

Responsibilities:
1. Receive captured messages from chatgpt.js
2. Format into a context block (plain text, see below)
3. Open a new tab to `https://claude.ai`
4. Once the tab loads, send the context block to claude.js via `chrome.tabs.sendMessage`

No storage. The context block lives in memory only, passed directly to the new tab.

---

## content/claude.js

Runs on `claude.ai`.

Responsibilities:
1. Listen for a message from background.js containing the context block
2. Find Claude's input field
3. Inject the context block into the input field

Injection must use the React native setter pattern — setting `.value` directly does not work:

```js
const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype, 'value'
).set;
nativeInputValueSetter.call(inputEl, contextBlock);
inputEl.dispatchEvent(new Event('input', { bubbles: true }));
```

Note: Claude's input selector must be confirmed against the live DOM before writing code.

---

## Context Block Format

Plain text. No markdown. No JSON. Just readable structure.

```
[Context from ChatGPT]

User: <message>
Assistant: <message>
User: <message>
Assistant: <message>

---
What do you think about the above conversation?
```

The trailing prompt is a default. We can make it editable later — not in MVP.

---

## What We Are Not Building (MVP)

- No popup UI
- No storage / database
- No backend
- No authentication
- No Gemini support
- No summarization via external API
- No settings
- No relay back from Claude to ChatGPT

---

## Open Questions (must answer before coding)

1. What is the exact DOM selector for ChatGPT messages? (confirm on live site)
2. What is the exact DOM selector for Claude's input field? (confirm on live site)
3. Does Claude's input use a `<textarea>` or a `contenteditable` div? (affects injection code)
4. How do we know when ChatGPT has finished streaming a response before we capture?
5. Where exactly should the "Ask another AI" button be injected in the ChatGPT UI?
