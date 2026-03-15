// content/deepseek.js — Runs on https://chat.deepseek.com/*
//
// Both SOURCE and TARGET:
//
// TARGET:
//   1. Signal DEEPSEEK_READY → get context block from background
//   2. Wait for input field → inject context → auto-submit
//   3. Wait for response to stabilize → send DEEPSEEK_RESPONSE
//
// SOURCE:
//   - "Ask another AI" button with model dropdown
//   - Direct DOM capture: reads conversation text from the DOM,
//     sends transcript to background via CAPTURE message
//   - INJECT_CRITIQUE listener: receives critique from target AI
//
// IMPORTANT: Selectors are best-effort. Must be confirmed against live DOM.
//
// Globals from utils/summarize-generic.js (loaded before this file):
//   parseSummary(), delay()

var DUPERMEM_SOURCE_MODEL = "deepseek";

// When this tab was opened as a target by DuperMemory, store the chain's
// conversation ID so that if the user later uses this tab as a source,
// the memory stays linked across hops (AI #1 → AI #2 → AI #3).
var DUPERMEM_CHAIN_CONV_ID = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET FLOW
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ type: "DEEPSEEK_READY" }, function (response) {
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
    console.error("[DuperMemory] DeepSeek target injection flow failed:", err.message);
  });
});

