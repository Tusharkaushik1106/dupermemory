// utils/replay-prompt.js — Replay Prompt Generator
//
// Loaded into the service worker via importScripts("utils/replay-prompt.js").
// Must not use ES module syntax (no import/export).
// Must not reference the DOM or any browser APIs.
//
// Takes a raw transcript string (User: / Assistant: formatted) and wraps it
// in a meta-prompt that asks the target AI to critically evaluate and replay
// the conversation.

function buildReplayPrompt(rawTranscript) {
  return (
    "I am transferring a conversation I just had with another AI assistant. " +
    "I want your perspective and a second opinion.\n" +
    "\n" +
    "Please review the transcript below. I do not want just a summary. Instead, please:\n" +
    "\n" +
    "1. Identify the core problem or primary question I was trying to solve.\n" +
    "2. Critically evaluate the previous AI's final solution or approach.\n" +
    "3. Provide YOUR own direct response to my original queries. " +
    "Explicitly point out where you agree, disagree, or can improve upon the previous AI's logic.\n" +
    "\n" +
    "--- TRANSCRIPT START ---\n" +
    rawTranscript + "\n" +
    "--- TRANSCRIPT END ---"
  );
}
