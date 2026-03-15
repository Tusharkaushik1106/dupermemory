// background.js — Service Worker
//
// Message protocol (any-source, any-target):
//
//   {source}.js → background:     { type: "CAPTURE", transcript: "...", targetModel: "claude"|..., sourceModel: "chatgpt"|..., conversationId: "..." }
//   {source}.js → background:     { type: "GET_MODELS", sourceModel: "chatgpt"|... }  → sendResponse with filtered model list
//   {target}.js → background:     { type: "{MODEL}_READY" }    (e.g. CLAUDE_READY, CHATGPT_READY, ...)
//   background → {target}.js:     { type: "INJECT", contextBlock: "..." }   ← sendResponse
//   {target}.js → background:     { type: "{MODEL}_RESPONSE",  content: "..." }
//   background → {source}.js:     { type: "INJECT_CRITIQUE",   content: "..." }        ← tabs.sendMessage
//
// State lifecycle:
//
//   pendingContext[targetTabId] = { contextBlock, sourceTabId, conversationId }
//     Set:     when handleCapture opens the target AI tab
//     Cleared: when {MODEL}_READY is received (context delivered)
//
//   pendingReview[targetTabId] = { sourceTabId, conversationId }
//     Set:     when {MODEL}_READY is received
//     Cleared: when {MODEL}_RESPONSE is received (critique sent back)

importScripts("utils/models.js");
importScripts("utils/format.js");
importScripts("utils/memory.js");
importScripts("utils/summarize-generic.js");
importScripts("utils/replay-prompt.js");

var pendingContext = {}; // targetTabId → { contextBlock, sourceTabId, conversationId }
var pendingReview  = {}; // targetTabId → { sourceTabId, conversationId }

// ─── Status updates to source tab ──────────────────────────────────────────

function sendStatusUpdate(sourceTabId, status, detail) {
  chrome.tabs.sendMessage(sourceTabId, {
    type:   "STATUS_UPDATE",
    status: status,
    detail: detail || "",
  }, function () {
    if (chrome.runtime.lastError) { /* source tab may be closed */ }
  });
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  var senderTabId = sender.tab && sender.tab.id;

  // ── GET_MODELS — any content script requests the model list for its dropdown ──
  if (message.type === "GET_MODELS") {
    sendResponse({ models: getModelList(message.sourceModel || null) });
    return false;
  }

  // ── CAPTURE — any source content script sends a transcript with a target model ──
  if (message.type === "CAPTURE") {
    handleCapture(message.transcript, message.targetModel, message.conversationId, senderTabId);
    return false;
  }

  // ── REPLAY_CONVERSATION — raw transcript replay flow ────────────────────
  if (message.type === "REPLAY_CONVERSATION") {
    handleReplay(message.transcript, message.targetModel, message.conversationId, senderTabId);
    return false;
  }

  // ── {MODEL}_READY — target content script signals it's loaded ───────────
  var readyModel = getModelByMessageType(message.type);
  if (readyModel && message.type === readyModel.readyType) {
    if (senderTabId && pendingContext[senderTabId]) {
      var pending = pendingContext[senderTabId];
      delete pendingContext[senderTabId];

      pendingReview[senderTabId] = {
        sourceTabId:    pending.sourceTabId,
        conversationId: pending.conversationId,
      };

      sendResponse({ type: "INJECT", contextBlock: pending.contextBlock, conversationId: pending.conversationId });
      sendStatusUpdate(pending.sourceTabId, "waiting");
    } else {
      sendResponse(null); // Regular visit, no pending context.
    }
    return false;
  }

  // ── {MODEL}_RESPONSE — target content script sends its response ─────────
  var respModel = getModelByMessageType(message.type);
  if (respModel && message.type === respModel.responseType) {
    if (senderTabId && pendingReview[senderTabId]) {
      var review = pendingReview[senderTabId];
      delete pendingReview[senderTabId];

      // Parse the target's response: split conversational reply from memory update.
      var parsed = parseTargetResponse(message.content);

      // If the target AI included a memory update, merge it into central memory.
      if (parsed.memoryUpdate && review.conversationId) {
        readMemory(review.conversationId).then(function (memory) {
          var merged = mergeMemory(memory, parsed.memoryUpdate);
          return writeMemory(merged);
        }).catch(function (err) {
          console.warn("[DuperMemory] Failed to merge target memory update:", err);
        });
      }

      // Send only the conversational reply back to the source tab.
      sendCritiqueToTab(review.sourceTabId, parsed.reply, respModel.name);
      sendStatusUpdate(review.sourceTabId, "done");
    }
    return false;
  }
});

// ─── Capture transcript + read memory + open target ──────────────────────────

