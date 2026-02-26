// content/chatgpt.js — Runs on https://chatgpt.com/*
//
// Both SOURCE and TARGET:
//
// SOURCE:
//   - "Ask another AI" button with model dropdown
//   - Self-summarization: injects SUMMARY_PROMPT into ChatGPT, waits for
//     ChatGPT's JSON response, parses it, sends CAPTURE to background
//   - INJECT_CRITIQUE listener: receives critique from target AI, injects
//     it into ChatGPT's input and auto-submits
//
// TARGET:
//   - Sends CHATGPT_READY on load → receives context from background
//   - Injects context into input → auto-submits
//   - Waits for response to stabilize → sends CHATGPT_RESPONSE to background
//
// Globals from utils/summarize-generic.js (loaded before this file):
//   SUMMARY_PROMPT, parseSummary(), delay()

var DUPERMEM_SOURCE_MODEL = "chatgpt";
var DUPERMEM_BUTTON_ID    = "dupermemory-ask-btn";
var DUPERMEM_DROPDOWN_ID  = "dupermemory-dropdown";

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

injectButton();

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  var match = window.location.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return "conv_" + Date.now();
}

// ─── Button + Dropdown ────────────────────────────────────────────────────────

function injectButton() {
  if (document.getElementById(DUPERMEM_BUTTON_ID)) return;

  var container = document.createElement("div");
  container.id = DUPERMEM_BUTTON_ID + "-container";
  Object.assign(container.style, {
    position: "fixed",
    top:      "12px",
    right:    "12px",
    zIndex:   "2147483647",
    display:  "flex",
    flexDirection: "column",
    alignItems:    "flex-end",
    fontFamily:    "inherit",
  });

  var btn = document.createElement("button");
  btn.id = DUPERMEM_BUTTON_ID;
  btn.textContent = "Ask another AI";
  Object.assign(btn.style, {
    padding:      "7px 14px",
    background:   "#7c3aed",
    color:        "#fff",
    border:       "none",
    borderRadius: "8px",
    fontSize:     "13px",
    fontWeight:   "600",
    cursor:       "pointer",
    boxShadow:    "0 2px 8px rgba(0,0,0,0.3)",
    lineHeight:   "1.4",
  });
  btn.addEventListener("mouseenter", function () { btn.style.background = "#6d28d9"; });
  btn.addEventListener("mouseleave", function () { btn.style.background = "#7c3aed"; });
  btn.addEventListener("click", toggleDropdown);

  var dropdown = document.createElement("div");
  dropdown.id = DUPERMEM_DROPDOWN_ID;
  Object.assign(dropdown.style, {
    display:      "none",
    marginTop:    "4px",
    background:   "#1e1e2e",
    borderRadius: "8px",
    boxShadow:    "0 4px 16px rgba(0,0,0,0.4)",
    overflow:     "hidden",
    minWidth:     "150px",
  });

  container.appendChild(btn);
  container.appendChild(dropdown);
  document.body.appendChild(container);

  // Load models from background, excluding self.
  chrome.runtime.sendMessage({ type: "GET_MODELS", sourceModel: DUPERMEM_SOURCE_MODEL }, function (response) {
    if (chrome.runtime.lastError || !response || !response.models) {
      console.warn("[DuperMemory] Could not load model list:", chrome.runtime.lastError);
      return;
    }
    populateDropdown(dropdown, response.models);
  });

  document.addEventListener("click", function (e) {
    if (!container.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });
}

function populateDropdown(dropdown, models) {
  for (var i = 0; i < models.length; i++) {
    var model = models[i];
    var item = document.createElement("button");
    item.textContent = "Ask " + model.name;
    item.dataset.modelKey = model.key;
    Object.assign(item.style, {
      display:    "block",
      width:      "100%",
      padding:    "8px 14px",
      background: "transparent",
      color:      "#e0e0e0",
      border:     "none",
      fontSize:   "13px",
      cursor:     "pointer",
      textAlign:  "left",
      fontFamily: "inherit",
    });
    item.addEventListener("mouseenter", function () { this.style.background = "#2a2a3e"; });
    item.addEventListener("mouseleave", function () { this.style.background = "transparent"; });
    item.addEventListener("click", handleModelSelect);
    dropdown.appendChild(item);
  }
}

function toggleDropdown() {
  var dropdown = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (!dropdown) return;
  dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
}

// ─── Model selection → summarize → capture ────────────────────────────────────

async function handleModelSelect(e) {
  var modelKey = e.currentTarget.dataset.modelKey;
  var dropdown = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (dropdown) dropdown.style.display = "none";

  var messages = captureMessages();
  if (messages.length === 0) {
    alert(
      "DuperMemory: No messages found.\n\n" +
      "Make sure you are on a ChatGPT conversation page with at least one message."
    );
    return;
  }

  var btn = document.getElementById(DUPERMEM_BUTTON_ID);
  setBusy(btn, true);

  try {
    var summary = await summarizeConversation();
    var conversationId = DUPERMEM_CHAIN_CONV_ID || getConversationId();

    chrome.runtime.sendMessage({
      type:           "CAPTURE",
      summary:        summary,
      targetModel:    modelKey,
      sourceModel:    DUPERMEM_SOURCE_MODEL,
      conversationId: conversationId,
    });

  } catch (err) {
    console.error("[DuperMemory]", err);

    if (err.message && err.message.indexOf("Extension context invalidated") !== -1) {
      alert(
        "DuperMemory: Extension was reloaded.\n\n" +
        "Please refresh this tab (F5) and try again."
      );
    } else {
      alert("DuperMemory: Summarization failed.\n\n" + err.message);
    }
  } finally {
    setBusy(btn, false);
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled         = busy;
  btn.textContent      = busy ? "Summarizing\u2026" : "Ask another AI";
  btn.style.background = busy ? "#4c1d95" : "#7c3aed";
  btn.style.cursor     = busy ? "wait"    : "pointer";
}

// ─── Self-summarization (ChatGPT-specific) ────────────────────────────────────
//
// Injects SUMMARY_PROMPT into ChatGPT's own input, waits for ChatGPT's JSON
// response, parses it. This is a real message visible in the user's chat.

async function summarizeConversation() {
  var countBefore = countAssistantMessages();

  var injected = injectSummaryPrompt(SUMMARY_PROMPT);
  if (!injected) {
    throw new Error("[DuperMemory] Could not find ChatGPT's input field.");
  }

  await delay(300);

  var submitted = submitChatGPTInput();
  if (!submitted) {
    throw new Error("[DuperMemory] Could not submit the summarization prompt.");
  }

  var rawText = await waitForNewAssistantMessage(countBefore);
  return parseSummary(rawText);
}

function countAssistantMessages() {
  return document.querySelectorAll("[data-message-author-role='assistant']").length;
}

// ─── Wait for new assistant message (for self-summarization) ──────────────────

function waitForNewAssistantMessage(countBefore) {
  var POLL_MS       = 500;
  var STABLE_NEEDED = 4;
  var TIMEOUT_MS    = 90000;

  return new Promise(function (resolve, reject) {
    var phase       = 1;
    var lastContent = "";
    var stableCount = 0;
    var elapsed     = 0;

    function tick() {
      if (elapsed >= TIMEOUT_MS) {
        reject(new Error("[DuperMemory] Timed out waiting for ChatGPT's summary response."));
        return;
      }

      var allMsgs    = document.querySelectorAll("[data-message-author-role='assistant']");
      var curCount   = allMsgs.length;
      var lastMsg    = allMsgs[curCount - 1];
      var curContent = lastMsg ? lastMsg.innerText.trim() : "";

      if (phase === 1) {
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
          stableCount = 0;
          lastContent = curContent;
        }
      }

      elapsed += POLL_MS;
      setTimeout(tick, POLL_MS);
    }

    setTimeout(tick, POLL_MS);
  });
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
  var inputEl = await waitForChatGPTInput();
  injectTextIntoChatGPT(inputEl, content);
  await delay(300);
  submitChatGPTInput();
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

// Alias used by self-summarization flow.
function injectSummaryPrompt(text) {
  var el = findChatGPTInput();
  if (!el) return false;
  injectTextIntoChatGPT(el, text);
  return true;
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

function captureMessages() {
  var containers = document.querySelectorAll("[data-message-author-role]");
  var messages = [];

  for (var k = 0; k < containers.length; k++) {
    var el   = containers[k];
    var role = el.dataset.messageAuthorRole;
    if (role !== "user" && role !== "assistant") continue;

    var content = extractContent(el);
    if (!content) continue;

    messages.push({ role: role, content: content });
  }

  return messages;
}

function extractContent(messageEl) {
  var clone = messageEl.cloneNode(true);
  clone.querySelectorAll('button, [role="button"]').forEach(function (el) { el.remove(); });
  clone.querySelectorAll('[aria-hidden="true"]').forEach(function (el) { el.remove(); });
  return clone.innerText.trim();
}
