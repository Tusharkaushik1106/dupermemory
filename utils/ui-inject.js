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

    // ── Export footer ──
    ".dm-popover-footer {",
    "  border-top: 1px solid rgba(255,255,255,0.06);",
    "  padding: 8px 12px 10px;",
    "}",
    ".dm-export-btn {",
    "  display: flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  gap: 6px;",
    "  width: 100%;",
    "  padding: 8px 0;",
    "  border-radius: 8px;",
    "  border: 1px solid rgba(255,255,255,0.06);",
    "  background: rgba(255,255,255,0.03);",
    "  color: #a1a1aa;",
    "  font-size: 12px;",
    "  font-weight: 500;",
    "  cursor: pointer;",
    "  transition: background 0.12s, color 0.12s, border-color 0.12s;",
    "}",
    ".dm-export-btn:hover {",
    "  background: rgba(255,255,255,0.07);",
    "  color: #e4e4e7;",
    "  border-color: rgba(255,255,255,0.12);",
    "}",
    ".dm-export-btn:disabled {",
    "  cursor: default;",
    "  opacity: 0.7;",
    "}",

    // ── Vault panel ──
    ".dm-vault {",
    "  padding: 10px 12px 14px;",
    "}",
    ".dm-vault--hidden { display: none; }",
    ".dm-vault-textarea {",
    "  display: block;",
    "  width: 100%;",
    "  min-height: 90px;",
    "  max-height: 160px;",
    "  padding: 10px;",
    "  border-radius: 8px;",
    "  border: 1px solid rgba(255,255,255,0.08);",
    "  background: rgba(255,255,255,0.03);",
    "  color: #d4d4d8;",
    "  font-size: 12px;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;",
    "  line-height: 1.5;",
    "  resize: vertical;",
    "  outline: none;",
    "  transition: border-color 0.15s;",
    "}",
    ".dm-vault-textarea::placeholder {",
    "  color: #52525b;",
    "}",
    ".dm-vault-textarea:focus {",
    "  border-color: rgba(167, 139, 250, 0.4);",
    "}",
    ".dm-vault-save {",
    "  display: block;",
    "  width: 100%;",
    "  margin-top: 8px;",
    "  padding: 8px 0;",
    "  border-radius: 8px;",
    "  border: 1px solid rgba(255,255,255,0.06);",
    "  background: rgba(139, 92, 246, 0.12);",
    "  color: #c4b5fd;",
    "  font-size: 12px;",
    "  font-weight: 600;",
    "  cursor: pointer;",
    "  transition: background 0.12s, color 0.12s;",
    "}",
    ".dm-vault-save:hover {",
    "  background: rgba(139, 92, 246, 0.2);",
    "  color: #ddd6fe;",
    "}",
    ".dm-vault-save:disabled {",
    "  cursor: default;",
    "  opacity: 0.7;",
    "}",

    // ── Toast ──
    ".dm-toast {",
    "  position: fixed;",
    "  bottom: 80px;",
    "  right: 24px;",
    "  padding: 10px 18px;",
    "  border-radius: 10px;",
    "  background: rgba(15, 15, 22, 0.9);",
    "  color: #e4e4e7;",
    "  font-size: 13px;",
    "  font-weight: 500;",
    "  backdrop-filter: blur(12px);",
    "  -webkit-backdrop-filter: blur(12px);",
    "  box-shadow: 0 4px 16px rgba(0,0,0,0.3);",
    "  border: 1px solid rgba(255,255,255,0.08);",
    "  opacity: 0;",
    "  transform: translateY(8px);",
    "  transition: opacity 0.2s, transform 0.2s;",
    "  z-index: 2147483647;",
    "  pointer-events: none;",
    "}",
    ".dm-toast--visible {",
    "  opacity: 1;",
    "  transform: translateY(0);",
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
// UI STATE LOCK — prevents double-clicks and duplicate actions
// ═══════════════════════════════════════════════════════════════════════════════

var DM_UI_LOCKED = false;

function dmLockUI() {
  DM_UI_LOCKED = true;
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (!popover) return;
  var buttons = popover.querySelectorAll(".dm-pill, .dm-export-btn");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].disabled = true;
    buttons[i].style.opacity = "0.5";
    buttons[i].style.pointerEvents = "none";
  }
}

