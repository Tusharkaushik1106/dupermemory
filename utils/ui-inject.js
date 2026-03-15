// utils/ui-inject.js — Shared DuperMemory UI widget
//
// Loaded as a content script on ALL supported AI sites via manifest.json,
// AFTER summarize-generic.js and BEFORE the site-specific content script.
//
// Provides:
//   - Draggable bottom-right FAB (position persisted in chrome.storage.local)
//   - Glassmorphism popover with tabbed "Ask AI" / "Replay" grid
//   - Live status feedback with morphing pill + spinner
//   - Namespaced CSS (.dm-widget) to avoid host-site conflicts
//
// Each content script must set these globals BEFORE this file runs:
//   DUPERMEM_SOURCE_MODEL  — e.g. "chatgpt", "claude", etc.
//
// Each content script must define these functions (called by ui-inject):
//   captureConversationText()   — returns transcript string for Ask AI flow
//   captureMessages()           — returns [{role, content}] for Replay flow
//   formatMessagesAsTranscript(messages) — returns flattened transcript string
//   getConversationId()         — returns conversation ID string
//
// Globals set by this file for content scripts to reference:
//   DUPERMEM_CHAIN_CONV_ID — chain conversation ID (set by target flow)
//   DUPERMEM_BUTTON_ID     — FAB element ID
//   DUPERMEM_DROPDOWN_ID   — popover element ID (legacy compat)

var DUPERMEM_BUTTON_ID   = "dm-fab";
var DUPERMEM_DROPDOWN_ID = "dm-popover";

