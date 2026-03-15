// utils/export-engine.js — Markdown export for DuperMemory
//
// Loaded as a content script on all supported AI sites via manifest.json.
// Must not use ES module syntax. Zero dependencies.
//
// Provides:
//   generateMarkdown(messages) — formats [{role, content}] as clean Markdown
//   downloadMarkdownFile(markdownString, topicName) — triggers .md download

// ═══════════════════════════════════════════════════════════════════════════════
// MARKDOWN GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

// Takes a standard [{role: "user"|"assistant", content: "..."}] array
// (already flattened by flattenInjectedContext) and produces a clean
// Markdown document.
//
// Layout:
//   - YAML-style header with export metadata
//   - User messages rendered as blockquotes (>)
//   - Assistant messages rendered as standard text
//   - Horizontal rules between turns for readability

function generateMarkdown(messages) {
  var now = new Date();
  var dateStr = now.getFullYear() + "-" +
    padTwo(now.getMonth() + 1) + "-" +
    padTwo(now.getDate());
  var timeStr = padTwo(now.getHours()) + ":" +
    padTwo(now.getMinutes()) + ":" +
    padTwo(now.getSeconds());

  var sourceLabel = (typeof DUPERMEM_SOURCE_MODEL === "string")
    ? DUPERMEM_SOURCE_MODEL.charAt(0).toUpperCase() + DUPERMEM_SOURCE_MODEL.slice(1)
    : "Unknown";

  var lines = [];

  // ── Header ──
  lines.push("# DuperMemory Export");
  lines.push("");
  lines.push("- **Date:** " + dateStr + " " + timeStr);
  lines.push("- **Source:** " + sourceLabel);
  lines.push("- **Messages:** " + messages.length);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Messages ──
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var isUser = msg.role === "user";

    // Role heading
    lines.push("## " + (isUser ? "User" : "Assistant"));
    lines.push("");

    if (isUser) {
      // Blockquote user messages — prefix EVERY line with > so
      // multi-line messages don't break the blockquote syntax.
      var userLines = msg.content.split("\n");
      for (var u = 0; u < userLines.length; u++) {
        // Empty lines within the blockquote need a bare ">" to
        // keep the block contiguous in Markdown parsers.
        if (userLines[u].trim() === "") {
          lines.push(">");
        } else {
          lines.push("> " + userLines[u]);
        }
      }
    } else {
      // Assistant messages: pass through as-is (they may contain
      // code fences, lists, etc. that are already valid Markdown)
      lines.push(msg.content);
    }

    // Strict double newline between message blocks so Markdown
    // parsers recognise them as separate paragraphs.
    lines.push("");
    lines.push("");

    // Separator between turns (not after the last message)
    if (i < messages.length - 1) {
      lines.push("---");
      lines.push("");
    }
  }

  return lines.join("\n");
}

function padTwo(n) {
  return n < 10 ? "0" + n : String(n);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOB DOWNLOAD
// ═══════════════════════════════════════════════════════════════════════════════

// Creates a Blob from the Markdown string and triggers a browser download.
// topicName is optional — used to build a human-readable filename.

function downloadMarkdownFile(markdownString, topicName) {
  var blob = new Blob([markdownString], { type: "text/markdown;charset=utf-8" });
  var url = URL.createObjectURL(blob);

  var now = new Date();
  var dateSlug = now.getFullYear() + "-" +
    padTwo(now.getMonth() + 1) + "-" +
    padTwo(now.getDate());

  var filename;
  if (topicName && topicName.length > 0) {
    // Sanitize: keep alphanumeric, spaces, hyphens, underscores
    var safe = topicName
      .replace(/[^a-zA-Z0-9 _-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 60)
      .toLowerCase();
    filename = "dupermemory-" + safe + "-" + dateSlug + ".md";
  } else {
    filename = "dupermemory-export-" + dateSlug + ".md";
  }

  var anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();

  // Cleanup
  setTimeout(function () {
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, 100);
}
