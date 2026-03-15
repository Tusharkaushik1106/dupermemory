// content/claude.js — Runs on https://claude.ai/*
//
// Both SOURCE and TARGET:
//
// TARGET:
//   1. Signal CLAUDE_READY → get context block from background
//   2. Wait for input field → inject context → auto-submit
//   3. Wait for response to stabilize → send CLAUDE_RESPONSE
//
// SOURCE:
//   - "Ask another AI" button with model dropdown
//   - Direct DOM capture: reads conversation text from the DOM,
//     sends transcript to background via CAPTURE message
//   - INJECT_CRITIQUE listener: receives critique from target AI
//
// Globals from utils/summarize-generic.js (loaded before this file):
//   parseSummary(), delay()

var DUPERMEM_SOURCE_MODEL = "claude";

// When this tab was opened as a target by DuperMemory, store the chain's
// conversation ID so that if the user later uses this tab as a source,
// the memory stays linked across hops (AI #1 → AI #2 → AI #3).
var DUPERMEM_CHAIN_CONV_ID = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET FLOW — runs immediately on load
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ type: "CLAUDE_READY" }, function (response) {
  if (chrome.runtime.lastError) {
    return;
  }
  if (!response || response.type !== "INJECT" || !response.contextBlock) {
    return;
  }
  if (response.conversationId) {
    DUPERMEM_CHAIN_CONV_ID = response.conversationId;
  }
  runTargetInjectionFlow(response.contextBlock).catch(function (err) {
    console.error("[DuperMemory] Claude target injection flow failed:", err.message);
  });
});

async function runTargetInjectionFlow(contextBlock) {
  var inputEl = await waitForClaudeInput();

  injectText(inputEl, contextBlock);
  await delay(300);

  var scopeEl = document.querySelector("main") || document.body;
  var snapshot = scopeEl.innerText;

  var submitted = submitClaudeInput(inputEl);
  if (!submitted) {
    throw new Error("Could not submit to Claude — no send button found.");
  }

  var claudeResponse = await waitForClaudeResponse(scopeEl, snapshot);

  if (!claudeResponse) {
    console.warn("[DuperMemory] Claude response captured was empty. Not sending back.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "CLAUDE_RESPONSE", content: claudeResponse },
    function () {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] CLAUDE_RESPONSE send failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE FLOW — button + dropdown + self-summarization
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  // Claude URLs: https://claude.ai/chat/abc123-def456
  var match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
  if (match) return "claude_" + match[1];
  return "claude_conv_" + Date.now();
}

// ─── Critique receiver ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === "INJECT_CRITIQUE") {
    injectCritiqueFlow(message.content).catch(function (err) {
      console.error("[DuperMemory] Critique injection failed:", err.message);
    });
  }
});

async function injectCritiqueFlow(content) {
  var inputEl = await waitForClaudeInput();
  injectText(inputEl, content);
  await delay(300);
  submitClaudeInput(inputEl);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED DOM HELPERS (used by both source and target flows)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Wait for input field ─────────────────────────────────────────────────────

function waitForClaudeInput() {
  return new Promise(function (resolve, reject) {
    var existing = findClaudeInput();
    if (existing) { resolve(existing); return; }

    var settled = false;

    var observer = new MutationObserver(function () {
      var el = findClaudeInput();
      if (!el) return;
      settled = true;
      observer.disconnect();
      clearTimeout(timeoutId);
      resolve(el);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    var timeoutId = setTimeout(function () {
      if (settled) return;
      observer.disconnect();
      var el = findClaudeInput();
      if (el) resolve(el);
      else reject(new Error("Claude input field not found after 15 seconds."));
    }, 15000);
  });
}

function findClaudeInput() {
  var byRole = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (byRole) return byRole;

  var byAriaLabel = document.querySelector('[contenteditable="true"][aria-label]');
  if (byAriaLabel) return byAriaLabel;

  var textarea = document.querySelector("textarea");
  if (textarea) return textarea;

  var editors = document.querySelectorAll('[contenteditable="true"]');
  for (var i = 0; i < editors.length; i++) {
    var rect = editors[i].getBoundingClientRect();
    if (rect.width > 200 && rect.bottom > window.innerHeight * 0.4) return editors[i];
  }

  return null;
}

// ─── Inject text ──────────────────────────────────────────────────────────────

function injectText(el, text) {
  el.focus();

  if (el.tagName === "TEXTAREA") {
    var nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    ).set;
    nativeSetter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
  var ok = document.execCommand("insertText", false, text);

  if (!ok) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    console.warn("[DuperMemory] execCommand('insertText') failed; used textContent fallback.");
  }
}

// ─── Submit Claude's input ────────────────────────────────────────────────────

function submitClaudeInput(inputEl) {
  var byAriaLabel = document.querySelector(
    'button[aria-label*="Send"]:not([disabled]),' +
    'button[aria-label*="send"]:not([disabled])'
  );
  if (byAriaLabel) { byAriaLabel.click(); return true; }

  if (inputEl) {
    var container = inputEl.closest("form") || inputEl.parentElement;
    if (container) {
      var btn = container.querySelector("button:not([disabled])");
      if (btn) { btn.click(); return true; }
    }
  }

  if (inputEl) {
    inputEl.focus();
    inputEl.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13,
      bubbles: true, cancelable: true, composed: true,
    }));
    return true;
  }

  return false;
}

