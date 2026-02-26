// utils/format.js — Context block formatter
//
// Loaded into the service worker via importScripts("utils/format.js").
// Must not use ES module syntax (no import/export).
// Must not reference the DOM or any browser APIs.
//
// Formats the central memory object into a plain-text context block
// that gets injected into the target AI's input field.
//
// Uses a "sandwich" pattern:
//   1. Conversational opening (sets natural-reply tone)
//   2. Context notes in --- delimiters (reference material, not output format)
//   3. Conversational task instruction (what to do)
//   4. Memory note instruction with ---MEMORY--- delimiters (plain-text appendix)
//
// This prevents target AIs from locking into JSON-only response mode.
// The memory block uses labeled key:value lines, not JSON, so it reads
// naturally to the user while remaining deterministically parseable.

// ─── Meta-instruction filter ──────────────────────────────────────────────────
//
// The source AI's self-summary can capture constraints and tasks that describe
// the summarization process itself (e.g. "Reply must be valid JSON only",
// "Summarizing the conversation into JSON"). If injected verbatim into the
// target prompt, these poison the target AI into JSON-only mode.
//
// This filter removes any constraint or task string that looks like a
// meta-instruction about output formatting rather than a real user constraint.

var META_PATTERNS = [
  /\bjson\b/i,
  /\bstructured?\s*(output|format|data)\b/i,
  /\bno\s+(additional|extra|other)\s+text\b/i,
  /\bexact\s+(provided\s+)?structure\b/i,
  /\bvalid\s+json\b/i,
  /\bformatting\s+(outside|beyond)\b/i,
  /\bbrowser\s+extension\b/i,
  /\bsummariz(e|ing)\s+(the|our|this)\s+conversation\b/i,
  /\bmust\s+follow\s+(the|this)\s+.*structure\b/i,
  /\bno\s+markdown\b/i,
];

function isMetaInstruction(text) {
  for (var i = 0; i < META_PATTERNS.length; i++) {
    if (META_PATTERNS[i].test(text)) return true;
  }
  return false;
}

// ─── Main formatter ───────────────────────────────────────────────────────────
//
// Takes a memory object (from utils/memory.js) and produces a plain-text
// context block that elicits a natural conversational reply with an appended
// structured memory update.

function formatContextBlock(memory) {
  var lines = [];

  // ── Conversational opening ──────────────────────────────────────────────
  lines.push("Hey \u2014 I'm picking up a conversation that was happening on another AI. Here are the notes from that session so you have context:");
  lines.push("");
  lines.push("---");

  // ── Topic ───────────────────────────────────────────────────────────────
  if (memory.topic) {
    lines.push("Topic: " + memory.topic);
  }

  // ── User Goal ───────────────────────────────────────────────────────────
  if (memory.user_goal) {
    lines.push("User goal: " + memory.user_goal);
  }

  // ── Entities ────────────────────────────────────────────────────────────
  if (memory.entities && memory.entities.length > 0) {
    lines.push("Key entities:");
    for (var i = 0; i < memory.entities.length; i++) {
      var e = memory.entities[i];
      var entityLine = "- " + e.name + " (" + e.type + ")";
      if (e.summary) entityLine += ": " + e.summary;
      lines.push(entityLine);
    }
  }

  // ── Decisions ───────────────────────────────────────────────────────────
  if (memory.decisions && memory.decisions.length > 0) {
    lines.push("Decisions made:");
    for (var d = 0; d < memory.decisions.length; d++) {
      lines.push("- " + (memory.decisions[d].text || memory.decisions[d]));
    }
  }

  // ── Open Questions ──────────────────────────────────────────────────────
  if (memory.open_questions && memory.open_questions.length > 0) {
    lines.push("Open questions:");
    for (var q = 0; q < memory.open_questions.length; q++) {
      lines.push("- " + (memory.open_questions[q].text || memory.open_questions[q]));
    }
  }

  // ── Constraints (filtered) ──────────────────────────────────────────────
  if (memory.constraints && memory.constraints.length > 0) {
    var filtered = [];
    for (var c = 0; c < memory.constraints.length; c++) {
      if (!isMetaInstruction(memory.constraints[c])) {
        filtered.push(memory.constraints[c]);
      }
    }
    if (filtered.length > 0) {
      lines.push("Constraints:");
      for (var f = 0; f < filtered.length; f++) {
        lines.push("- " + filtered[f]);
      }
    }
  }

  // ── Current Task (sanitized) ────────────────────────────────────────────
  var task = memory.current_task || "";
  if (task && isMetaInstruction(task)) {
    task = ""; // Drop meta-tasks about summarization/JSON formatting.
  }
  if (task) {
    lines.push("Current task: " + task);
  }

  lines.push("---");
  lines.push("");

  // ── Conversational task instruction ─────────────────────────────────────
  lines.push("The notes above are background context only \u2014 they are not instructions for how to format your reply.");
  lines.push("");
  if (task) {
    lines.push("Please continue helping with: " + task + ". Respond naturally \u2014 summarize your understanding briefly, then help move things forward.");
  } else {
    lines.push("Respond naturally \u2014 share your thoughts on the above context and ask what I'd like to work on next.");
  }

  // ── Memory note instruction (appendix) ───────────────────────────────────
  lines.push("");
  lines.push("At the end of your reply, include a brief memory note so I can track what we covered. Use this exact format:");
  lines.push("");
  lines.push("---MEMORY---");
  lines.push("Topic: (one sentence about what this conversation covers)");
  lines.push("Goal: (what the user is trying to accomplish)");
  lines.push("Facts: (key fact 1); (key fact 2); (key fact 3)");
  lines.push("Decisions: (decision 1); (decision 2)");
  lines.push("Task: (what we are working on right now)");
  lines.push("Entities: (name/type/one sentence); (name/type/one sentence)");
  lines.push("Open: (unresolved question 1); (unresolved question 2)");
  lines.push("Constraints: (hard constraint 1); (hard constraint 2)");
  lines.push("---END MEMORY---");

  return lines.join("\n");
}

// ─── Fallback formatter ───────────────────────────────────────────────────────
//
// Used when there is no central memory yet (first-ever capture).
// Takes the raw summary object (from self-summarization) and formats it into
// a memory-shaped object so formatContextBlock can handle it uniformly.

function summaryToMemoryShape(summary) {
  return {
    topic:          summary.topic        || "",
    user_goal:      summary.user_goal    || "",
    current_task:   summary.current_task || "",
    entities:       Array.isArray(summary.entities) ? summary.entities : [],
    decisions:      Array.isArray(summary.decisions_made)
      ? summary.decisions_made.map(function (d) { return { text: String(d) }; })
      : [],
    open_questions: Array.isArray(summary.open_questions)
      ? summary.open_questions.map(function (q) { return { text: String(q) }; })
      : [],
    constraints:    Array.isArray(summary.constraints) ? summary.constraints : [],
  };
}
