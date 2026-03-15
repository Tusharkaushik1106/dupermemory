// content/chatgpt.js — Runs on https://chatgpt.com/*
//
// Both SOURCE and TARGET:
//
// SOURCE:
//   - "Ask another AI" button with model dropdown
//   - Direct DOM capture: reads conversation messages from the DOM,
//     sends transcript to background via CAPTURE message
//   - INJECT_CRITIQUE listener: receives critique from target AI, injects
//     it into ChatGPT's input and auto-submits
//
// TARGET:
//   - Sends CHATGPT_READY on load → receives context from background
//   - Injects context into input → auto-submits
//   - Waits for response to stabilize → sends CHATGPT_RESPONSE to background
//
// Globals from utils/summarize-generic.js (loaded before this file):
//   parseSummary(), delay()

var DUPERMEM_SOURCE_MODEL = "chatgpt";
// When this tab was opened as a target by DuperMemory, store the chain's
// conversation ID so that if the user later uses this tab as a source,
// the memory stays linked across hops (AI #1 → AI #2 → AI #3).
var DUPERMEM_CHAIN_CONV_ID = null;

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET FLOW — runs immediately on load
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.sendMessage({ type: "CHATGPT_READY" }, function (response) {
  if (chrome.runtime.lastError) {
    // No extension activity was in progress. Normal for regular visits.
    return;
  }
  if (!response || response.type !== "INJECT" || !response.contextBlock) {
    return; // Regular visit — proceed with source-only setup.
  }
  // This tab was opened by background as a target. Store the chain conversation ID.
  if (response.conversationId) {
    DUPERMEM_CHAIN_CONV_ID = response.conversationId;
  }
  // Run injection flow.
  runTargetInjectionFlow(response.contextBlock).catch(function (err) {
    console.error("[DuperMemory] ChatGPT target injection flow failed:", err.message);
  });
});

async function runTargetInjectionFlow(contextBlock) {
  var inputEl = await waitForChatGPTInput();

  injectTextIntoChatGPT(inputEl, contextBlock);
  await delay(300);

  // Snapshot scoped to main content area.
  var scopeEl = document.querySelector("main") || document.body;
  var snapshot = scopeEl.innerText;

  var submitted = submitChatGPTInput();
  if (!submitted) {
    throw new Error("Could not submit to ChatGPT — no send button found.");
  }

  var response = await waitForTargetResponse(scopeEl, snapshot);

  if (!response) {
    console.warn("[DuperMemory] ChatGPT response captured was empty. Not sending back.");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "CHATGPT_RESPONSE", content: response },
    function () {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] CHATGPT_RESPONSE send failed:", chrome.runtime.lastError.message);
      }
    }
  );
}

// ─── Wait for target response (snapshot-diff approach like claude.js) ────────

function waitForTargetResponse(scopeEl, snapshot) {
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
        reject(new Error("Timed out waiting for ChatGPT's response (target mode)."));
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
            resolve(extractTargetResponse(snapshot, currentText));
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

function extractTargetResponse(beforeText, afterText) {
  var raw = afterText.slice(beforeText.length).trim();
  var meaningful = raw
    .split("\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 10; });
  return meaningful.join("\n").trim();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE FLOW — button + dropdown + self-summarization
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  var match = window.location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return "conv_" + Date.now();
}

// ─── Critique receiver ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === "INJECT_CRITIQUE") {
    injectCritique(message.content).catch(function (err) {
      console.error("[DuperMemory] Critique injection failed:", err.message);
    });
  }
});

