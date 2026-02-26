// utils/summarize.js
//
// Asks ChatGPT to summarize its own conversation by injecting a prompt into
// the input field, submitting it, waiting for the response, and parsing it.
//
// ⚠️  SIDE EFFECT: This sends a real message in the user's ChatGPT conversation.
//     The summary prompt and ChatGPT's JSON response will be visible in the chat.
//     This is unavoidable without an external API.
//
// Loaded as a content script before content/chatgpt.js via manifest.json.
// Must not use ES module syntax — functions are plain globals.

// ─── Prompt ───────────────────────────────────────────────────────────────────

// We tell ChatGPT exactly what shape to return and repeat the constraint
// ("no other text") twice because models tend to add preambles otherwise.
// The field descriptions are inline so ChatGPT knows what each field means
// without us having to include the full conversation in the prompt text.
//
// Extended from the original to also request entities, open_questions,
// and constraints. These feed into the central memory layer (utils/memory.js).
const SUMMARY_PROMPT =
  "Summarize our conversation for a browser extension. " +
  "Reply with ONLY valid JSON — no markdown fences, no explanation, nothing else. " +
  "Use exactly this structure:\n" +
  "{\n" +
  '  "topic": "one sentence — what this conversation is about",\n' +
  '  "user_goal": "what the user is ultimately trying to accomplish",\n' +
  '  "important_facts": ["key fact or constraint mentioned", "..."],\n' +
  '  "decisions_made": ["conclusion or choice that was reached", "..."],\n' +
  '  "current_task": "the specific thing being worked on most recently",\n' +
  '  "entities": [\n' +
  '    { "name": "entity name", "type": "technology | concept | tool | requirement | constraint | other", "summary": "one sentence about this entity in context" }\n' +
  "  ],\n" +
  '  "open_questions": ["unresolved question from the conversation", "..."],\n' +
  '  "constraints": ["hard constraint the user stated", "..."]\n' +
  "}\n" +
  "No other text.";

// ─── Main entry point ─────────────────────────────────────────────────────────

// Returns a Promise that resolves to:
//   { topic, user_goal, important_facts, decisions_made, current_task }
async function summarizeConversation() {
  // Record how many assistant messages exist right now.
  // We use this to detect when ChatGPT's new response has appeared.
  const countBefore = countAssistantMessages();

  const injected = injectPromptIntoInput(SUMMARY_PROMPT);
  if (!injected) {
    throw new Error("[DuperMemory] Could not find ChatGPT's input field.");
  }

  // Brief pause to let React process the input event before we try to submit.
  await delay(300);

  const submitted = submitInput();
  if (!submitted) {
    throw new Error("[DuperMemory] Could not submit the summarization prompt.");
  }

  const rawText = await waitForNewResponse(countBefore);
  return parseSummary(rawText);
}

// ─── Count assistant messages ─────────────────────────────────────────────────

function countAssistantMessages() {
  return document.querySelectorAll("[data-message-author-role='assistant']").length;
}

// ─── Input injection ──────────────────────────────────────────────────────────

function injectPromptIntoInput(text) {
  // ChatGPT's input field has changed across UI versions:
  //   Older:  <textarea id="prompt-textarea">
  //   Newer:  <div id="prompt-textarea" contenteditable="true">
  //
  // We check for #prompt-textarea first (stable id, used consistently),
  // then inspect its type to pick the right injection method.

  const el = document.querySelector("#prompt-textarea");

  if (el) {
    if (el.tagName === "TEXTAREA") {
      return injectIntoTextarea(el, text);
    }
    if (el.isContentEditable) {
      return injectIntoContentEditable(el, text);
    }
  }

  // Fallback: scan for a contenteditable element positioned in the lower half
  // of the viewport (where the ChatGPT input typically lives).
  // This is intentionally fuzzy — it only runs if #prompt-textarea is absent.
  console.warn("[DuperMemory] #prompt-textarea not found. Trying positional fallback.");
  return injectViaPositionalFallback(text);
}

function injectIntoTextarea(textarea, text) {
  // React controls this textarea via a synthetic event system.
  // Setting .value directly does not trigger React's onChange handler.
  // We must call the native HTMLTextAreaElement setter, then dispatch
  // a real 'input' event so React picks up the change.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;
  nativeSetter.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
  return true;
}

function injectIntoContentEditable(editor, text) {
  // document.execCommand is deprecated but remains the most reliable way
  // to inject text into a contenteditable element in Chrome while correctly
  // triggering the native InputEvent that React/ProseMirror/Lexical listen for.
  //
  // We select-all then delete first so we start from an empty state,
  // avoiding appending to whatever the user had already typed.
  editor.focus();
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);

  const ok = document.execCommand("insertText", false, text);

  if (!ok) {
    // execCommand can return false in certain sandboxed environments.
    // Fallback: set textContent directly and fire a manual InputEvent.
    // Less reliable with React but better than failing silently.
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
  }

  return true;
}

