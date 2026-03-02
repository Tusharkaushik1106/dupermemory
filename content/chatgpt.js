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

  var styleTag = document.createElement("style");
  styleTag.textContent =
    "@keyframes dupermem-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}";
  document.head.appendChild(styleTag);

  var container = document.createElement("div");
  container.id = DUPERMEM_BUTTON_ID + "-container";
  Object.assign(container.style, {
    position:      "fixed",
    top:           "14px",
    right:         "14px",
    zIndex:        "2147483647",
    display:       "flex",
    flexDirection: "column",
    alignItems:    "flex-end",
    fontFamily:    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  });

  var btn = document.createElement("button");
  btn.id = DUPERMEM_BUTTON_ID;
  btn.innerHTML = '<span style="margin-right:6px;font-size:14px;vertical-align:-1px">&#x21C4;</span>Ask another AI';
  Object.assign(btn.style, {
    padding:              "6px 12px",
    background:           "rgba(15, 15, 20, 0.82)",
    color:                "#d4d4d8",
    border:               "1px solid rgba(255,255,255,0.08)",
    borderRadius:         "8px",
    fontSize:             "12.5px",
    fontWeight:           "500",
    cursor:               "pointer",
    boxShadow:            "0 1px 4px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.12)",
    lineHeight:           "1",
    letterSpacing:        "0.01em",
    transition:           "background 0.15s, border-color 0.15s, box-shadow 0.15s",
    backdropFilter:       "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
  });
  btn.addEventListener("mouseenter", function () {
    btn.style.background  = "rgba(28, 28, 38, 0.92)";
    btn.style.borderColor = "rgba(255,255,255,0.14)";
    btn.style.boxShadow   = "0 2px 8px rgba(0,0,0,0.3), 0 6px 16px rgba(0,0,0,0.15)";
  });
  btn.addEventListener("mouseleave", function () {
    btn.style.background  = "rgba(15, 15, 20, 0.82)";
    btn.style.borderColor = "rgba(255,255,255,0.08)";
    btn.style.boxShadow   = "0 1px 4px rgba(0,0,0,0.25), 0 4px 12px rgba(0,0,0,0.12)";
  });
  btn.addEventListener("click", toggleDropdown);

  var dropdown = document.createElement("div");
  dropdown.id = DUPERMEM_DROPDOWN_ID;
  Object.assign(dropdown.style, {
    display:              "none",
    marginTop:            "6px",
    background:           "rgba(18, 18, 24, 0.92)",
    border:               "1px solid rgba(255,255,255,0.07)",
    borderRadius:         "10px",
    boxShadow:            "0 8px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.08)",
    overflow:             "hidden",
    minWidth:             "160px",
    backdropFilter:       "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    padding:              "4px 0",
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
  var dotColors = {
    chatgpt: "#10a37f", claude: "#d97706", gemini: "#4285f4",
    perplexity: "#20808d", deepseek: "#6366f1",
  };
  for (var i = 0; i < models.length; i++) {
    var model = models[i];
    var item = document.createElement("button");
    var dc = dotColors[model.key] || "#888";
    item.innerHTML =
      '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' +
      dc + ';margin-right:9px;flex-shrink:0"></span>' + model.name;
    item.dataset.modelKey = model.key;
    Object.assign(item.style, {
      display:    "flex",
      alignItems: "center",
      width:      "100%",
      padding:    "7px 12px",
      background: "transparent",
      color:      "#a1a1aa",
      border:     "none",
      fontSize:   "12.5px",
      cursor:     "pointer",
      textAlign:  "left",
      fontFamily: "inherit",
      lineHeight: "1",
      transition: "background 0.1s, color 0.1s",
    });
    item.addEventListener("mouseenter", function () {
      this.style.background = "rgba(255,255,255,0.06)";
      this.style.color      = "#e4e4e7";
    });
    item.addEventListener("mouseleave", function () {
      this.style.background = "transparent";
      this.style.color      = "#a1a1aa";
    });
    item.addEventListener("click", handleModelSelect);
    dropdown.appendChild(item);
  }
}

function toggleDropdown() {
  var dropdown = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (!dropdown) return;
  var showing = dropdown.style.display === "none";
  dropdown.style.display = showing ? "block" : "none";
  if (showing) {
    dropdown.style.animation = "none";
    dropdown.offsetHeight;
    dropdown.style.animation = "dupermem-in 0.12s ease-out";
  }
}

// ─── Model selection → summarize → capture ────────────────────────────────────

function handleModelSelect(e) {
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
    var transcript = captureConversationText();
    var conversationId = DUPERMEM_CHAIN_CONV_ID || getConversationId();

    chrome.runtime.sendMessage({
      type:           "CAPTURE",
      transcript:     transcript,
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
      alert("DuperMemory: Capture failed.\n\n" + err.message);
    }
  } finally {
    setBusy(btn, false);
  }
}

function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? '<span style="margin-right:6px;font-size:14px;vertical-align:-1px">&#x21C4;</span>Capturing\u2026'
    : '<span style="margin-right:6px;font-size:14px;vertical-align:-1px">&#x21C4;</span>Ask another AI';
  btn.style.opacity = busy ? "0.5" : "1";
  btn.style.cursor  = busy ? "wait" : "pointer";
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

function captureConversationText() {
  var messages = captureMessages();
  if (messages.length === 0) return "";

  var lines = [];
  for (var i = 0; i < messages.length; i++) {
    var label = messages[i].role === "user" ? "User" : "Assistant";
    lines.push(label + ":\n" + messages[i].content);
  }
  return lines.join("\n\n");
}