function dmUnlockUI() {
  DM_UI_LOCKED = false;
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (!popover) return;
  var buttons = popover.querySelectorAll(".dm-pill, .dm-export-btn");
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].disabled = false;
    buttons[i].style.opacity = "";
    buttons[i].style.pointerEvents = "";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATION — non-blocking feedback for empty state and errors
// ═══════════════════════════════════════════════════════════════════════════════

function dmShowToast(text, durationMs) {
  var existing = document.getElementById("dm-toast");
  if (existing) existing.remove();

  var toast = document.createElement("div");
  toast.id = "dm-toast";
  toast.classList.add("dm-widget", "dm-toast");
  toast.textContent = text;
  document.body.appendChild(toast);

  // Trigger reflow then add visible class for transition
  toast.offsetHeight;
  toast.classList.add("dm-toast--visible");

  setTimeout(function () {
    toast.classList.remove("dm-toast--visible");
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 200);
  }, durationMs || 3000);
}

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
    dmUnlockUI();
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

  // Toggle grid panels (ask / replay)
  var grids = popover.querySelectorAll(".dm-grid");
  for (var g = 0; g < grids.length; g++) {
    if (grids[g].dataset.tab === tabId) {
      grids[g].classList.remove("dm-grid--hidden");
    } else {
      grids[g].classList.add("dm-grid--hidden");
    }
  }

  // Toggle vault panel
  var vault = popover.querySelector(".dm-vault");
  if (vault) {
    if (tabId === "vault") {
      vault.classList.remove("dm-vault--hidden");
      // Load saved vault text
      dmLoadVaultText();
    } else {
      vault.classList.add("dm-vault--hidden");
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLERS — wired to the content script's capture/replay functions
// ═══════════════════════════════════════════════════════════════════════════════

function handleModelSelect(e) {
  if (DM_UI_LOCKED) return;
  var modelKey = e.currentTarget.dataset.modelKey;

  // Close popover + lock UI
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (popover) popover.classList.remove("dm-popover--open");
  dmLockUI();

  dmSetStatus("capturing");
  if (DM_STATUS_TIMEOUT) clearTimeout(DM_STATUS_TIMEOUT);
  DM_STATUS_TIMEOUT = setTimeout(function () {
    dmSetStatus("idle");
  }, 120000);

  try {
    var transcript = captureConversationText();
    if (!transcript || transcript.length < 20) {
      dmSetStatus("idle");
      dmShowToast("No conversation found", 3000);
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
      dmShowToast("Extension reloaded -- please refresh this tab", 4000);
    } else {
      dmShowToast("Capture failed: " + err.message, 4000);
    }
  }
}

function handleReplaySelect(e) {
  if (DM_UI_LOCKED) return;
  var modelKey = e.currentTarget.dataset.modelKey;

  // Close popover + lock UI
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (popover) popover.classList.remove("dm-popover--open");
  dmLockUI();

  var messages = captureMessages();
  if (messages.length === 0) {
    dmUnlockUI();
    dmShowToast("No conversation found", 3000);
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
// VAULT HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

var DM_VAULT_KEY = "dm_global_vault";

function dmLoadVaultText() {
  var textarea = document.getElementById("dm-vault-textarea");
  if (!textarea) return;
  chrome.storage.local.get(DM_VAULT_KEY, function (data) {
    if (chrome.runtime.lastError) return;
    textarea.value = data[DM_VAULT_KEY] || "";
  });
}

function dmSaveVault() {
  var textarea = document.getElementById("dm-vault-textarea");
  var saveBtn = document.getElementById("dm-vault-save");
  if (!textarea) return;

  var obj = {};
  obj[DM_VAULT_KEY] = textarea.value;
  chrome.storage.local.set(obj, function () {
    if (chrome.runtime.lastError) {
      console.error("[DuperMemory] Vault save failed:", chrome.runtime.lastError.message);
      return;
    }
    if (saveBtn) {
      saveBtn.textContent = "Saved";
      saveBtn.disabled = true;
      setTimeout(function () {
        saveBtn.textContent = "Save Preferences";
        saveBtn.disabled = false;
      }, 2000);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleExportThread() {
  if (DM_UI_LOCKED) return;
  var exportBtn = document.getElementById("dm-export-btn");

  var messages = captureMessages();
  if (messages.length === 0) {
    dmShowToast("No messages found", 3000);
    return;
  }

  // Close popover
  var popover = document.getElementById(DUPERMEM_DROPDOWN_ID);
  if (popover) popover.classList.remove("dm-popover--open");

  // Visual feedback: Exporting...
  if (exportBtn) {
    exportBtn.textContent = "Exporting\u2026";
    exportBtn.disabled = true;
  }

  // Flatten to remove any DuperMemory meta-prompt boilerplate
  var transcript = flattenInjectedContext(messages);

  // Re-parse the flattened transcript back into a messages array for Markdown
  // generation. flattenInjectedContext returns a string, so we split it back.
  var cleanMessages = parseTranscriptToMessages(transcript);
  if (cleanMessages.length === 0) {
    // Fallback: use the raw captured messages
    cleanMessages = messages;
  }

  var markdown = generateMarkdown(cleanMessages);

  // Try to derive a topic from the first user message
  var topic = "";
  for (var i = 0; i < cleanMessages.length; i++) {
    if (cleanMessages[i].role === "user" && cleanMessages[i].content.length > 5) {
      topic = cleanMessages[i].content.substring(0, 60);
      break;
    }
  }

  downloadMarkdownFile(markdown, topic);

  // Visual feedback: Export Complete
  if (exportBtn) {
    exportBtn.textContent = "Export Complete";
    setTimeout(function () {
      exportBtn.textContent = "Export Thread (.md)";
      exportBtn.disabled = false;
    }, 2000);
  }
}

// Re-parses a flattened transcript string ("User: ...\n\nAssistant: ...")
// back into a [{role, content}] array for generateMarkdown.
function parseTranscriptToMessages(transcript) {
  var result = [];
  // Split on lines that start with "User: " or "Assistant: "
  var parts = transcript.split(/\n\n(?=(?:User|Assistant): )/);
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;

    var role, content;
    if (part.indexOf("User: ") === 0) {
      role = "user";
      content = part.substring(6);
    } else if (part.indexOf("Assistant: ") === 0) {
      role = "assistant";
      content = part.substring(11);
    } else {
      // No label — treat as continuation of previous or assistant
      if (result.length > 0) {
        result[result.length - 1].content += "\n\n" + part;
        continue;
      }
      role = "assistant";
      content = part;
    }
    result.push({ role: role, content: content });
  }
  return result;
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
  var tabVault = document.createElement("button");
  tabVault.classList.add("dm-widget", "dm-tab");
  tabVault.dataset.tab = "vault";
  tabVault.textContent = "Vault";
  tabVault.addEventListener("click", function () { dmSwitchTab("vault"); });

  tabBar.appendChild(tabReplay);
  tabBar.appendChild(tabVault);
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

  // Vault panel
  var vaultPanel = document.createElement("div");
  vaultPanel.classList.add("dm-widget", "dm-vault", "dm-vault--hidden");

  var vaultTextarea = document.createElement("textarea");
  vaultTextarea.id = "dm-vault-textarea";
  vaultTextarea.classList.add("dm-widget", "dm-vault-textarea");
  vaultTextarea.placeholder = "Enter global instructions (e.g., 'Always use TypeScript', 'No boilerplate code')...";
  vaultTextarea.spellcheck = false;

  var vaultSave = document.createElement("button");
  vaultSave.id = "dm-vault-save";
  vaultSave.classList.add("dm-widget", "dm-vault-save");
  vaultSave.textContent = "Save Preferences";
  vaultSave.addEventListener("click", dmSaveVault);

  vaultPanel.appendChild(vaultTextarea);
  vaultPanel.appendChild(vaultSave);
  popover.appendChild(vaultPanel);

  // Export footer
  var footer = document.createElement("div");
  footer.classList.add("dm-widget", "dm-popover-footer");

  var exportBtn = document.createElement("button");
  exportBtn.id = "dm-export-btn";
  exportBtn.classList.add("dm-widget", "dm-export-btn");
  exportBtn.textContent = "Export Thread (.md)";
  exportBtn.addEventListener("click", handleExportThread);

  footer.appendChild(exportBtn);
  popover.appendChild(footer);

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
