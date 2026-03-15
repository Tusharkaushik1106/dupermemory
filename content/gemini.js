// content/gemini.js — Runs on https://gemini.google.com/*
//
// Both SOURCE and TARGET:
//
// TARGET:
//   1. Signal GEMINI_READY → get context block from background
//   2. Wait for input field → inject context → auto-submit
//   3. Wait for response to stabilize → send GEMINI_RESPONSE
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

var DUPERMEM_SOURCE_MODEL = "gemini";

// When this tab was opened as a target by DuperMemory, store the chain's
// conversation ID so that if the user later uses this tab as a source,
// the memory stays linked across hops (AI #1 → AI #2 → AI #3).
var DUPERMEM_CHAIN_CONV_ID = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET FLOW
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ type: "GEMINI_READY" }, function (response) {
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
    console.error("[DuperMemory] Gemini target injection flow failed:", err.message);
  });
});

async function runTargetInjectionFlow(contextBlock) {
  var inputEl = await waitForGeminiInput();

  injectText(inputEl, contextBlock);
  await delay(500);

  var scopeEl = document.querySelector("main") || document.body;
  var snapshot = scopeEl.innerText;

  var submitted = submitGeminiInput(inputEl);
  if (!submitted) {
    throw new Error("Could not submit to Gemini — no send button found.");
  }

  var response = await waitForGeminiResponse(scopeEl, snapshot);

  if (!response) {
    console.warn("[DuperMemory] Gemini response captured was empty. Not sending back.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "GEMINI_RESPONSE", content: response },
    function () {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] GEMINI_RESPONSE send failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE FLOW
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  // Gemini URLs vary; extract path segment if available.
  var path = window.location.pathname;
  var match = path.match(/\/app\/([a-zA-Z0-9_-]+)/);
  if (match) return "gemini_" + match[1];
  return "gemini_conv_" + Date.now();
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
  var lastAssistant = getLastAssistantText();
  if (lastAssistant) {
    var diffFragment = buildCritiqueDiffUI(lastAssistant, content);
    if (diffFragment) { insertDiffPanel(diffFragment); }
  }

  var inputEl = await waitForGeminiInput();
  injectText(inputEl, content);
  await delay(500);
  submitGeminiInput(inputEl);
}

function getLastAssistantText() {
  var messages = captureMessages();
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].content.length > 20) {
      return messages[i].content;
    }
  }
  return null;
}