function injectViaPositionalFallback(text) {
  const editors = document.querySelectorAll("[contenteditable='true']");
  for (const el of editors) {
    const rect = el.getBoundingClientRect();
    // The main input is wide and lives in the lower portion of the page.
    if (rect.width > 200 && rect.bottom > window.innerHeight * 0.5) {
      return injectIntoContentEditable(el, text);
    }
  }
  return false;
}

// ─── Submit ───────────────────────────────────────────────────────────────────

function submitInput() {
  // Try a chain of selectors, each more generic than the last.
  //
  //   [data-testid="send-button"]        — ChatGPT's own test attribute (stable-ish)
  //   button[aria-label*="Send"]          — aria-label match, survives visual changes
  //   form button[type="submit"]          — generic HTML fallback
  //
  // We exclude disabled buttons because ChatGPT disables the send button while
  // a response is streaming. If it is disabled, the input injection hasn't
  // registered yet — which shouldn't happen after our 300ms delay, but we guard anyway.

  const sendBtn = document.querySelector(
    '[data-testid="send-button"]:not([disabled]),' +
    'button[aria-label*="Send"]:not([disabled]),' +
    'form button[type="submit"]:not([disabled])'
  );

  if (sendBtn) {
    sendBtn.click();
    return true;
  }

  // Last resort: synthesize an Enter keydown on the input field.
  // ChatGPT submits on plain Enter (Shift+Enter inserts a newline).
  const inputEl = document.querySelector("#prompt-textarea") || document.activeElement;
  if (inputEl) {
    inputEl.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      })
    );
    return true;
  }

  return false;
}

// ─── Wait for response ────────────────────────────────────────────────────────

// Two-phase poll:
//   Phase 1 — wait for a NEW assistant message to appear (count > countBefore).
//   Phase 2 — wait for that message to stop changing (streaming complete).
//
// "Stable" means the innerText hasn't changed for STABLE_NEEDED consecutive
// polls. We use 500ms intervals and require 4 stable checks = 2 seconds of
// no change, which is long enough to survive mid-stream pauses.

function waitForNewResponse(countBefore) {
  const POLL_MS       = 500;
  const STABLE_NEEDED = 4;
  const TIMEOUT_MS    = 90_000; // 90s — enough for a long streaming response

  return new Promise((resolve, reject) => {
    let phase       = 1; // 1 = waiting for new message, 2 = waiting for stability
    let lastContent = "";
    let stableCount = 0;
    let elapsed     = 0;

    const tick = () => {
      if (elapsed >= TIMEOUT_MS) {
        reject(new Error("[DuperMemory] Timed out waiting for ChatGPT's summary response."));
        return;
      }

      const allMsgs    = document.querySelectorAll("[data-message-author-role='assistant']");
      const curCount   = allMsgs.length;
      const lastMsg    = allMsgs[curCount - 1];
      const curContent = lastMsg ? lastMsg.innerText.trim() : "";

      if (phase === 1) {
        // A new message has appeared and has some content — begin stability check.
        if (curCount > countBefore && curContent.length > 0) {
          phase = 2;
          lastContent = curContent;
        }
      } else {
        if (curContent === lastContent) {
          stableCount++;
          if (stableCount >= STABLE_NEEDED) {
            resolve(curContent);
            return;
          }
        } else {
          // Still streaming — reset stable counter.
          stableCount = 0;
          lastContent = curContent;
        }
      }

      elapsed += POLL_MS;
      setTimeout(tick, POLL_MS);
    };

    setTimeout(tick, POLL_MS);
  });
}

// ─── Parse summary ────────────────────────────────────────────────────────────

function parseSummary(rawText) {
  // ChatGPT sometimes wraps JSON in markdown code fences even when told not to.
  // Strip the most common patterns before attempting JSON.parse.
  const cleaned = rawText
    .replace(/^```(?:json)?[\r\n]*/im, "")
    .replace(/[\r\n]*```\s*$/im, "")
    .trim();

  try {
    const obj = JSON.parse(cleaned);

    // Normalise: guarantee all expected fields exist with the right types,
    // regardless of what ChatGPT actually returned.
    return {
      topic:           String(obj.topic           || ""),
      user_goal:       String(obj.user_goal        || ""),
      important_facts: Array.isArray(obj.important_facts) ? obj.important_facts.map(String) : [],
      decisions_made:  Array.isArray(obj.decisions_made)  ? obj.decisions_made.map(String)  : [],
      current_task:    String(obj.current_task     || ""),
      entities:        Array.isArray(obj.entities) ? obj.entities.filter(function (e) { return e && e.name; }) : [],
      open_questions:  Array.isArray(obj.open_questions) ? obj.open_questions.map(String) : [],
      constraints:     Array.isArray(obj.constraints) ? obj.constraints.map(String) : [],
    };
  } catch {
    // JSON parsing failed. Degrade gracefully: keep the raw text so the user
    // doesn't lose information. The context block will still be sent to Claude,
    // just without the structured fields.
    console.warn("[DuperMemory] Could not parse summary JSON. Raw text follows:", rawText);
    return {
      topic:           "",
      user_goal:       "",
      important_facts: [],
      decisions_made:  [],
      current_task:    rawText,
      entities:        [],
      open_questions:  [],
      constraints:     [],
    };
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