async function injectCritique(content) {
  // ── Code diff: compare original assistant code with critique code ──
  var lastAssistant = getLastAssistantText();
  if (lastAssistant) {
    var diffFragment = buildCritiqueDiffUI(lastAssistant, content);
    if (diffFragment) {
      insertDiffPanel(diffFragment);
    }
  }

  var inputEl = await waitForChatGPTInput();
  injectTextIntoChatGPT(inputEl, content);
  await delay(300);
  submitChatGPTInput();
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
  // Insert diff panel after the last assistant message in the DOM
  var containers = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  var target = containers.length > 0
    ? containers[containers.length - 1]
    : null;

  // Fallback: last article turn
  if (!target) {
    var articles = document.querySelectorAll(
      'article[data-testid^="conversation-turn"]'
    );
    target = articles.length > 0 ? articles[articles.length - 1] : null;
  }

  if (target) {
    target.parentNode.insertBefore(fragment, target.nextSibling);
  } else {
    // Last resort: append to main content area
    var main = document.querySelector("main") || document.body;
    main.appendChild(fragment);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED DOM HELPERS (used by both source and target flows)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Wait for input field ─────────────────────────────────────────────────────

function waitForChatGPTInput() {
  return new Promise(function (resolve, reject) {
    var existing = findChatGPTInput();
    if (existing) { resolve(existing); return; }

    var settled = false;
    var observer = new MutationObserver(function () {
      var el = findChatGPTInput();
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
      var el = findChatGPTInput();
      if (el) resolve(el);
      else reject(new Error("ChatGPT input field not found after 15 seconds."));
    }, 15000);
  });
}

function findChatGPTInput() {
  var el = document.querySelector("#prompt-textarea");
  if (el) return el;

  // Fallback: contenteditable with role="textbox"
  var byRole = document.querySelector('[contenteditable="true"][role="textbox"]');
  if (byRole) return byRole;

  // Fallback: wide contenteditable in lower viewport
  var editors = document.querySelectorAll('[contenteditable="true"]');
  for (var i = 0; i < editors.length; i++) {
    var rect = editors[i].getBoundingClientRect();
    if (rect.width > 200 && rect.bottom > window.innerHeight * 0.5) return editors[i];
  }

  return null;
}

// ─── Inject text into ChatGPT input ──────────────────────────────────────────

function injectTextIntoChatGPT(el, text) {
  el.focus();

  if (el.tagName === "TEXTAREA") {
    var nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value"
    ).set;
    nativeSetter.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (el.isContentEditable) {
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    var ok = document.execCommand("insertText", false, text);
    if (!ok) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
    }
    return;
  }
}

// ─── Submit ChatGPT input ─────────────────────────────────────────────────────

function submitChatGPTInput() {
  var sendBtn = document.querySelector(
    '[data-testid="send-button"]:not([disabled]),' +
    'button[aria-label*="Send"]:not([disabled]),' +
    'form button[type="submit"]:not([disabled])'
  );

  if (sendBtn) {
    sendBtn.click();
    return true;
  }

  var inputEl = document.querySelector("#prompt-textarea") || document.activeElement;
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

// ─── Message capture ──────────────────────────────────────────────────────────
//
// Strategy: ChatGPT marks every message with data-message-author-role on a
// container element. When that attribute disappears, fall back to article
// elements with data-testid="conversation-turn-*", which alternate user and
// assistant. Content is extracted from .markdown / prose wrappers first, with
// a clone-and-strip pass to remove buttons, SVGs, and ARIA-hidden elements.

function captureMessages() {
  // ── Primary: data-message-author-role (most reliable) ──────────────────
  var byRole = document.querySelectorAll("[data-message-author-role]");
  if (byRole.length > 0) {
    return extractFromRoleAttr(byRole);
  }

  // ── Fallback 1: article[data-testid^="conversation-turn"] ──────────────
  var turns = document.querySelectorAll('article[data-testid^="conversation-turn"]');
  if (turns.length > 0) {
    return extractFromTurnArticles(turns);
  }

  // ── Fallback 2: main > div alternating structure ───────────────────────
  var main = document.querySelector("main");
  if (main) {
    var groups = main.querySelectorAll('[data-message-id]');
    if (groups.length > 0) {
      return extractFromMessageIds(groups);
    }
  }

  return [];
}

function extractFromRoleAttr(nodes) {
  var messages = [];
  for (var i = 0; i < nodes.length; i++) {
    var role = nodes[i].dataset.messageAuthorRole;
    if (role !== "user" && role !== "assistant") continue;
    var content = extractCleanContent(nodes[i]);
    if (content) messages.push({ role: role, content: content });
  }
  return messages;
}

function extractFromTurnArticles(articles) {
  var messages = [];
  for (var i = 0; i < articles.length; i++) {
    var testId = articles[i].dataset.testid || "";
    // conversation-turn-0 = system/context, skip it
    var turnMatch = testId.match(/conversation-turn-(\d+)/);
    if (!turnMatch) continue;
    var turnNum = parseInt(turnMatch[1], 10);
    if (turnNum === 0) continue;

    // Check for nested role attribute first
    var nested = articles[i].querySelector("[data-message-author-role]");
    var role;
    if (nested) {
      role = nested.dataset.messageAuthorRole;
    } else {
      // Odd turns = user, even turns = assistant (1-indexed after skipping 0)
      role = (turnNum % 2 === 1) ? "user" : "assistant";
    }
    if (role !== "user" && role !== "assistant") continue;

    var content = extractCleanContent(articles[i]);
    if (content) messages.push({ role: role, content: content });
  }
  return messages;
}

function extractFromMessageIds(nodes) {
  var messages = [];
  for (var i = 0; i < nodes.length; i++) {
    // Infer role: user messages are typically shorter containers without
    // .markdown wrappers; assistant messages contain .markdown or prose divs.
    var hasMarkdown = nodes[i].querySelector(".markdown, .prose, [class*='markdown']");
    var role = hasMarkdown ? "assistant" : "user";

    // Override if the element or an ancestor has a role attribute
    var roleAttr = nodes[i].querySelector("[data-message-author-role]");
    if (roleAttr) {
      role = roleAttr.dataset.messageAuthorRole === "user" ? "user" : "assistant";
    }

    var content = extractCleanContent(nodes[i]);
    if (content) messages.push({ role: role, content: content });
  }
  return messages;
}

// ─── Clean content extraction ────────────────────────────────────────────────
//
// Clones the node, strips UI chrome, preserves code blocks as Markdown fences,
// converts block-level HTML to line breaks, and reads .innerText from a hidden
// container to respect visual formatting the browser would render.

function extractCleanContent(el) {
  var clone = el.cloneNode(true);

  // Remove interactive UI elements
  var junk = clone.querySelectorAll(
    'button, [role="button"], svg, [aria-hidden="true"], ' +
    '[class*="copy"], [class*="toolbar"], [class*="action"], ' +
    '[data-testid*="copy"], [data-testid*="voice"], ' +
    '[aria-label="Copy"], [aria-label="Read aloud"], [aria-label="Regenerate"]'
  );
  for (var i = 0; i < junk.length; i++) {
    junk[i].remove();
  }

  // Prefer the narrowest content wrapper
  var wrapper =
    clone.querySelector(".markdown") ||
    clone.querySelector(".prose") ||
    clone.querySelector('[class*="markdown"]') ||
    clone.querySelector('[class*="message-content"]') ||
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
  if (messages.length === 0) return "";
  return flattenInjectedContext(messages);
}

function formatMessagesAsTranscript(messages) {
  return flattenInjectedContext(messages);
}
