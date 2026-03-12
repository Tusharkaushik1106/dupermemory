// utils/summarize-generic.js — Shared parsing utilities
//
// Loaded as a content script on ALL supported AI sites via manifest.json.
// Also loaded into the service worker via importScripts.
// Must not use ES module syntax — functions are plain globals.
//
// Contains:
//   - parseSummary(): normalizes JSON responses into a consistent shape
//     (used as fallback by parseTargetResponse when target AI returns JSON)
//   - delay(): simple promise-based sleep
//   - parseTargetResponse(): splits target AI response into reply + memory update
//   - parseMemoryBlock(): parses labeled plain-text memory blocks

// ─── Parse summary ────────────────────────────────────────────────────────────

function parseSummary(rawText) {
  // AIs sometimes wrap JSON in markdown code fences even when told not to.
  // Strip the most common patterns before attempting JSON.parse.
  var cleaned = rawText
    .replace(/^```(?:json)?[\r\n]*/im, "")
    .replace(/[\r\n]*```\s*$/im, "")
    .trim();

  try {
    var obj = JSON.parse(cleaned);

    // Normalise: guarantee all expected fields exist with the right types,
    // regardless of what the AI actually returned.
    return {
      topic:           String(obj.topic           || ""),
      user_goal:       String(obj.user_goal       || ""),
      important_facts: Array.isArray(obj.important_facts) ? obj.important_facts.map(String) : [],
      decisions_made:  Array.isArray(obj.decisions_made)  ? obj.decisions_made.map(String)  : [],
      current_task:    String(obj.current_task     || ""),
      entities:        Array.isArray(obj.entities) ? obj.entities.filter(function (e) { return e && e.name; }) : [],
      open_questions:  Array.isArray(obj.open_questions) ? obj.open_questions.map(String) : [],
      constraints:     Array.isArray(obj.constraints) ? obj.constraints.map(String) : [],
    };
  } catch (e) {
    // JSON parsing failed. Degrade gracefully: keep the raw text so the user
    // doesn't lose information. The context block will still be sent to the
    // target, just without the structured fields.
    console.warn("[DuperMemory] Could not parse summary JSON. Raw text follows:", rawText);
    return {
      topic:           "",
      user_goal:       "",
      important_facts: [],
      decisions_made:  [],
      current_task:    rawText,
      entities:        [],
      open_questions:  [],
      constraints:     [],
    };
  }
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// ─── Parse target response ───────────────────────────────────────────────────
//
// Splits a target AI's full response into a conversational reply and an
// optional structured memory update.
//
// The target prompt (from formatContextBlockFromTranscript) asks the AI to append a
// memory note inside ---MEMORY--- ... ---END MEMORY--- markers after its
// natural reply. The memory note uses labeled plain-text lines, not JSON.
//
// Returns: { reply: string, memoryUpdate: object|null }
//
// If markers are missing, memoryUpdate is null (graceful degradation —
// memory simply doesn't update this turn).

var MEMORY_START_MARKER = "---MEMORY---";
var MEMORY_END_MARKER   = "---END MEMORY---";

function parseTargetResponse(fullText) {
  if (!fullText || typeof fullText !== "string") {
    return { reply: fullText || "", memoryUpdate: null };
  }

  var startIdx = fullText.indexOf(MEMORY_START_MARKER);
  var endIdx   = fullText.indexOf(MEMORY_END_MARKER);

  // No markers found — return full text as reply, no memory update.
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return { reply: fullText.trim(), memoryUpdate: null };
  }

  // Split: everything before the start marker is the reply.
  var reply    = fullText.slice(0, startIdx).trim();
  var blockStr = fullText.slice(startIdx + MEMORY_START_MARKER.length, endIdx).trim();

  // If the block somehow starts with '{', the AI returned JSON anyway.
  // Fall back to parseSummary() for fence-stripping + JSON parsing.
  if (blockStr.charAt(0) === "{") {
    var jsonParsed = parseSummary(blockStr);
    var hasData = jsonParsed.topic || jsonParsed.user_goal || jsonParsed.current_task ||
                  jsonParsed.entities.length > 0 || jsonParsed.decisions_made.length > 0;
    return { reply: reply, memoryUpdate: hasData ? jsonParsed : null };
  }

  // Parse the labeled plain-text block.
  var memoryUpdate = parseMemoryBlock(blockStr);
  return { reply: reply, memoryUpdate: memoryUpdate };
}

