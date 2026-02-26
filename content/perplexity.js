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
//   - Self-summarization: injects SUMMARY_PROMPT into Perplexity, waits for
//     Perplexity's JSON response, parses it, sends CAPTURE to background
//   - INJECT_CRITIQUE listener: receives critique from target AI
//
// IMPORTANT: Selectors are best-effort. Must be confirmed against live DOM.
//
// Globals from utils/summarize-generic.js (loaded before this file):
//   SUMMARY_PROMPT, parseSummary(), delay()

var DUPERMEM_SOURCE_MODEL = "perplexity";
var DUPERMEM_BUTTON_ID    = "dupermemory-ask-btn";
var DUPERMEM_DROPDOWN_ID  = "dupermemory-dropdown";

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

injectButton();

// ─── Conversation ID ──────────────────────────────────────────────────────────

function getConversationId() {
  // Perplexity URLs: https://www.perplexity.ai/search/abc123
  var match = window.location.pathname.match(/\/search\/([a-zA-Z0-9_-]+)/);
  if (match) return "perplexity_" + match[1];
  return "perplexity_conv_" + Date.now();
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
      alert("DuperMemory: Extension was reloaded.\n\nPlease refresh this tab (F5) and try again.");
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

// ─── Self-summarization (Perplexity-specific) ─────────────────────────────────

async function summarizeConversation() {
  var inputEl = await waitForPerplexityInput();

  var scopeEl = document.querySelector("main") || document.body;

  injectText(inputEl, SUMMARY_PROMPT);
  await delay(400);

  var snapshot = scopeEl.innerText;

  var submitted = submitPerplexityInput(inputEl);
  if (!submitted) {
    throw new Error("[DuperMemory] Could not submit the summarization prompt to Perplexity.");
  }

  var rawText = await waitForPerplexityResponse(scopeEl, snapshot);
  return parseSummary(rawText);
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
  var inputEl = await waitForPerplexityInput();
  injectText(inputEl, content);
  await delay(400);
  submitPerplexityInput(inputEl);
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

function extractResponse(beforeText, afterText) {
  var raw = afterText.slice(beforeText.length).trim();
  var meaningful = raw
    .split("\n")
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 10; });
  return meaningful.join("\n").trim();
}
