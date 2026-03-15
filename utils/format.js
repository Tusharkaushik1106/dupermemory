// utils/format.js — Context block formatter
//
// Loaded into the service worker via importScripts("utils/format.js").
// Must not use ES module syntax (no import/export).
// Must not reference the DOM or any browser APIs.
//
// Formats a raw conversation transcript (+ optional memory from prior hops)
// into a plain-text context block for injection into the target AI's input.
//
// Layout:
//   1. Conversational opening
//   2. Memory notes from prior sessions (if any)
//   3. Raw transcript in --- delimiters
//   4. Task instruction
//   5. Memory note instruction with ---MEMORY--- delimiters
//
// The memory block uses labeled key:value lines, not JSON, so it reads
// naturally to the user while remaining deterministically parseable.

// ─── Meta-instruction filter ──────────────────────────────────────────────────
//
// Memory from prior hops may contain constraints about output formatting
// (e.g. "Reply must be valid JSON only"). This filter removes those
// meta-instructions before they reach the target prompt.

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

// ─── Transcript-based formatter ──────────────────────────────────────────────
//
// Takes a memory object (possibly empty) and a raw transcript string captured
// from the source AI's DOM. Produces a context block for injection into the
// target AI's input field.
//
// If memory has meaningful data from previous hops, include it as structured
// notes above the transcript. If memory is empty (first capture), include
// only the transcript.

function formatContextBlockFromTranscript(memory, transcript) {
  var lines = [];

  // ── Conversational opening ──────────────────────────────────────────────
  lines.push("Hey \u2014 I'm picking up a conversation that was happening on another AI. Here's the transcript from that session:");

  // ── Memory notes (if populated from previous hops) ──────────────────────
  var hasMemory = memory && (
    memory.topic ||
    memory.user_goal ||
    (memory.entities && memory.entities.length > 0) ||
    (memory.decisions && memory.decisions.length > 0)
  );

  if (hasMemory) {
    lines.push("");
    lines.push("--- notes from prior sessions ---");

    if (memory.topic) {
      lines.push("Topic: " + memory.topic);
    }
    if (memory.user_goal) {
      lines.push("User goal: " + memory.user_goal);
    }
    if (memory.entities && memory.entities.length > 0) {
      lines.push("Key entities:");
      for (var i = 0; i < memory.entities.length; i++) {
        var e = memory.entities[i];
        var entityLine = "- " + e.name + " (" + e.type + ")";
        if (e.summary) entityLine += ": " + e.summary;
        lines.push(entityLine);
      }
    }
    if (memory.decisions && memory.decisions.length > 0) {
      lines.push("Decisions made:");
      for (var d = 0; d < memory.decisions.length; d++) {
        lines.push("- " + (memory.decisions[d].text || memory.decisions[d]));
      }
    }
    if (memory.open_questions && memory.open_questions.length > 0) {
      lines.push("Open questions:");
      for (var q = 0; q < memory.open_questions.length; q++) {
        lines.push("- " + (memory.open_questions[q].text || memory.open_questions[q]));
      }
    }
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

    var memTask = memory.current_task || "";
    if (memTask && !isMetaInstruction(memTask)) {
      lines.push("Current task: " + memTask);
    }

    lines.push("--- end notes ---");
  }

  // ── Transcript ──────────────────────────────────────────────────────────
  lines.push("");
  lines.push("--- transcript ---");
  lines.push(sanitizeMetaPrompt(transcript));
  lines.push("--- end transcript ---");

  // ── Task instruction ────────────────────────────────────────────────────
  lines.push("");
  lines.push("The transcript above is the raw conversation from the other AI. Use it as context.");
  lines.push("");

  var currentTask = (memory && memory.current_task && !isMetaInstruction(memory.current_task))
    ? memory.current_task
    : "";

  if (currentTask) {
    lines.push("Please continue helping with: " + currentTask + ". Respond naturally \u2014 summarize your understanding briefly, then help move things forward.");
  } else {
    lines.push("Respond naturally \u2014 share your thoughts on the above conversation and ask what I'd like to work on next.");
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
