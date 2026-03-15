// content/perplexity.js — Runs on https://www.perplexity.ai/*
//
// Both SOURCE and TARGET:
//
// TARGET:
//   1. Signal PERPLEXITY_READY → get context block from background
//   2. Wait for input field → inject context → auto-submit
//   3. Wait for response to stabilize → send PERPLEXITY_RESPONSE
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

var DUPERMEM_SOURCE_MODEL = "perplexity";

// When this tab was opened as a target by DuperMemory, store the chain's
// conversation ID so that if the user later uses this tab as a source,
// the memory stays linked across hops (AI #1 → AI #2 → AI #3).
var DUPERMEM_CHAIN_CONV_ID = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET FLOW
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ type: "PERPLEXITY_READY" }, function (response) {
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
    console.error("[DuperMemory] Perplexity target injection flow failed:", err.message);
  });
});

async function runTargetInjectionFlow(contextBlock) {
  var inputEl = await waitForPerplexityInput();

  injectText(inputEl, contextBlock);
  await delay(400);

  var scopeEl = document.querySelector("main") || document.body;
  var snapshot = scopeEl.innerText;

  var submitted = submitPerplexityInput(inputEl);
  if (!submitted) {
    throw new Error("Could not submit to Perplexity — no send button found.");
  }

  var response = await waitForPerplexityResponse(scopeEl, snapshot);

  if (!response) {
    console.warn("[DuperMemory] Perplexity response captured was empty. Not sending back.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "PERPLEXITY_RESPONSE", content: response },
    function () {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] PERPLEXITY_RESPONSE send failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE FLOW
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  // Perplexity URLs: https://www.perplexity.ai/search/abc123
  var match = window.location.pathname.match(/\/search\/([a-zA-Z0-9_-]+)/);
  if (match) return "perplexity_" + match[1];
  return "perplexity_conv_" + Date.now();
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

  var inputEl = await waitForPerplexityInput();
  injectText(inputEl, content);
  await delay(400);
  submitPerplexityInput(inputEl);
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
  var answers = document.querySelectorAll(
    '[class*="answer"], [class*="response"], [class*="prose"], .markdown'
  );
  var target = answers.length > 0 ? answers[answers.length - 1] : null;
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

function waitForPerplexityInput() {
  return new Promise(function (resolve, reject) {
    var existing = findPerplexityInput();
    if (existing) { resolve(existing); return; }

    var settled = false;
    var observer = new MutationObserver(function () {
      var el = findPerplexityInput();
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
      var el = findPerplexityInput();
      if (el) resolve(el);
      else reject(new Error("Perplexity input field not found after 15 seconds."));
    }, 15000);
  });
}

function findPerplexityInput() {
  var textarea = document.querySelector("textarea");
  if (textarea) return textarea;

  var byRole = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (byRole) return byRole;

  var byLabel = document.querySelector(
    '[contenteditable="true"][aria-label*="ask" i],' +
    '[contenteditable="true"][aria-label*="search" i],' +
    '[contenteditable="true"][aria-label*="query" i]'
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
    console.warn("[DuperMemory] Perplexity: execCommand failed; used textContent fallback.");
  }
}

// ─── Submit ───────────────────────────────────────────────────────────────────

function submitPerplexityInput(inputEl) {
  var sendBtn = document.querySelector(
    'button[aria-label*="Submit" i]:not([disabled]),' +
    'button[aria-label*="Send" i]:not([disabled]),' +
    'button[aria-label*="Search" i]:not([disabled])'
  );
  if (sendBtn) { sendBtn.click(); return true; }

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

function waitForPerplexityResponse(scopeEl, snapshot) {
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
        reject(new Error("Timed out waiting for Perplexity's response."));
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
// Strategy: Perplexity renders query/answer pairs. User queries are in
// elements with class patterns like "query" or inside the search input history.
// Answers contain .markdown or prose wrappers and citation sections.
// Fallback: alternating children in the answer thread container.

function captureMessages() {
  // ── Primary: query/answer pair containers ──────────────────────────────
  var messages = tryPerplexityPairCapture();
  if (messages.length > 0) return messages;

  // ── Fallback 1: data-testid or class-based markers ─────────────────────
  var turns = document.querySelectorAll(
    '[data-testid*="message"], [data-testid*="query"], [data-testid*="answer"], ' +
    '[class*="query-text"], [class*="answer-text"], ' +
    '[class*="ThreadMessage"], [class*="thread-message"]'
  );
  if (turns.length > 0) {
    return extractFromPerplexityTurns(turns);
  }

  // ── Fallback 2: alternating children of main ───────────────────────────
  var main = document.querySelector("main") || document.querySelector('[role="main"]');
  if (main) {
    return extractFromAlternatingChildren(main);
  }

  return [];
}

function tryPerplexityPairCapture() {
  var messages = [];

  // Perplexity groups conversations into query-answer blocks
  // Look for containers that hold the question text
  var queryEls = document.querySelectorAll(
    '[class*="query"], [class*="Question"], [class*="UserQuery"], ' +
    '[class*="search-query"], [class*="question-text"]'
  );
  var answerEls = document.querySelectorAll(
    '[class*="answer"], [class*="Answer"], [class*="response"], ' +
    '[class*="prose"], [class*="markdown"]'
  );

  if (queryEls.length === 0 && answerEls.length === 0) return [];

  // Collect all with roles and sort by DOM position
  var all = [];
  for (var i = 0; i < queryEls.length; i++) {
    all.push({ el: queryEls[i], role: "user" });
  }
  for (var j = 0; j < answerEls.length; j++) {
    // Skip if this answer element is inside a query element (nested markup)
    var isNested = false;
    for (var q = 0; q < queryEls.length; q++) {
      if (queryEls[q].contains(answerEls[j])) { isNested = true; break; }
    }
    if (!isNested) {
      all.push({ el: answerEls[j], role: "assistant" });
    }
  }

  all.sort(function (a, b) {
    var pos = a.el.compareDocumentPosition(b.el);
    return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
  });

  for (var k = 0; k < all.length; k++) {
    var content = extractCleanContent(all[k].el);
    if (content) messages.push({ role: all[k].role, content: content });
  }
  return messages;
}

function extractFromPerplexityTurns(turns) {
  var messages = [];
  for (var i = 0; i < turns.length; i++) {
    var el = turns[i];
    var role = inferPerplexityRole(el);
    if (!role) continue;
    var content = extractCleanContent(el);
    if (content) messages.push({ role: role, content: content });
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
    var role = inferPerplexityRole(children[i]);
    if (!role) role = (messages.length % 2 === 0) ? "user" : "assistant";
    messages.push({ role: role, content: content });
  }
  return messages;
}

function inferPerplexityRole(el) {
  var html = el.outerHTML.slice(0, 500).toLowerCase();
  if (/\bquery\b/.test(html) || /\buser[-_]/.test(html) || /\bquestion\b/.test(html)) return "user";
  if (/\banswer\b/.test(html) || /\bresponse\b/.test(html) || /\bprose\b/.test(html) || /\bmarkdown\b/.test(html)) return "assistant";

  var ariaLabel = (el.getAttribute("aria-label") || "").toLowerCase();
  if (/user|query|question|you/.test(ariaLabel)) return "user";
  if (/answer|response|perplexity|assistant/.test(ariaLabel)) return "assistant";

  if (el.querySelector('.markdown, .prose, [class*="markdown"]')) return "assistant";

  return null;
}

// ─── Clean content extraction ────────────────────────────────────────────────

function extractCleanContent(el) {
  var clone = el.cloneNode(true);

  var junk = clone.querySelectorAll(
    'button, [role="button"], svg, [aria-hidden="true"], ' +
    '[class*="copy"], [class*="toolbar"], [class*="action"], [class*="avatar"], ' +
    '[class*="icon"], [class*="citation"], [class*="source-badge"], ' +
    '[class*="share"], [class*="feedback"], ' +
    '[aria-label="Copy"], [aria-label="Share"]'
  );
  for (var i = 0; i < junk.length; i++) {
    junk[i].remove();
  }

  var wrapper =
    clone.querySelector(".markdown") ||
    clone.querySelector(".prose") ||
    clone.querySelector('[class*="markdown"]') ||
    clone.querySelector('[class*="answer-text"]') ||
    clone.querySelector('[class*="query-text"]') ||
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