// ─── Wait for Claude's response ───────────────────────────────────────────────

function waitForClaudeResponse(scopeEl, snapshot) {
  var POLL_MS       = 500;
  var STABLE_NEEDED = 4;
  var MIN_NEW_CHARS = 50;
  var TIMEOUT_MS    = 90000;

  return new Promise(function (resolve, reject) {
    var phase       = 1;
    var lastLength  = scopeEl.innerText.length;
    var stableCount = 0;
    var elapsed     = 0;

    function tick() {
      if (elapsed >= TIMEOUT_MS) {
        reject(new Error("Timed out waiting for Claude's response."));
        return;
      }

      var currentText = scopeEl.innerText;

      if (phase === 1) {
        if (currentText.length > snapshot.length + MIN_NEW_CHARS) {
          phase = 2;
          lastLength = currentText.length;
        }
      } else {
        if (currentText.length === lastLength) {
          stableCount++;
          if (stableCount >= STABLE_NEEDED) {
            resolve(extractResponse(snapshot, currentText));
            return;
          }
        } else {
          stableCount = 0;
          lastLength  = currentText.length;
        }
      }

      elapsed += POLL_MS;
      setTimeout(tick, POLL_MS);
    }

    setTimeout(tick, POLL_MS);
  });
}

// ─── Message capture ──────────────────────────────────────────────────────────
//
// Strategy: Claude's conversation DOM uses several possible structures.
// Primary: [data-is-streaming] on assistant containers, user messages in
// human turn wrappers. Fallback: alternating message groups inside the
// conversation thread container, identified by fieldset boundaries or
// role-based ARIA attributes.

function captureMessages() {
  // ── Primary: data attribute on message containers ──────────────────────
  // Claude uses data-testid or class-based markers on turn containers.
  // User turns often contain a div with "human" in a data attribute or class;
  // assistant turns contain the streaming/rendered response.

  var messages = tryStructuredCapture();
  if (messages.length > 0) return messages;

  // ── Fallback: conversation thread child groups ─────────────────────────
  messages = tryThreadChildCapture();
  if (messages.length > 0) return messages;

  // ── Last resort: fieldset-based grouping ───────────────────────────────
  messages = tryFieldsetCapture();
  return messages;
}

function tryStructuredCapture() {
  var messages = [];

  // Look for the conversation container
  var thread =
    document.querySelector('[class*="conversation-content"]') ||
    document.querySelector('[class*="chat-messages"]') ||
    document.querySelector('[role="log"]') ||
    document.querySelector('[role="main"] [class*="thread"]');
  if (!thread) {
    thread = document.querySelector("main");
  }
  if (!thread) return [];

  // Claude renders user and assistant turns as direct child groups.
  // Each group typically has a distinguishing attribute or structure:
  //   - User messages: contain a human avatar or "Human" label, or have
  //     data-is-user / [class*="human"] markers.
  //   - Assistant messages: contain [class*="markdown"] or [class*="prose"],
  //     or have data-is-streaming.

  // Try to find turn containers with data attributes
  var turns = thread.querySelectorAll(
    '[data-testid*="message"], [data-testid*="turn"], ' +
    '[class*="turn-"], [class*="message-row"], [class*="msg-"]'
  );

  if (turns.length === 0) {
    // Broader: direct children of the thread that look like message groups
    // (skip small elements like spacers/dividers)
    var children = thread.children;
    var candidates = [];
    for (var c = 0; c < children.length; c++) {
      if (children[c].offsetHeight > 30 && children[c].textContent.trim().length > 5) {
        candidates.push(children[c]);
      }
    }
    turns = candidates;
  }

  for (var i = 0; i < turns.length; i++) {
    var el = turns[i];
    var role = inferClaudeRole(el);
    if (!role) continue;

    var content = extractCleanContent(el);
    if (content) messages.push({ role: role, content: content });
  }

  return messages;
}