// Chain conversation ID — set when this tab is opened as a target.
// Content scripts check this in their handlers.
if (typeof DUPERMEM_CHAIN_CONV_ID === "undefined") {
  var DUPERMEM_CHAIN_CONV_ID = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSS INJECTION
// ═══════════════════════════════════════════════════════════════════════════════

(function injectStyles() {
  if (document.getElementById("dm-widget-styles")) return;

  var css = [
    // ── Reset scope ──
    ".dm-widget, .dm-widget *, .dm-widget *::before, .dm-widget *::after {",
    "  box-sizing: border-box;",
    "  margin: 0; padding: 0;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
    "  line-height: 1.4;",
    "}",

    // ── Animations ──
    "@keyframes dm-fade-in {",
    "  from { opacity: 0; transform: translateY(8px) scale(0.96); }",
    "  to   { opacity: 1; transform: translateY(0) scale(1); }",
    "}",
    "@keyframes dm-spin {",
    "  to { transform: rotate(360deg); }",
    "}",
    "@keyframes dm-pulse {",
    "  0%, 100% { box-shadow: 0 2px 12px rgba(99,102,241,0.25); }",
    "  50%      { box-shadow: 0 2px 20px rgba(99,102,241,0.5); }",
    "}",

    // ── FAB container ──
    ".dm-widget-root {",
    "  position: fixed;",
    "  z-index: 2147483647;",
    "  display: flex;",
    "  flex-direction: column;",
    "  align-items: flex-end;",
    "}",

    // ── FAB button ──
    ".dm-fab {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  gap: 8px;",
    "  height: 44px;",
    "  padding: 0 16px;",
    "  border-radius: 22px;",
    "  border: 1px solid rgba(255,255,255,0.1);",
    "  background: rgba(15, 15, 22, 0.85);",
    "  color: #e4e4e7;",
    "  font-size: 13px;",
    "  font-weight: 600;",
    "  cursor: grab;",
    "  user-select: none;",
    "  white-space: nowrap;",
    "  backdrop-filter: blur(16px);",
    "  -webkit-backdrop-filter: blur(16px);",
    "  box-shadow: 0 2px 12px rgba(0,0,0,0.3), 0 0 0 1px rgba(0,0,0,0.1);",
    "  transition: background 0.2s, box-shadow 0.2s, border-color 0.2s, width 0.3s, padding 0.3s;",
    "  outline: none;",
    "}",
    ".dm-fab:hover {",
    "  background: rgba(28, 28, 40, 0.92);",
    "  border-color: rgba(255,255,255,0.16);",
    "  box-shadow: 0 4px 20px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.08);",
    "}",
    ".dm-fab:active { cursor: grabbing; }",

    // ── FAB icon ──
    ".dm-fab-icon {",
    "  font-size: 18px;",
    "  line-height: 1;",
    "  flex-shrink: 0;",
    "}",

    // ── FAB loading state ──
    ".dm-fab--loading {",
    "  cursor: default;",
    "  animation: dm-pulse 1.8s ease-in-out infinite;",
    "}",
    ".dm-fab--loading .dm-fab-spinner {",
    "  display: block;",
    "}",
    ".dm-fab-spinner {",
    "  display: none;",
    "  width: 16px; height: 16px;",
    "  border: 2px solid rgba(255,255,255,0.15);",
    "  border-top-color: #a78bfa;",
    "  border-radius: 50%;",
    "  animation: dm-spin 0.7s linear infinite;",
    "  flex-shrink: 0;",
    "}",

    // ── Popover ──
    ".dm-popover {",
    "  display: none;",
    "  position: absolute;",
    "  bottom: calc(100% + 10px);",
    "  right: 0;",
    "  width: 280px;",
    "  border-radius: 16px;",
    "  border: 1px solid rgba(255,255,255,0.08);",
    "  background: rgba(18, 18, 26, 0.92);",
    "  backdrop-filter: blur(20px);",
    "  -webkit-backdrop-filter: blur(20px);",
    "  box-shadow: 0 12px 40px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.06);",
    "  overflow: hidden;",
    "  animation: dm-fade-in 0.15s ease-out;",
    "}",
    ".dm-popover--open { display: block; }",

    // ── Popover header ──
    ".dm-popover-header {",
    "  display: flex;",
    "  align-items: center;",
    "  padding: 14px 16px 0;",
    "}",
    ".dm-popover-title {",
    "  font-size: 10px;",
    "  font-weight: 700;",
    "  color: #52525b;",
    "  letter-spacing: 0.08em;",
    "  text-transform: uppercase;",
    "}",

    // ── Tabs ──
    ".dm-tabs {",
    "  display: flex;",
    "  gap: 2px;",
    "  padding: 10px 12px 0;",
    "  background: transparent;",
    "}",
    ".dm-tab {",
    "  flex: 1;",
    "  padding: 8px 0;",
    "  border: none;",
    "  border-radius: 8px;",
    "  background: transparent;",
    "  color: #71717a;",
    "  font-size: 12px;",
    "  font-weight: 600;",
    "  cursor: pointer;",
    "  transition: background 0.15s, color 0.15s;",
    "  text-align: center;",
    "}",
    ".dm-tab:hover {",
    "  background: rgba(255,255,255,0.05);",
    "  color: #a1a1aa;",
    "}",
    ".dm-tab--active {",
    "  background: rgba(255,255,255,0.08);",
    "  color: #e4e4e7;",
    "}",

    // ── Model grid ──
    ".dm-grid {",
    "  display: grid;",
    "  grid-template-columns: 1fr 1fr;",
    "  gap: 6px;",
    "  padding: 10px 12px 14px;",
    "}",
    ".dm-grid--hidden { display: none; }",

    // ── Model pill button ──
    ".dm-pill {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 8px;",
    "  padding: 9px 12px;",
    "  border-radius: 10px;",
    "  border: 1px solid rgba(255,255,255,0.06);",
    "  background: rgba(255,255,255,0.03);",
    "  color: #a1a1aa;",
    "  font-size: 12px;",
    "  font-weight: 500;",
    "  cursor: pointer;",
    "  transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.1s;",
    "  text-align: left;",
    "  white-space: nowrap;",
    "  overflow: hidden;",
    "  text-overflow: ellipsis;",
    "}",
    ".dm-pill:hover {",
    "  background: rgba(255,255,255,0.07);",
    "  color: #e4e4e7;",
    "  border-color: rgba(255,255,255,0.12);",
    "  transform: translateY(-1px);",
    "}",
    ".dm-pill:active {",
    "  transform: translateY(0);",
    "}",

    // ── Model dot ──
    ".dm-dot {",
    "  width: 8px; height: 8px;",
    "  border-radius: 50%;",
    "  flex-shrink: 0;",
    "}",
  ].join("\n");

  var style = document.createElement("style");
  style.id = "dm-widget-styles";
  style.textContent = css;
  document.head.appendChild(style);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL COLORS
// ═══════════════════════════════════════════════════════════════════════════════

var DM_DOT_COLORS = {
  chatgpt:    "#10a37f",
  claude:     "#d97706",
  gemini:     "#4285f4",
  perplexity: "#20808d",
  deepseek:   "#6366f1",
};

// ═══════════════════════════════════════════════════════════════════════════════
// STATUS MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

var DM_STATUS_TIMEOUT = null;

function dmSetStatus(status, detail) {
  var fab = document.getElementById(DUPERMEM_BUTTON_ID);
  if (!fab) return;

  var iconEl   = fab.querySelector(".dm-fab-icon");
  var labelEl  = fab.querySelector(".dm-fab-label");
  var spinEl   = fab.querySelector(".dm-fab-spinner");

  if (status === "idle") {
    fab.classList.remove("dm-fab--loading");
    fab.disabled = false;
    fab.style.cursor = "grab";
    if (iconEl)  iconEl.textContent  = "\u21C4";
    if (labelEl) labelEl.textContent = "DuperMemory";
    if (spinEl)  spinEl.style.display = "none";
    if (DM_STATUS_TIMEOUT) { clearTimeout(DM_STATUS_TIMEOUT); DM_STATUS_TIMEOUT = null; }
    return;
  }

  fab.classList.add("dm-fab--loading");
  fab.disabled = true;
  fab.style.cursor = "default";
  if (spinEl) spinEl.style.display = "block";

  var labels = {
    capturing: "Capturing\u2026",
    opening:   "Routing to " + (detail || "target") + "\u2026",
    waiting:   "Waiting for response\u2026",
    done:      "Done \u2713",
  };
  if (iconEl) iconEl.textContent = "";
  if (labelEl) labelEl.textContent = labels[status] || status;

  if (status === "done") {
    fab.classList.remove("dm-fab--loading");
    if (spinEl) spinEl.style.display = "none";
    if (DM_STATUS_TIMEOUT) clearTimeout(DM_STATUS_TIMEOUT);
    DM_STATUS_TIMEOUT = setTimeout(function () { dmSetStatus("idle"); }, 2000);
  }
}

// Legacy compat — content scripts and message listeners may call setStatus(btn, status, detail).
// Redirect to the new manager, ignoring the btn argument.
function setStatus(_btn, status, detail) {
  dmSetStatus(status, detail);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAG LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

var DM_DRAG_STATE = { dragging: false, startX: 0, startY: 0, origX: 0, origY: 0, moved: false };
var DM_STORAGE_KEY = "dupermemory_fab_pos";

function dmLoadPosition(cb) {
  chrome.storage.local.get(DM_STORAGE_KEY, function (data) {
    cb(data[DM_STORAGE_KEY] || null);
  });
}

function dmSavePosition(x, y) {
  var obj = {};
  obj[DM_STORAGE_KEY] = { right: x, bottom: y };
  chrome.storage.local.set(obj);
}

function dmApplyPosition(root, pos) {
  root.style.right  = pos.right  + "px";
  root.style.bottom = pos.bottom + "px";
  // Clear top/left in case they were set
  root.style.left = "auto";
  root.style.top  = "auto";
}

function dmInitDrag(root) {
  var fab = root.querySelector(".dm-fab");
  if (!fab) return;

  fab.addEventListener("mousedown", function (e) {
    // Only primary button
    if (e.button !== 0) return;
    DM_DRAG_STATE.dragging = true;
    DM_DRAG_STATE.moved    = false;
    DM_DRAG_STATE.startX   = e.clientX;
    DM_DRAG_STATE.startY   = e.clientY;
    DM_DRAG_STATE.origX    = parseInt(root.style.right)  || 24;
    DM_DRAG_STATE.origY    = parseInt(root.style.bottom) || 24;
    fab.style.cursor = "grabbing";
    e.preventDefault();
  });

  document.addEventListener("mousemove", function (e) {
    if (!DM_DRAG_STATE.dragging) return;

    var dx = DM_DRAG_STATE.startX - e.clientX;
    var dy = DM_DRAG_STATE.startY - e.clientY;

    // Only count as a drag if moved > 4px
    if (!DM_DRAG_STATE.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      DM_DRAG_STATE.moved = true;
    }

    if (DM_DRAG_STATE.moved) {
      var newRight  = Math.max(0, Math.min(window.innerWidth - 60,  DM_DRAG_STATE.origX + dx));
      var newBottom = Math.max(0, Math.min(window.innerHeight - 60, DM_DRAG_STATE.origY + dy));
      root.style.right  = newRight  + "px";
      root.style.bottom = newBottom + "px";
    }
  });

  document.addEventListener("mouseup", function () {
    if (!DM_DRAG_STATE.dragging) return;
    DM_DRAG_STATE.dragging = false;
    fab.style.cursor = "grab";

    if (DM_DRAG_STATE.moved) {
      var r = parseInt(root.style.right)  || 24;
      var b = parseInt(root.style.bottom) || 24;
      dmSavePosition(r, b);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POPOVER & TABS
// ═══════════════════════════════════════════════════════════════════════════════

function dmTogglePopover() {
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (!popover) return;
  popover.classList.toggle("dm-popover--open");
  // Re-trigger animation on open
  if (popover.classList.contains("dm-popover--open")) {
    popover.style.animation = "none";
    popover.offsetHeight; // force reflow
    popover.style.animation = "";
  }
}

// Legacy compat
function toggleDropdown() {
  dmTogglePopover();
}

function dmSwitchTab(tabId) {
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (!popover) return;

  var tabs = popover.querySelectorAll(".dm-tab");
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].dataset.tab === tabId) {
      tabs[i].classList.add("dm-tab--active");
    } else {
      tabs[i].classList.remove("dm-tab--active");
    }
  }

  var grids = popover.querySelectorAll(".dm-grid");
  for (var g = 0; g < grids.length; g++) {
    if (grids[g].dataset.tab === tabId) {
      grids[g].classList.remove("dm-grid--hidden");
    } else {
      grids[g].classList.add("dm-grid--hidden");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS — wired to the content script's capture/replay functions
// ═══════════════════════════════════════════════════════════════════════════════

function handleModelSelect(e) {
  var modelKey = e.currentTarget.dataset.modelKey;

  // Close popover
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (popover) popover.classList.remove("dm-popover--open");

  dmSetStatus("capturing");
  if (DM_STATUS_TIMEOUT) clearTimeout(DM_STATUS_TIMEOUT);
  DM_STATUS_TIMEOUT = setTimeout(function () {
    dmSetStatus("idle");
  }, 120000);

  try {
    var transcript = captureConversationText();
    if (!transcript || transcript.length < 20) {
      dmSetStatus("idle");
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
    dmSetStatus("idle");

    if (err.message && err.message.indexOf("Extension context invalidated") !== -1) {
      alert("DuperMemory: Extension was reloaded.\n\nPlease refresh this tab (F5) and try again.");
    } else {
      alert("DuperMemory: Capture failed.\n\n" + err.message);
    }
  }
}

function handleReplaySelect(e) {
  var modelKey = e.currentTarget.dataset.modelKey;

  // Close popover
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (popover) popover.classList.remove("dm-popover--open");

  var messages = captureMessages();
  if (messages.length === 0) {
    alert(
      "DuperMemory: No messages found.\n\n" +
      "Make sure you are on a conversation page with at least one message."
    );
    return;
  }

  dmSetStatus("capturing");
  if (DM_STATUS_TIMEOUT) clearTimeout(DM_STATUS_TIMEOUT);
  DM_STATUS_TIMEOUT = setTimeout(function () {
    dmSetStatus("idle");
  }, 120000);

  var conversationId = DUPERMEM_CHAIN_CONV_ID || getConversationId();
  var transcript = formatMessagesAsTranscript(messages);

  chrome.runtime.sendMessage({
    type:           "REPLAY_CONVERSATION",
    transcript:     transcript,
    targetModel:    modelKey,
    sourceModel:    DUPERMEM_SOURCE_MODEL,
    conversationId: conversationId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILD & INJECT
// ═══════════════════════════════════════════════════════════════════════════════

function injectButton() {
  if (document.getElementById(DUPERMEM_BUTTON_ID)) return;

  // ── Root container ──
  var root = document.createElement("div");
  root.classList.add("dm-widget", "dm-widget-root");
  root.style.bottom = "24px";
  root.style.right  = "24px";

  // ── FAB ──
  var fab = document.createElement("button");
  fab.id = DUPERMEM_BUTTON_ID;
  fab.classList.add("dm-widget", "dm-fab");

  var fabIcon = document.createElement("span");
  fabIcon.classList.add("dm-fab-icon");
  fabIcon.textContent = "\u21C4";

  var fabLabel = document.createElement("span");
  fabLabel.classList.add("dm-fab-label");
  fabLabel.textContent = "DuperMemory";

  var fabSpinner = document.createElement("span");
  fabSpinner.classList.add("dm-fab-spinner");

  fab.appendChild(fabSpinner);
  fab.appendChild(fabIcon);
  fab.appendChild(fabLabel);

  // Click toggles popover — but only if we didn't drag
  fab.addEventListener("click", function (e) {
    if (DM_DRAG_STATE.moved) return; // was a drag, not a click
    if (fab.disabled) return;
    dmTogglePopover();
  });

  // ── Popover ──
  var popover = document.createElement("div");
  popover.id = DUPERMEM_DROPDOWN_ID;
  popover.classList.add("dm-widget", "dm-popover");

  // Header
  var header = document.createElement("div");
  header.classList.add("dm-popover-header");
  var title = document.createElement("span");
  title.classList.add("dm-popover-title");
  title.textContent = "DUPERMEMORY";
  header.appendChild(title);
  popover.appendChild(header);

  // Tabs
  var tabBar = document.createElement("div");
  tabBar.classList.add("dm-widget", "dm-tabs");

  var tabAsk = document.createElement("button");
  tabAsk.classList.add("dm-widget", "dm-tab", "dm-tab--active");
  tabAsk.dataset.tab = "ask";
  tabAsk.textContent = "Ask AI";
  tabAsk.addEventListener("click", function () { dmSwitchTab("ask"); });

  var tabReplay = document.createElement("button");
  tabReplay.classList.add("dm-widget", "dm-tab");
  tabReplay.dataset.tab = "replay";
  tabReplay.textContent = "Replay";
  tabReplay.addEventListener("click", function () { dmSwitchTab("replay"); });

  tabBar.appendChild(tabAsk);
  tabBar.appendChild(tabReplay);
  popover.appendChild(tabBar);

  // Grids (filled after model list loads)
  var gridAsk = document.createElement("div");
  gridAsk.classList.add("dm-widget", "dm-grid");
  gridAsk.dataset.tab = "ask";
  popover.appendChild(gridAsk);

  var gridReplay = document.createElement("div");
  gridReplay.classList.add("dm-widget", "dm-grid", "dm-grid--hidden");
  gridReplay.dataset.tab = "replay";
  popover.appendChild(gridReplay);

  // ── Assemble ──
  root.appendChild(popover);
  root.appendChild(fab);
  document.body.appendChild(root);

  // ── Load saved position ──
  dmLoadPosition(function (pos) {
    if (pos && typeof pos.right === "number" && typeof pos.bottom === "number") {
      dmApplyPosition(root, pos);
    }
  });

  // ── Init drag ──
  dmInitDrag(root);

  // ── Close popover on outside click ──
  document.addEventListener("click", function (e) {
    if (!root.contains(e.target)) {
      var p = document.getElementById(DUPERMEM_DROPDOWN_ID);
      if (p) p.classList.remove("dm-popover--open");
    }
  });

  // ── Load models from background ──
  chrome.runtime.sendMessage(
    { type: "GET_MODELS", sourceModel: DUPERMEM_SOURCE_MODEL },
    function (response) {
      if (chrome.runtime.lastError || !response || !response.models) {
        console.warn("[DuperMemory] Could not load model list:", chrome.runtime.lastError);
        return;
      }
      dmPopulateGrids(gridAsk, gridReplay, response.models);
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// POPULATE MODEL GRIDS
// ═══════════════════════════════════════════════════════════════════════════════

function dmPopulateGrids(gridAsk, gridReplay, models) {
  for (var i = 0; i < models.length; i++) {
    gridAsk.appendChild(dmCreatePill(models[i], handleModelSelect));
    gridReplay.appendChild(dmCreatePill(models[i], handleReplaySelect));
  }
}

function dmCreatePill(model, handler) {
  var pill = document.createElement("button");
  pill.classList.add("dm-widget", "dm-pill");
  pill.dataset.modelKey = model.key;

  var dot = document.createElement("span");
  dot.classList.add("dm-dot");
  dot.style.background = DM_DOT_COLORS[model.key] || "#888";

  var label = document.createElement("span");
  label.textContent = model.name;

  pill.appendChild(dot);
  pill.appendChild(label);
  pill.addEventListener("click", handler);

  return pill;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE LISTENER — status updates, toggle, critique
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener(function (message) {
  if (message.type === "STATUS_UPDATE") {
    dmSetStatus(message.status, message.detail);
  }
  if (message.type === "TOGGLE_DROPDOWN") {
    dmTogglePopover();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// INIT — inject the widget into the page
// ═══════════════════════════════════════════════════════════════════════════════

injectButton();