function insertDiffPanel(fragment) {
  var responses = document.querySelectorAll(
    'model-response, [class*="response"], [class*="model-response"]'
  );
  var target = responses.length > 0 ? responses[responses.length - 1] : null;
  if (!target) {
    var main = document.querySelector("main");
    if (main && main.lastElementChild) { target = main.lastElementChild; }
  }
  if (target) {
    target.parentNode.insertBefore(fragment, target.nextSibling);
  } else {
    (document.querySelector("main") || document.body).appendChild(fragment);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED DOM HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Wait for input field ─────────────────────────────────────────────────────

function waitForGeminiInput() {
  return new Promise(function (resolve, reject) {
    var existing = findGeminiInput();
    if (existing) { resolve(existing); return; }

    var settled = false;
    var observer = new MutationObserver(function () {
      var el = findGeminiInput();
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
      var el = findGeminiInput();
      if (el) resolve(el);
      else reject(new Error("Gemini input field not found after 15 seconds."));
    }, 15000);
  });
}

function findGeminiInput() {
  var byRole = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (byRole) return byRole;

  var richTextarea = document.querySelector("rich-textarea [contenteditable='true']");
  if (richTextarea) return richTextarea;

  var byLabel = document.querySelector(
    '[contenteditable="true"][aria-label*="prompt" i],' +
    '[contenteditable="true"][aria-label*="message" i]'
  );
  if (byLabel) return byLabel;

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
    console.warn("[DuperMemory] Gemini: execCommand failed; used textContent fallback.");
  }
}

// ─── Submit ───────────────────────────────────────────────────────────────────

function submitGeminiInput(inputEl) {
  var sendBtn = document.querySelector(
    'button[aria-label*="Send" i]:not([disabled]),' +
    'button[aria-label*="Submit" i]:not([disabled])'
  );
  if (sendBtn) { sendBtn.click(); return true; }

  if (inputEl) {
    var walk = inputEl.parentElement;
    for (var i = 0; i < 5 && walk; i++) {
      var btn = walk.querySelector('button[aria-label*="Send" i], button[aria-label*="Submit" i]');
      if (btn && !btn.disabled) { btn.click(); return true; }
      var anyBtn = walk.querySelector("button:not([disabled])");
      if (anyBtn) { anyBtn.click(); return true; }
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

function waitForGeminiResponse(scopeEl, snapshot) {
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
        reject(new Error("Timed out waiting for Gemini's response."));
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
// Strategy: Gemini uses custom elements (<user-query>, <model-response>) and/or
// role="region" containers with specific parent structures. Fallback to
// alternating turn containers within the conversation thread.

function captureMessages() {
  // ── Primary: custom Gemini elements ────────────────────────────────────
  var userQueries    = document.querySelectorAll("user-query");
  var modelResponses = document.querySelectorAll("model-response");
  if (userQueries.length > 0 || modelResponses.length > 0) {
    return extractFromGeminiCustomElements(userQueries, modelResponses);
  }

  // ── Fallback 1: data-testid or class-based turn markers ────────────────
  var turns = document.querySelectorAll(
    '[data-testid*="conversation-turn"], [class*="conversation-turn"], ' +
    '[class*="query-content"], [class*="response-content"], ' +
    '[class*="turn-container"]'
  );
  if (turns.length > 0) {
    return extractFromGeminiTurns(turns);
  }

  // ── Fallback 2: role="region" conversation blocks ──────────────────────
  var regions = document.querySelectorAll('[role="region"]');
  if (regions.length > 0) {
    return extractFromRegions(regions);
  }

  // ── Fallback 3: alternating children of main ───────────────────────────
  var main = document.querySelector("main") || document.querySelector('[role="main"]');
  if (main) {
    return extractFromAlternatingChildren(main);
  }

  return [];
}

function extractFromGeminiCustomElements(userEls, modelEls) {
  // Interleave user queries and model responses by DOM order
  var all = [];
  for (var i = 0; i < userEls.length; i++) {
    all.push({ el: userEls[i], role: "user" });
  }
  for (var j = 0; j < modelEls.length; j++) {
    all.push({ el: modelEls[j], role: "assistant" });
  }
  // Sort by document position
  all.sort(function (a, b) {
    var pos = a.el.compareDocumentPosition(b.el);
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  var messages = [];
  for (var k = 0; k < all.length; k++) {
    var content = extractCleanContent(all[k].el);
    if (content) messages.push({ role: all[k].role, content: content });
  }
  return messages;
}

function extractFromGeminiTurns(turns) {
  var messages = [];
  for (var i = 0; i < turns.length; i++) {
    var el = turns[i];
    var role = inferGeminiRole(el);
    if (!role) continue;
    var content = extractCleanContent(el);
    if (content) messages.push({ role: role, content: content });
  }
  return messages;
}

function extractFromRegions(regions) {
  var messages = [];
  for (var i = 0; i < regions.length; i++) {
    var el = regions[i];
    var content = extractCleanContent(el);
    if (!content) continue;
    var role = inferGeminiRole(el);
    if (!role) role = (messages.length % 2 === 0) ? "user" : "assistant";
    messages.push({ role: role, content: content });
  }
  return messages;
}

function extractFromAlternatingChildren(main) {
  var messages = [];
  var children = main.children;
  for (var i = 0; i < children.length; i++) {
    if (children[i].offsetHeight < 20) continue;
    var content = extractCleanContent(children[i]);
    if (!content) continue;
    var role = inferGeminiRole(children[i]);
    if (!role) role = (messages.length % 2 === 0) ? "user" : "assistant";
    messages.push({ role: role, content: content });
  }
  return messages;
}

function inferGeminiRole(el) {
  var tag = el.tagName.toLowerCase();
  if (tag === "user-query") return "user";
  if (tag === "model-response") return "assistant";

  var html = el.outerHTML.slice(0, 500).toLowerCase();
  if (/\bquery\b/.test(html) || /\buser[-_]/.test(html) || /\bhuman\b/.test(html)) return "user";
  if (/\bresponse\b/.test(html) || /\bmodel[-_]/.test(html) || /\bassistant\b/.test(html)) return "assistant";

  var ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  if (/user|you|query/.test(ariaLabel)) return "user";
  if (/model|gemini|response|assistant/.test(ariaLabel)) return "assistant";

  if (el.querySelector('.markdown, [class*="markdown"], [class*="response"]')) return "assistant";

  return null;
}

// ─── Clean content extraction ────────────────────────────────────────────────

function extractCleanContent(el) {
  var clone = el.cloneNode(true);

  var junk = clone.querySelectorAll(
    'button, [role="button"], svg, [aria-hidden="true"], ' +
    '[class*="copy"], [class*="toolbar"], [class*="action"], [class*="avatar"], ' +
    '[class*="icon"], [class*="chip"], [class*="badge"], ' +
    '[aria-label="Copy"], [aria-label="Share"], [data-testid*="thumb"]'
  );
  for (var i = 0; i < junk.length; i++) {
    junk[i].remove();
  }

  var wrapper =
    clone.querySelector(".markdown") ||
    clone.querySelector('[class*="markdown"]') ||
    clone.querySelector('[class*="message-content"]') ||
    clone.querySelector('[class*="response-container"]') ||
    clone;

  // Preserve code blocks: replace <pre>/<code> containers with Markdown fences
  var codeBlocks = wrapper.querySelectorAll("pre");
  for (var c = 0; c < codeBlocks.length; c++) {
    var codeEl = codeBlocks[c].querySelector("code") || codeBlocks[c];
    var lang = "";
    var cls = codeEl.className || "";
    var langMatch = cls.match(/(?:language|lang|hljs)-(\w+)/);
    if (langMatch) lang = langMatch[1];
    var codeText = codeEl.textContent;
    var fenced = document.createTextNode(
      "\n```" + lang + "\n" + codeText + "\n```\n"
    );
    codeBlocks[c].parentNode.replaceChild(fenced, codeBlocks[c]);
  }

  // Convert block-level elements to preserve line breaks
  var blocks = wrapper.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote");
  for (var b = 0; b < blocks.length; b++) {
    blocks[b].insertAdjacentText("afterend", "\n\n");
  }
  var brs = wrapper.querySelectorAll("br");
  for (var r = 0; r < brs.length; r++) {
    brs[r].parentNode.replaceChild(document.createTextNode("\n"), brs[r]);
  }

  // Read .innerText from a hidden container to respect visual line breaks
  var hiddenDiv = document.createElement("div");
  hiddenDiv.style.cssText = "position:absolute;left:-9999px;top:-9999px;white-space:pre-wrap;max-width:800px;overflow:hidden;";
  hiddenDiv.appendChild(wrapper);
  document.body.appendChild(hiddenDiv);
  var text = hiddenDiv.innerText;
  document.body.removeChild(hiddenDiv);

  text = (text || "").trim();
  text = text.replace(/\n{3,}/g, "\n\n");

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