async function runTargetInjectionFlow(contextBlock) {
  var inputEl = await waitForDeepSeekInput();

  injectText(inputEl, contextBlock);
  await delay(400);

  var scopeEl = document.querySelector("main") || document.querySelector("#root") || document.body;
  var snapshot = scopeEl.innerText;

  var submitted = submitDeepSeekInput(inputEl);
  if (!submitted) {
    throw new Error("Could not submit to DeepSeek — no send button found.");
  }

  var response = await waitForDeepSeekResponse(scopeEl, snapshot);

  if (!response) {
    console.warn("[DuperMemory] DeepSeek response captured was empty. Not sending back.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "DEEPSEEK_RESPONSE", content: response },
    function () {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] DEEPSEEK_RESPONSE send failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE FLOW
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  // DeepSeek URLs: https://chat.deepseek.com/a/chat/abc123
  var match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
  if (match) return "deepseek_" + match[1];
  return "deepseek_conv_" + Date.now();
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
  var inputEl = await waitForDeepSeekInput();
  injectText(inputEl, content);
  await delay(400);
  submitDeepSeekInput(inputEl);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED DOM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Wait for input field ─────────────────────────────────────────────────────

function waitForDeepSeekInput() {
  return new Promise(function (resolve, reject) {
    var existing = findDeepSeekInput();
    if (existing) { resolve(existing); return; }

    var settled = false;
    var observer = new MutationObserver(function () {
      var el = findDeepSeekInput();
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
      var el = findDeepSeekInput();
      if (el) resolve(el);
      else reject(new Error("DeepSeek input field not found after 15 seconds."));
    }, 15000);
  });
}

function findDeepSeekInput() {
  var byId = document.querySelector("#chat-input");
  if (byId) return byId;

  var byRole = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (byRole) return byRole;

  var textarea = document.querySelector("textarea");
  if (textarea) return textarea;

  var byLabel = document.querySelector(
    '[contenteditable="true"][aria-label*="message" i],' +
    '[contenteditable="true"][aria-label*="input" i]'
  );
  if (byLabel) return byLabel;

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
    console.warn("[DuperMemory] DeepSeek: execCommand failed; used textContent fallback.");
  }
}

// ─── Submit ───────────────────────────────────────────────────────────────────

function submitDeepSeekInput(inputEl) {
  var sendBtn = document.querySelector(
    'button[aria-label*="Send" i]:not([disabled]),' +
    'button[aria-label*="send"]:not([disabled])'
  );
  if (sendBtn) { sendBtn.click(); return true; }

  var byTestId = document.querySelector('[data-testid*="send" i]:not([disabled])');
  if (byTestId) { byTestId.click(); return true; }

  if (inputEl) {
    var walk = inputEl.parentElement;
    for (var i = 0; i < 5 && walk; i++) {
      var btn = walk.querySelector("button:not([disabled])");
      if (btn) { btn.click(); return true; }
      walk = walk.parentElement;
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

// ─── Wait for response ────────────────────────────────────────────────────────

function waitForDeepSeekResponse(scopeEl, snapshot) {
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
        reject(new Error("Timed out waiting for DeepSeek's response."));
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
// Strategy: DeepSeek's chat UI uses class-based containers for user and
// assistant messages. User messages often have a distinct container with
// right-alignment or a user avatar. Assistant messages contain .markdown
// or .ds-markdown wrappers. Fallback: alternating children within the
// chat history container (#root or main scrollable area).

function captureMessages() {
  // ── Primary: class-based message containers ────────────────────────────
  var turns = document.querySelectorAll(
    '[class*="chat-message"], [class*="message-item"], ' +
    '[data-testid*="message"], [data-testid*="turn"], ' +
    '[class*="ds-message"], [class*="chat-item"]'
  );
  if (turns.length > 0) {
    return extractFromDeepSeekTurns(turns);
  }

  // ── Fallback 1: find user/assistant blocks by content wrappers ─────────
  var messages = tryDeepSeekContentCapture();
  if (messages.length > 0) return messages;

  // ── Fallback 2: alternating children of the chat container ─────────────
  var container =
    document.querySelector('[class*="chat-container"]') ||
    document.querySelector('[class*="conversation"]') ||
    document.querySelector("main") ||
    document.querySelector("#root");
  if (container) {
    return extractFromAlternatingChildren(container);
  }

  return [];
}

function extractFromDeepSeekTurns(turns) {
  var messages = [];
  for (var i = 0; i < turns.length; i++) {
    var el = turns[i];
    var role = inferDeepSeekRole(el);
    if (!role) continue;
    var content = extractCleanContent(el);
    if (content) messages.push({ role: role, content: content });
  }
  return messages;
}

function tryDeepSeekContentCapture() {
  var messages = [];

  // DeepSeek often has the chat scroll container as a direct child of #root
  // with alternating user (right-aligned) and assistant (left-aligned) blocks
  var scrollable =
    document.querySelector('[class*="overflow-y-auto"]') ||
    document.querySelector('[class*="scroll"]') ||
    document.querySelector('[class*="chat-history"]');
  if (!scrollable) return [];

  var children = scrollable.children;
  for (var i = 0; i < children.length; i++) {
    if (children[i].offsetHeight < 20) continue;
    var content = extractCleanContent(children[i]);
    if (!content) continue;
    var role = inferDeepSeekRole(children[i]);
    if (!role) role = (messages.length % 2 === 0) ? "user" : "assistant";
    messages.push({ role: role, content: content });
  }
  return messages;
}

function extractFromAlternatingChildren(container) {
  var messages = [];
  var children = container.children;
  for (var i = 0; i < children.length; i++) {
    if (children[i].offsetHeight < 20) continue;
    var content = extractCleanContent(children[i]);
    if (!content) continue;
    var role = inferDeepSeekRole(children[i]);
    if (!role) role = (messages.length % 2 === 0) ? "user" : "assistant";
    messages.push({ role: role, content: content });
  }
  return messages;
}

function inferDeepSeekRole(el) {
  var html = el.outerHTML.slice(0, 500).toLowerCase();

  // Class / data-attribute signals
  if (/\buser[-_]/.test(html) || /\bhuman\b/.test(html) || /\bself\b/.test(html)) return "user";
  if (/\bassistant\b/.test(html) || /\bbot[-_]/.test(html) || /\bdeepseek\b/.test(html) || /\bai[-_]/.test(html)) return "assistant";

  // ARIA
  var ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  if (/user|you|human/.test(ariaLabel)) return "user";
  if (/assistant|deepseek|ai|bot/.test(ariaLabel)) return "assistant";

  // Content wrapper presence (markdown = assistant)
  if (el.querySelector('.ds-markdown, .markdown, [class*="markdown"], [class*="rendered"]')) return "assistant";

  // Alignment heuristic: user messages are often right-justified
  var style = window.getComputedStyle(el);
  if (style.textAlign === "right" || style.justifyContent === "flex-end") return "user";

  return null;
}

// ─── Clean content extraction ────────────────────────────────────────────────

function extractCleanContent(el) {
  var clone = el.cloneNode(true);

  var junk = clone.querySelectorAll(
    'button, [role="button"], svg, [aria-hidden="true"], ' +
    '[class*="copy"], [class*="toolbar"], [class*="action"], [class*="avatar"], ' +
    '[class*="icon"], [class*="badge"], [class*="timestamp"], ' +
    '[aria-label="Copy"], [aria-label="Regenerate"]'
  );
  for (var i = 0; i < junk.length; i++) {
    junk[i].remove();
  }

  var wrapper =
    clone.querySelector(".ds-markdown") ||
    clone.querySelector(".markdown") ||
    clone.querySelector('[class*="markdown"]') ||
    clone.querySelector('[class*="message-content"]') ||
    clone;

  var text = wrapper.textContent.trim();
  text = text.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ");
  return text;
}

function captureConversationText() {
  var messages = captureMessages();
  if (messages.length === 0) {
    var scopeEl = document.querySelector("main") || document.querySelector("#root") || document.body;
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
