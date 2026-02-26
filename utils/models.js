// utils/models.js — Model Registry
//
// Loaded into the service worker via importScripts("utils/models.js").
// Also loaded into content scripts via manifest.json for dropdown UI.
// Must not use ES module syntax (no import/export).
// Must not reference the DOM or any browser APIs.
//
// Maps model keys to their metadata. Used by background.js for routing
// and by all content scripts for the dropdown UI (via message passing).

var MODEL_REGISTRY = {
  chatgpt: {
    key: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com",
    readyType: "CHATGPT_READY",
    responseType: "CHATGPT_RESPONSE",
  },
  claude: {
    key: "claude",
    name: "Claude",
    url: "https://claude.ai",
    readyType: "CLAUDE_READY",
    responseType: "CLAUDE_RESPONSE",
  },
  gemini: {
    key: "gemini",
    name: "Gemini",
    url: "https://gemini.google.com/app",
    readyType: "GEMINI_READY",
    responseType: "GEMINI_RESPONSE",
  },
  perplexity: {
    key: "perplexity",
    name: "Perplexity",
    url: "https://www.perplexity.ai/",
    readyType: "PERPLEXITY_READY",
    responseType: "PERPLEXITY_RESPONSE",
  },
  deepseek: {
    key: "deepseek",
    name: "DeepSeek",
    url: "https://chat.deepseek.com/",
    readyType: "DEEPSEEK_READY",
    responseType: "DEEPSEEK_RESPONSE",
  },
};

// Returns the model config for a given READY or RESPONSE message type.
// Example: getModelByMessageType("GEMINI_READY") → MODEL_REGISTRY.gemini
function getModelByMessageType(type) {
  for (var key in MODEL_REGISTRY) {
    var m = MODEL_REGISTRY[key];
    if (m.readyType === type || m.responseType === type) return m;
  }
  return null;
}

// Returns an array of { key, name } for all registered models.
// If sourceModel is provided, excludes that model from the list
// (so the dropdown doesn't show the current site as a target).
function getModelList(sourceModel) {
  var list = [];
  for (var key in MODEL_REGISTRY) {
    if (sourceModel && key === sourceModel) continue;
    list.push({ key: key, name: MODEL_REGISTRY[key].name });
  }
  return list;
}