function tryThreadChildCapture() {
  var messages = [];
  // Look for the scrollable conversation area
  var scroller = document.querySelector('[class*="overflow-y-auto"]') ||
                 document.querySelector('[class*="scroll"]');
  if (!scroller) return [];

  // Walk direct children, alternating user/assistant
  var children = scroller.children;
  for (var i = 0; i < children.length; i++) {
    var el = children[i];
    if (el.offsetHeight < 20) continue;
    var text = extractCleanContent(el);
    if (!text) continue;

    var role = inferClaudeRole(el);
    if (!role) {
      // Alternate: even = user, odd = assistant (for the message children)
      role = (messages.length % 2 === 0) ? "user" : "assistant";
    }
    messages.push({ role: role, content: text });
  }

  return messages;
}

function tryFieldsetCapture() {
  var messages = [];
  var fieldsets = document.querySelectorAll("fieldset");
  for (var i = 0; i < fieldsets.length; i++) {
    var content = extractCleanContent(fieldsets[i]);
    if (!content) continue;
    // Fieldsets in Claude's UI typically wrap assistant responses
    messages.push({ role: "assistant", content: content });
  }
  return messages;
}

// ─── Role inference for Claude ───────────────────────────────────────────────
//
// Uses multiple signals: data attributes, class names, ARIA labels,
// avatar/icon presence, and text markers.

function inferClaudeRole(el) {
  var html = el.outerHTML.slice(0, 500).toLowerCase();

  // Explicit data attributes
  if (el.dataset && el.dataset.isUser !== undefined) return "user";
  if (/data-is-user/.test(html)) return "user";

  // Class-name signals
  if (/\bhuman\b/.test(html) || /\buser[-_]/.test(html) || /\buser-message\b/.test(html)) return "user";
  if (/\bassistant\b/.test(html) || /\bclaude\b/.test(html) || /\bai[-_]/.test(html) || /\bbot[-_]/.test(html)) return "assistant";

  // ARIA labels
  var ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  if (/human|user|you/.test(ariaLabel)) return "user";
  if (/assistant|claude|ai/.test(ariaLabel)) return "assistant";

  // Content wrappers: .markdown / .prose are assistant-only
  if (el.querySelector('.markdown, .prose, [class*="markdown"], [class*="rendered"]')) return "assistant";

  // Avatar heuristics: user avatars are typically small images/initials,
  // Claude's icon is an SVG with specific paths
  var imgs = el.querySelectorAll("img");
  for (var j = 0; j < imgs.length; j++) {
    var alt = (imgs[j].alt || "").toLowerCase();
    var src = (imgs[j].src || "").toLowerCase();
    if (/user|avatar|you/.test(alt) || /user|avatar/.test(src)) return "user";
    if (/claude|assistant|anthropic/.test(alt) || /claude|anthropic/.test(src)) return "assistant";
  }

  return null;
}

// ─── Clean content extraction ────────────────────────────────────────────────

function extractCleanContent(el) {
  var clone = el.cloneNode(true);

  // Remove interactive UI elements and decorations
  var junk = clone.querySelectorAll(
    'button, [role="button"], svg, [aria-hidden="true"], ' +
    '[class*="copy"], [class*="toolbar"], [class*="action"], [class*="avatar"], ' +
    '[class*="icon"], [class*="badge"], [class*="timestamp"], ' +
    '[aria-label="Copy"], [aria-label="Retry"]'
  );
  for (var i = 0; i < junk.length; i++) {
    junk[i].remove();
  }

  // Prefer narrow content wrapper
  var wrapper =
    clone.querySelector(".markdown") ||
    clone.querySelector(".prose") ||
    clone.querySelector('[class*="markdown"]') ||
    clone.querySelector('[class*="message-content"]') ||
    clone.querySelector('[class*="response-content"]') ||
    clone;

  var text = wrapper.textContent.trim();
  text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");
  return text;
}

function captureConversationText() {
  var messages = captureMessages();
  if (messages.length === 0) {
    var scopeEl = document.querySelector("main") || document.body;
    return scopeEl.innerText.trim();
  }
  return flattenInjectedContext(messages);
}

function formatMessagesAsTranscript(messages) {
  return flattenInjectedContext(messages);
}

function extractResponse(beforeText, afterText) {
  var raw = afterText.slice(beforeText.length).trim();
  var meaningful = raw
    .split("\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 10; });
  return meaningful.join("\n").trim();
}
