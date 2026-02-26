// background.js — Service Worker
//
// Message protocol (any-source, any-target):
//
//   {source}.js → background:     { type: "CAPTURE", summary: {...}, targetModel: "claude"|..., sourceModel: "chatgpt"|..., conversationId: "..." }
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

var pendingContext = {}; // targetTabId → { contextBlock, sourceTabId, conversationId }
var pendingReview  = {}; // targetTabId → { sourceTabId, conversationId }

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  var senderTabId = sender.tab && sender.tab.id;

  // ── GET_MODELS — any content script requests the model list for its dropdown ──
  if (message.type === "GET_MODELS") {
    sendResponse({ models: getModelList(message.sourceModel || null) });
    return false;
  }

  // ── CAPTURE — any source content script sends a summary with a target model ──
  if (message.type === "CAPTURE") {
    handleCapture(message.summary, message.targetModel, message.conversationId, senderTabId);
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
    }
    return false;
  }
});

// ─── Capture + merge memory + open target ─────────────────────────────────────

function handleCapture(summary, targetModelKey, conversationId, sourceTabId) {
  if (!summary || typeof summary !== "object") {
    console.error("[DuperMemory] handleCapture: invalid summary", summary);
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

  // Read existing memory → merge summary → write back → format context → open tab.
  readMemory(convId).then(function (memory) {
    var merged = mergeMemory(memory, summary);

    return writeMemory(merged).then(function () {
      return merged;
    });
  }).then(function (merged) {
    var contextBlock = formatContextBlock(merged);

    chrome.tabs.create({ url: model.url }, function (tab) {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] Failed to open " + model.name + " tab:", chrome.runtime.lastError.message);
        return;
      }
      pendingContext[tab.id] = {
        contextBlock:   contextBlock,
        sourceTabId:    sourceTabId,
        conversationId: convId,
      };
    });
  }).catch(function (err) {
    console.error("[DuperMemory] handleCapture memory flow failed:", err);

    // Fallback: format directly from summary without memory persistence.
    var fallbackMemory = summaryToMemoryShape(summary);
    var contextBlock = formatContextBlock(fallbackMemory);

    chrome.tabs.create({ url: model.url }, function (tab) {
      if (chrome.runtime.lastError) {
        console.error("[DuperMemory] Failed to open " + model.name + " tab:", chrome.runtime.lastError.message);
        return;
      }
      pendingContext[tab.id] = {
        contextBlock:   contextBlock,
        sourceTabId:    sourceTabId,
        conversationId: convId,
      };
    });
  });
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