// ─── Parse labeled memory block ──────────────────────────────────────────────
//
// Parses a plain-text block with lines like:
//   Topic: Building a Chrome extension
//   Goal: Share context across AI platforms
//   Facts: fact one; fact two; fact three
//   Decisions: decision one; decision two
//   Task: Implement the parser
//   Entities: DuperMemory/tool/Chrome extension for cross-AI memory; chrome.storage.local/technology/KV store
//   Open: question one; question two
//   Constraints: no backend; no API keys
//
// Returns an object matching the summary schema that mergeMemory() expects,
// or null if no meaningful data was extracted.

function parseMemoryBlock(blockStr) {
  var lines = blockStr.split("\n");
  var fields = {};

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // Strip leading bullet/dash if model added one.
    line = line.replace(/^[-*]\s*/, "");

    // Split on the first colon only.
    var colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    var key   = line.slice(0, colonIdx).trim().toLowerCase();
    var value = line.slice(colonIdx + 1).trim();
    if (!value) continue;

    fields[key] = value;
  }

  // Map field keys to the summary schema.
  var topic       = fields["topic"]       || "";
  var userGoal    = fields["goal"]        || fields["user goal"]    || fields["user_goal"] || "";
  var currentTask = fields["task"]        || fields["current task"] || fields["current_task"] || "";
  var factsRaw    = fields["facts"]       || fields["important facts"] || fields["important_facts"] || "";
  var decsRaw     = fields["decisions"]   || fields["decisions made"]  || fields["decisions_made"]  || "";
  var openRaw     = fields["open"]        || fields["open questions"]  || fields["open_questions"]  || "";
  var consRaw     = fields["constraints"] || "";
  var entsRaw     = fields["entities"]    || "";

  // Split semicolon-separated lists, filter empties.
  var facts       = splitSemicolons(factsRaw);
  var decisions   = splitSemicolons(decsRaw);
  var openQs      = splitSemicolons(openRaw);
  var constraints = splitSemicolons(consRaw);

  // Parse entities: each entry is name/type/summary.
  var entities = [];
  var entParts = splitSemicolons(entsRaw);
  for (var e = 0; e < entParts.length; e++) {
    var parsed = parseEntityEntry(entParts[e]);
    if (parsed) entities.push(parsed);
  }

  // Check if we got any meaningful data.
  if (!topic && !userGoal && !currentTask &&
      facts.length === 0 && decisions.length === 0 && entities.length === 0) {
    return null;
  }

  return {
    topic:           topic,
    user_goal:       userGoal,
    important_facts: facts,
    decisions_made:  decisions,
    current_task:    currentTask,
    entities:        entities,
    open_questions:  openQs,
    constraints:     constraints,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function splitSemicolons(str) {
  if (!str) return [];
  return str.split(";")
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length > 0; });
}

function parseEntityEntry(entry) {
  // Expected format: name/type/summary
  // Split on the first two slashes only — the summary may contain slashes.
  var first = entry.indexOf("/");
  if (first === -1) {
    // No slashes — treat entire string as entity name.
    return entry.trim() ? { name: entry.trim(), type: "other", summary: "" } : null;
  }

  var name = entry.slice(0, first).trim();
  var rest = entry.slice(first + 1);

  var second = rest.indexOf("/");
  if (second === -1) {
    // One slash — name/type, no summary.
    return name ? { name: name, type: rest.trim() || "other", summary: "" } : null;
  }

  var type    = rest.slice(0, second).trim() || "other";
  var summary = rest.slice(second + 1).trim();

  return name ? { name: name, type: type, summary: summary } : null;
}