function handleCapture(transcript, targetModelKey, conversationId, sourceTabId) {
  if (!transcript || typeof transcript !== "string") {
    console.error("[DuperMemory] handleCapture: invalid transcript", transcript);
    return;
  }
  if (!sourceTabId) {
    console.error("[DuperMemory] handleCapture: could not identify source tab");
    return;
  }

  // Resolve the target model from the registry.
  var model = MODEL_REGISTRY[targetModelKey];
  if (!model) {
    console.error("[DuperMemory] handleCapture: unknown target model", targetModelKey);
    return;
  }

  // Use a stable conversation ID. If the source didn't provide one, generate one.
  var convId = conversationId || ("conv_" + Date.now());

  // Read existing memory (may be populated from previous hops).
  // Do NOT merge on capture — there is no structured summary to merge.
  // Memory gets populated from the target's ---MEMORY--- response instead.
  readMemory(convId).then(function (memory) {
    var contextBlock = formatContextBlockFromTranscript(memory, transcript);

    chrome.tabs.create({ url: model.url }, function (tab) {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] Failed to open " + model.name + " tab:", chrome.runtime.lastError.message);
        sendStatusUpdate(sourceTabId, "idle");
        return;
      }
      pendingContext[tab.id] = {
        contextBlock:   contextBlock,
        sourceTabId:    sourceTabId,
        conversationId: convId,
      };
      sendStatusUpdate(sourceTabId, "opening", model.name);
    });
  }).catch(function (err) {
    console.error("[DuperMemory] handleCapture memory read failed:", err);

    // Fallback: format context without any memory.
    var contextBlock = formatContextBlockFromTranscript(createEmptyMemory(convId), transcript);

    chrome.tabs.create({ url: model.url }, function (tab) {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] Failed to open " + model.name + " tab:", chrome.runtime.lastError.message);
        sendStatusUpdate(sourceTabId, "idle");
        return;
      }
      pendingContext[tab.id] = {
        contextBlock:   contextBlock,
        sourceTabId:    sourceTabId,
        conversationId: convId,
      };
      sendStatusUpdate(sourceTabId, "opening", model.name);
    });
  });
}

// ─── Replay: wrap transcript in meta-prompt + open target ───────────────────

function handleReplay(transcript, targetModelKey, conversationId, sourceTabId) {
  if (!transcript || typeof transcript !== "string") {
    console.error("[DuperMemory] handleReplay: invalid transcript");
    return;
  }
  if (!sourceTabId) {
    console.error("[DuperMemory] handleReplay: could not identify source tab");
    return;
  }

  var model = MODEL_REGISTRY[targetModelKey];
  if (!model) {
    console.error("[DuperMemory] handleReplay: unknown target model", targetModelKey);
    return;
  }

  var convId = conversationId || ("conv_" + Date.now());
  var replayPrompt = buildReplayPrompt(transcript);

  chrome.tabs.create({ url: model.url }, function (tab) {
    if (chrome.runtime.lastError) {
      console.error("[DuperMemory] Failed to open " + model.name + " tab:", chrome.runtime.lastError.message);
      sendStatusUpdate(sourceTabId, "idle");
      return;
    }
    pendingContext[tab.id] = {
      contextBlock:   replayPrompt,
      sourceTabId:    sourceTabId,
      conversationId: convId,
    };
    sendStatusUpdate(sourceTabId, "opening", model.name);
  });
}

// ─── Keyboard shortcut ──────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(function (command) {
  if (command === "toggle-dropdown") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_DROPDOWN" }, function () {
          if (chrome.runtime.lastError) { /* not a supported site */ }
        });
      }
    });
  }
});

// ─── Right-click context menu ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function () {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: "dupermemory-send",
      title: "Send selection to\u2026",
      contexts: ["selection"],
      documentUrlPatterns: [
        "https://chatgpt.com/*",
        "https://claude.ai/*",
        "https://gemini.google.com/*",
        "https://www.perplexity.ai/*",
        "https://chat.deepseek.com/*",
      ],
    });
    for (var key in MODEL_REGISTRY) {
      chrome.contextMenus.create({
        id: "dupermemory-send-" + key,
        parentId: "dupermemory-send",
        title: MODEL_REGISTRY[key].name,
        contexts: ["selection"],
      });
    }
  });
});

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  if (!info.menuItemId || info.menuItemId.indexOf("dupermemory-send-") !== 0) return;
  if (!info.selectionText) return;

  var targetModelKey = info.menuItemId.replace("dupermemory-send-", "");
  var sourceModel = getSourceModelFromUrl(tab.url);
  if (sourceModel === targetModelKey) return;

  handleCapture(info.selectionText, targetModelKey, null, tab.id);
});

function getSourceModelFromUrl(url) {
  if (!url) return null;
  if (url.indexOf("chatgpt.com") !== -1) return "chatgpt";
  if (url.indexOf("claude.ai") !== -1) return "claude";
  if (url.indexOf("gemini.google.com") !== -1) return "gemini";
  if (url.indexOf("perplexity.ai") !== -1) return "perplexity";
  if (url.indexOf("chat.deepseek.com") !== -1) return "deepseek";
  return null;
}

// ─── Relay target's response back to the source tab ───────────────────────────

function sendCritiqueToTab(tabId, response, modelName) {
  var content =
    modelName + " reviewed your answer. Revise your response considering this critique:\n\n" +
    response;

  chrome.tabs.sendMessage(tabId, { type: "INJECT_CRITIQUE", content: content }, function () {
    if (chrome.runtime.lastError) {
      console.warn(
        "[DuperMemory] Could not deliver critique to source tab " + tabId + ": ",
        chrome.runtime.lastError.message
      );
    }
  });
}
