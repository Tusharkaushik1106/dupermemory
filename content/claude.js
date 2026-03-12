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
var DUPERMEM_BUTTON_ID    = "dupermemory-ask-btn";
var DUPERMEM_DROPDOWN_ID  = "dupermemory-dropdown";

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

injectButton();

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  // Claude URLs: https://claude.ai/chat/abc123-def456
  var match = window.location.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
  if (match) return "claude_" + match[1];
  return "claude_conv_" + Date.now();
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

  var label = document.createElement("div");
  label.textContent = "DUPERMEMORY";
  Object.assign(label.style, {
    padding:       "7px 12px 3px",
    fontSize:      "9.5px",
    fontWeight:    "600",
    color:         "#52525b",
    letterSpacing: "0.06em",
  });
  dropdown.appendChild(label);

  container.appendChild(btn);
  container.appendChild(dropdown);
  document.body.appendChild(container);

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

  var btn = document.getElementById(DUPERMEM_BUTTON_ID);
  setStatus(btn, "capturing");
  if (DUPERMEM_STATUS_TIMEOUT) clearTimeout(DUPERMEM_STATUS_TIMEOUT);
  DUPERMEM_STATUS_TIMEOUT = setTimeout(function () {
    var b = document.getElementById(DUPERMEM_BUTTON_ID);
    if (b && b.disabled) setStatus(b, "idle");
  }, 120000);

  try {
    var transcript = captureConversationText();
    if (!transcript || transcript.length < 20) {
      setStatus(btn, "idle");
      alert(
        "DuperMemory: No conversation content found.\n\n" +
        "Make sure you are on a conversation page with at least one message."
      );
      return;
    }

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
    setStatus(btn, "idle");

    if (err.message && err.message.indexOf("Extension context invalidated") !== -1) {
      alert("DuperMemory: Extension was reloaded.\n\nPlease refresh this tab (F5) and try again.");
    } else {
      alert("DuperMemory: Capture failed.\n\n" + err.message);
    }
  }
}

var DUPERMEM_STATUS_TIMEOUT = null;

function setStatus(btn, status, detail) {
  if (!btn) return;
  var icon = '<span style="margin-right:6px;font-size:14px;vertical-align:-1px">&#x21C4;</span>';
  if (status === "idle") {
    btn.disabled = false;
    btn.innerHTML = icon + "Ask another AI";
    btn.style.opacity = "1";
    btn.style.cursor  = "pointer";
    if (DUPERMEM_STATUS_TIMEOUT) { clearTimeout(DUPERMEM_STATUS_TIMEOUT); DUPERMEM_STATUS_TIMEOUT = null; }
    return;
  }
  btn.disabled = true;
  btn.style.cursor = "wait";
  var labels = {
    capturing: "Capturing\u2026",
    opening:   "Opening " + (detail || "target") + "\u2026",
    waiting:   "Waiting for response\u2026",
    done:      "Done \u2713",
  };
  btn.innerHTML = icon + (labels[status] || status);
  btn.style.opacity = status === "done" ? "1" : "0.7";
  if (status === "done") {
    if (DUPERMEM_STATUS_TIMEOUT) clearTimeout(DUPERMEM_STATUS_TIMEOUT);
    DUPERMEM_STATUS_TIMEOUT = setTimeout(function () { setStatus(btn, "idle"); }, 2000);
  }
}

// ─── Critique receiver ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === "INJECT_CRITIQUE") {
    injectCritiqueFlow(message.content).catch(function (err) {
      console.error("[DuperMemory] Critique injection failed:", err.message);
    });
  }
  if (message.type === "STATUS_UPDATE") {
    var btn = document.getElementById(DUPERMEM_BUTTON_ID);
    setStatus(btn, message.status, message.detail);
  }
  if (message.type === "TOGGLE_DROPDOWN") {
    toggleDropdown();
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

function captureConversationText() {
  var scopeEl = document.querySelector("main") || document.body;
  return scopeEl.innerText.trim();
}

function extractResponse(beforeText, afterText) {
  var raw = afterText.slice(beforeText.length).trim();
  var meaningful = raw
    .split("\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 10; });
  return meaningful.join("\n").trim();
}
