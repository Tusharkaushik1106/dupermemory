# DuperMemory

**Cross-AI conversation bridge for your browser.**

DuperMemory is a Chrome extension that lets you take a conversation from one AI and send it to another AI for a second opinion, critique, or alternative take — then routes the response back. One click. No copy-pasting.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen)
![Version](https://img.shields.io/badge/Version-0.5.0-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

---

## What it does

You're mid-conversation with ChatGPT and want Claude's take on it. Click the DuperMemory button, pick Claude, and the extension:

1. Captures the conversation from ChatGPT
2. Opens Claude in a new tab
3. Injects the conversation as context and submits it
4. Waits for Claude's response
5. Sends Claude's response back to ChatGPT as a critique

That's the full loop. Works between any combination of the five supported AIs.

## Supported AIs

| AI | Source | Target |
|---|---|---|
| ChatGPT | Yes | Yes |
| Claude | Yes | Yes |
| Gemini | Yes | Yes |
| Perplexity | Yes | Yes |
| DeepSeek | Yes | Yes |

Every AI can talk to every other AI. 20 possible routes.

## Features

- **One-click cross-AI routing** — draggable FAB appears on every supported AI site
- **Bidirectional** — every AI is both a source and a target
- **Tabbed UI** — glassmorphism popover with Ask AI, Replay, and Vault tabs
- **Replay mode** — send a raw transcript to another AI for critical evaluation
- **Context Vault** — global system instructions (e.g., "Always use TypeScript") prepended to every transfer
- **Code diff engine** — visual line-level diffs when a critique modifies code blocks
- **Markdown export** — one-click export of any conversation as a clean `.md` file with preserved formatting and code fences
- **Context flattener** — strips recursive meta-prompt nesting from chained transfers (AI #1 → #2 → #3)
- **Context menu** — right-click selected text and send it to any AI
- **Keyboard shortcut** — `Ctrl+Shift+D` toggles the dropdown
- **Memory system** — stores conversation context (topics, entities, decisions) in local storage
- **Popup dashboard** — view and manage stored memories per conversation
- **Status feedback** — FAB morphs into a loading pill with spinner: Capturing → Opening → Waiting → Done
- **Production safeguards** — UI state lock prevents double-clicks, toast notifications, massive chat truncation (80k+ chars)

## Installation

### From GitHub Release

1. Download `dupermemory.zip` from the [latest release](../../releases/latest)
2. Extract the zip
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (top right)
5. Click **Load unpacked**
6. Select the extracted folder (the one with `manifest.json` in it)

### From Source

```bash
git clone https://github.com/Tusharkaushik1106/dupermemory.git
```

Then load the cloned folder as an unpacked extension (same steps 3-6 above).

## How it works

```
┌─────────────┐    CAPTURE     ┌──────────────┐    INJECT      ┌─────────────┐
│  Source AI   │ ────────────→ │  Background   │ ────────────→ │  Target AI  │
│ (content.js) │               │  (service     │               │ (content.js) │
│             │ ←──────────── │   worker)     │ ←──────────── │             │
└─────────────┘ INJECT_CRITIQUE└──────────────┘  RESPONSE     └─────────────┘
```

Each supported AI has a content script that knows how to:
- Read the conversation from the DOM
- Type into the input field and submit
- Detect when a response is complete

The background service worker routes messages between tabs and manages memory.

## Project Structure

```
manifest.json          Extension config (MV3)
background.js          Service worker — message routing, memory, vault, context menus
popup.html / popup.js  Dashboard for viewing stored memories

content/
  chatgpt.js           ChatGPT content script (source + target)
  claude.js            Claude content script (source + target)
  gemini.js            Gemini content script (source + target)
  perplexity.js        Perplexity content script (source + target)
  deepseek.js          DeepSeek content script (source + target)

utils/
  models.js            Model registry and lookups
  format.js            Context block formatting (sandwich pattern)
  memory.js            Storage read/write/merge/evict
  summarize-generic.js Parsing, context flattening, meta-prompt stripping
  ui-inject.js         Shared UI — draggable FAB, tabbed popover, status, vault, export
  diff-engine.js       LCS-based code diff engine with inline HTML rendering
  export-engine.js     Markdown export with code fence preservation
  replay-prompt.js     Replay meta-prompt builder
```

## Tech

- **Manifest V3** — service workers, no background pages
- **Zero dependencies** — no npm packages, no build step, no bundler
- **Pure DOM manipulation** — content scripts interact directly with each AI interface
- **Chrome Storage API** — conversation memory persists across sessions
- **~42KB zipped** — the whole extension

## Limitations

- Only works in Chrome (or Chromium-based browsers)
- Depends on each AI site's DOM structure — if they redesign their UI, selectors may break
- Each AI must be used in its own tab (no iframes or embedded views)
- You need to be logged into both the source and target AI

---

Built by [@Tusharkaushik1106](https://github.com/Tusharkaushik1106)
