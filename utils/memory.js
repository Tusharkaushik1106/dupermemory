// utils/memory.js — Central Memory Manager
//
// Loaded into the service worker via importScripts("utils/memory.js").
// Must not use ES module syntax (no import/export).
// Must not reference the DOM or any browser APIs except chrome.storage.local.
//
// Provides read, write, merge, and eviction for the central conversation memory.
// One memory object per conversation, keyed by conversation ID.

// ─── Size limits ──────────────────────────────────────────────────────────────

var MEMORY_LIMITS = {
  maxEntities:      30,
  maxDecisions:     20,
  maxOpenQuestions: 10,
  maxConstraints:   15,
};

// ─── Empty memory template ────────────────────────────────────────────────────

function createEmptyMemory(conversationId) {
  var now = new Date().toISOString();
  return {
    version:          1,
    conversation_id:  conversationId,
    created_at:       now,
    updated_at:       now,
    topic:            "",
    user_goal:        "",
    entities:         [],
    decisions:        [],
    open_questions:   [],
    constraints:      [],
    current_task:     "",
    iteration_count:  0,
  };
}

// ─── Storage key ──────────────────────────────────────────────────────────────

function memoryKey(conversationId) {
  return "dupermemory_" + conversationId;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

// Returns a Promise that resolves to the memory object, or a fresh empty one.
function readMemory(conversationId) {
  var key = memoryKey(conversationId);
  return new Promise(function (resolve) {
    chrome.storage.local.get(key, function (result) {
      if (chrome.runtime.lastError) {
        console.warn("[DuperMemory] storage.local.get failed:", chrome.runtime.lastError.message);
        resolve(createEmptyMemory(conversationId));
        return;
      }
      resolve(result[key] || createEmptyMemory(conversationId));
    });
  });
}

// ─── Write ────────────────────────────────────────────────────────────────────

// Returns a Promise that resolves when the write completes.
function writeMemory(memory) {
  var key = memoryKey(memory.conversation_id);
  var data = {};
  data[key] = memory;
  return new Promise(function (resolve) {
    chrome.storage.local.set(data, function () {
      if (chrome.runtime.lastError) {
        console.warn("[DuperMemory] storage.local.set failed:", chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

// ─── Merge summary into memory ───────────────────────────────────────────────
//
// Takes the existing memory and a new summary object from ChatGPT's
// self-summarization (which now includes entities). Merges non-destructively.
//
// summary shape (from extended SUMMARY_PROMPT):
//   {
//     topic, user_goal, current_task,
//     important_facts: [...],
//     decisions_made: [...],
//     open_questions: [...],       ← new
//     constraints: [...],          ← new
//     entities: [                  ← new
//       { name, type, summary }
//     ]
//   }

function mergeMemory(memory, summary) {
  var now = new Date().toISOString();

  // Overwrite scalar fields with latest values.
  memory.topic        = summary.topic        || memory.topic;
  memory.user_goal    = summary.user_goal    || memory.user_goal;
  memory.current_task = summary.current_task || memory.current_task;
  memory.updated_at   = now;
  memory.iteration_count++;

  // ── Entities ──────────────────────────────────────────────────────────────
  if (Array.isArray(summary.entities)) {
    for (var i = 0; i < summary.entities.length; i++) {
      var incoming = summary.entities[i];
      if (!incoming || !incoming.name) continue;

      var nameLower = incoming.name.toLowerCase().trim();
      var found = false;

      for (var j = 0; j < memory.entities.length; j++) {
        if (memory.entities[j].name.toLowerCase().trim() === nameLower) {
          // Existing entity — update.
          memory.entities[j].mentions++;
          memory.entities[j].last_updated = now;
          if (incoming.summary) memory.entities[j].summary = incoming.summary;
          if (incoming.type)    memory.entities[j].type    = incoming.type;
          found = true;
          break;
        }
      }

      if (!found) {
        memory.entities.push({
          name:         incoming.name.trim(),
          type:         incoming.type || "other",
          summary:      incoming.summary || "",
          mentions:     1,
          last_updated: now,
        });
      }
    }
  }

  // ── Decisions ─────────────────────────────────────────────────────────────
  if (Array.isArray(summary.decisions_made)) {
    for (var d = 0; d < summary.decisions_made.length; d++) {
      var dec = String(summary.decisions_made[d]).trim();
      if (!dec) continue;
      if (!isDuplicate(memory.decisions, dec)) {
        memory.decisions.push({ text: dec, added_at: now });
      }
    }
  }

  // ── Open questions ────────────────────────────────────────────────────────
  if (Array.isArray(summary.open_questions)) {
    for (var q = 0; q < summary.open_questions.length; q++) {
      var question = String(summary.open_questions[q]).trim();
      if (!question) continue;
      if (!isDuplicate(memory.open_questions, question)) {
        memory.open_questions.push({ text: question, added_at: now });
      }
    }
  }

  // ── Constraints ───────────────────────────────────────────────────────────
  if (Array.isArray(summary.constraints)) {
    for (var c = 0; c < summary.constraints.length; c++) {
      var constraint = String(summary.constraints[c]).trim();
      if (!constraint) continue;
      if (memory.constraints.indexOf(constraint) === -1) {
        memory.constraints.push(constraint);
      }
    }
  }

  // ── Eviction ──────────────────────────────────────────────────────────────
  evict(memory);

  return memory;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────
//
// Simple substring check: if the new string is a substring of an existing entry
// or vice versa, treat it as a duplicate. Not perfect, but avoids accumulating
// near-identical entries without requiring an LLM call.

function isDuplicate(existingArray, newText) {
  var lower = newText.toLowerCase();
  for (var i = 0; i < existingArray.length; i++) {
    var existing = (existingArray[i].text || existingArray[i]).toLowerCase();
    if (existing === lower) return true;
    if (existing.indexOf(lower) !== -1 || lower.indexOf(existing) !== -1) return true;
  }
  return false;
}

// ─── Eviction ─────────────────────────────────────────────────────────────────
//
// When a category exceeds its limit, drop the oldest items first.
// Entities: sort by mentions ascending, then by last_updated ascending → drop lowest.
// Decisions/questions: drop from the front (oldest first).

function evict(memory) {
  // Entities: keep most-mentioned, most-recent.
  if (memory.entities.length > MEMORY_LIMITS.maxEntities) {
    memory.entities.sort(function (a, b) {
      if (a.mentions !== b.mentions) return b.mentions - a.mentions;
      return (a.last_updated || "").localeCompare(b.last_updated || "");
    });
    memory.entities = memory.entities.slice(0, MEMORY_LIMITS.maxEntities);
  }

  // Decisions: drop oldest.
  if (memory.decisions.length > MEMORY_LIMITS.maxDecisions) {
    memory.decisions = memory.decisions.slice(
      memory.decisions.length - MEMORY_LIMITS.maxDecisions
    );
  }

  // Open questions: drop oldest.
  if (memory.open_questions.length > MEMORY_LIMITS.maxOpenQuestions) {
    memory.open_questions = memory.open_questions.slice(
      memory.open_questions.length - MEMORY_LIMITS.maxOpenQuestions
    );
  }

  // Constraints: drop oldest.
  if (memory.constraints.length > MEMORY_LIMITS.maxConstraints) {
    memory.constraints = memory.constraints.slice(
      memory.constraints.length - MEMORY_LIMITS.maxConstraints
    );
  }
}
