// utils/diff-engine.js — Code diff engine for DuperMemory
//
// Loaded as a content script on all supported AI sites via manifest.json.
// Must not use ES module syntax. Zero dependencies.
//
// Provides:
//   extractCodeBlocks(text) — pulls fenced code blocks from markdown text
//   computeLineDiff(oldCode, newCode) — line-level diff (LCS-based)
//   renderDiffHTML(diffArray) — produces scoped HTML for visual diff
//   buildCritiqueDiffUI(originalText, critiqueText) — end-to-end: extract,
//       match, diff, and render all code block pairs into a DOM fragment

// ═══════════════════════════════════════════════════════════════════════════════
// CODE BLOCK EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

// Extracts fenced code blocks from markdown-style text.
// Returns an array of { lang: string, code: string } objects.
// Handles ``` with optional language tag, and tolerates leading whitespace.

var DM_CODEBLOCK_RE = /^[ \t]*```(\w*)\s*\n([\s\S]*?)^[ \t]*```\s*$/gm;

function extractCodeBlocks(text) {
  if (!text || typeof text !== "string") return [];

  var blocks = [];
  var match;
  // Reset lastIndex to be safe
  DM_CODEBLOCK_RE.lastIndex = 0;

  while ((match = DM_CODEBLOCK_RE.exec(text)) !== null) {
    blocks.push({
      lang: (match[1] || "").toLowerCase(),
      code: match[2],
    });
  }
  return blocks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LINE DIFF (LCS-based)
// ═══════════════════════════════════════════════════════════════════════════════

// Computes a line-by-line diff between oldCode and newCode using the
// Longest Common Subsequence (LCS) algorithm. Returns an array of:
//   { type: "added" | "removed" | "unchanged", text: string }
//
// This is a simplified but correct O(n*m) approach suitable for typical
// code blocks (usually < 200 lines).

function computeLineDiff(oldCode, newCode) {
  var oldLines = (oldCode || "").split("\n");
  var newLines = (newCode || "").split("\n");
  var oldLen = oldLines.length;
  var newLen = newLines.length;

  // Build LCS table
  var lcs = [];
  var i, j;
  for (i = 0; i <= oldLen; i++) {
    lcs[i] = [];
    for (j = 0; j <= newLen; j++) {
      lcs[i][j] = 0;
    }
  }
  for (i = 1; i <= oldLen; i++) {
    for (j = 1; j <= newLen; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1;
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1]);
      }
    }
  }

  // Backtrack to produce diff
  var diff = [];
  i = oldLen;
  j = newLen;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.push({ type: "unchanged", text: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      diff.push({ type: "added", text: newLines[j - 1] });
      j--;
    } else {
      diff.push({ type: "removed", text: oldLines[i - 1] });
      i--;
    }
  }

  diff.reverse();
  return diff;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIFF HTML RENDERER
// ═══════════════════════════════════════════════════════════════════════════════

// Generates a self-contained HTML string for a diff, scoped under
// .dm-diff so it won't leak into the host site's styles.

function renderDiffHTML(diffArray, lang) {
  var langLabel = lang ? lang.toUpperCase() : "CODE";

  var html = [];
  html.push('<div class="dm-diff">');
  html.push('<div class="dm-diff-header">');
  html.push('<span class="dm-diff-badge">DIFF</span>');
  html.push('<span class="dm-diff-lang">' + escapeHTML(langLabel) + '</span>');
  html.push('</div>');
  html.push('<pre class="dm-diff-pre">');

  var oldLineNum = 0;
  var newLineNum = 0;

  for (var i = 0; i < diffArray.length; i++) {
    var entry = diffArray[i];
    var cls, prefix, lineNum;

    if (entry.type === "removed") {
      oldLineNum++;
      cls = "dm-diff-del";
      prefix = "-";
      lineNum = oldLineNum;
    } else if (entry.type === "added") {
      newLineNum++;
      cls = "dm-diff-ins";
      prefix = "+";
      lineNum = newLineNum;
    } else {
      oldLineNum++;
      newLineNum++;
      cls = "dm-diff-ctx";
      prefix = " ";
      lineNum = newLineNum;
    }

    var numStr = String(lineNum);
    while (numStr.length < 3) numStr = " " + numStr;

    html.push(
      '<div class="' + cls + '">' +
      '<span class="dm-diff-num">' + numStr + '</span>' +
      '<span class="dm-diff-pfx">' + prefix + '</span>' +
      '<span class="dm-diff-txt">' + escapeHTML(entry.text) + '</span>' +
      '</div>'
    );
  }

  html.push('</pre>');
  html.push('</div>');

  return html.join("");
}

function escapeHTML(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CSS (injected once)
// ═══════════════════════════════════════════════════════════════════════════════

(function injectDiffStyles() {
  if (document.getElementById("dm-diff-styles")) return;

  var css = [
    ".dm-diff {",
    "  margin: 12px 0;",
    "  border-radius: 10px;",
    "  border: 1px solid rgba(255,255,255,0.08);",
    "  background: rgba(18, 18, 26, 0.92);",
    "  backdrop-filter: blur(12px);",
    "  -webkit-backdrop-filter: blur(12px);",
    "  overflow: hidden;",
    "  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;",
    "  font-size: 12px;",
    "  line-height: 1.5;",
    "  color: #d4d4d8;",
    "}",
    ".dm-diff-header {",
    "  display: flex;",
    "  align-items: center;",
    "  gap: 8px;",
    "  padding: 8px 12px;",
    "  background: rgba(255,255,255,0.03);",
    "  border-bottom: 1px solid rgba(255,255,255,0.06);",
    "}",
    ".dm-diff-badge {",
    "  display: inline-block;",
    "  padding: 2px 6px;",
    "  border-radius: 4px;",
    "  background: rgba(139, 92, 246, 0.2);",
    "  color: #a78bfa;",
    "  font-size: 9px;",
    "  font-weight: 700;",
    "  letter-spacing: 0.06em;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
    "}",
    ".dm-diff-lang {",
    "  color: #71717a;",
    "  font-size: 10px;",
    "  font-weight: 600;",
    "  letter-spacing: 0.04em;",
    "  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;",
    "}",
    ".dm-diff-pre {",
    "  margin: 0;",
    "  padding: 8px 0;",
    "  overflow-x: auto;",
    "}",
    ".dm-diff-pre > div {",
    "  display: flex;",
    "  padding: 0 12px;",
    "  min-height: 20px;",
    "}",
    ".dm-diff-num {",
    "  color: #52525b;",
    "  user-select: none;",
    "  width: 32px;",
    "  flex-shrink: 0;",
    "  text-align: right;",
    "  padding-right: 8px;",
    "}",
    ".dm-diff-pfx {",
    "  width: 14px;",
    "  flex-shrink: 0;",
    "  font-weight: 700;",
    "}",
    ".dm-diff-txt {",
    "  white-space: pre;",
    "  flex: 1;",
    "}",
    // Added lines
    ".dm-diff-ins {",
    "  background: rgba(34, 197, 94, 0.08);",
    "  border-left: 3px solid rgba(34, 197, 94, 0.4);",
    "}",
    ".dm-diff-ins .dm-diff-pfx { color: #4ade80; }",
    ".dm-diff-ins .dm-diff-txt { color: #bbf7d0; }",
    // Removed lines
    ".dm-diff-del {",
    "  background: rgba(239, 68, 68, 0.08);",
    "  border-left: 3px solid rgba(239, 68, 68, 0.4);",
    "}",
    ".dm-diff-del .dm-diff-pfx { color: #f87171; }",
    ".dm-diff-del .dm-diff-txt { color: #fecaca; text-decoration: line-through; text-decoration-color: rgba(239,68,68,0.3); }",
    // Context (unchanged) lines
    ".dm-diff-ctx {",
    "  border-left: 3px solid transparent;",
    "}",
    ".dm-diff-ctx .dm-diff-pfx { color: transparent; }",
  ].join("\n");

  var style = document.createElement("style");
  style.id = "dm-diff-styles";
  style.textContent = css;
  document.head.appendChild(style);
})();

// ═══════════════════════════════════════════════════════════════════════════════
// END-TO-END: extract, match, diff, render
// ═══════════════════════════════════════════════════════════════════════════════

// Given the original conversation text (from the DOM before the critique) and
// the critique response text, finds matching code block pairs by language,
// diffs them, and returns a DOM DocumentFragment with all diff panels.
//
// Returns null if no diffable code pairs were found.

function buildCritiqueDiffUI(originalText, critiqueText) {
  var originalBlocks = extractCodeBlocks(originalText);
  var critiqueBlocks = extractCodeBlocks(critiqueText);

  if (originalBlocks.length === 0 || critiqueBlocks.length === 0) {
    return null;
  }

  // Match blocks by language. For each critique block, find the best
  // original block of the same language. If language is empty, match
  // by position (first unlabeled original with first unlabeled critique).
  var usedOriginals = {};
  var pairs = [];

  for (var c = 0; c < critiqueBlocks.length; c++) {
    var cb = critiqueBlocks[c];
    var bestIdx = -1;

    for (var o = 0; o < originalBlocks.length; o++) {
      if (usedOriginals[o]) continue;
      var ob = originalBlocks[o];

      // Match by language (both labeled with same lang, or both unlabeled)
      if (cb.lang === ob.lang) {
        bestIdx = o;
        break;
      }
    }

    // Fallback: if critique block has no lang, try first unused original
    if (bestIdx === -1 && !cb.lang) {
      for (var f = 0; f < originalBlocks.length; f++) {
        if (!usedOriginals[f]) {
          bestIdx = f;
          break;
        }
      }
    }

    if (bestIdx !== -1) {
      usedOriginals[bestIdx] = true;
      pairs.push({
        lang: cb.lang || originalBlocks[bestIdx].lang,
        oldCode: originalBlocks[bestIdx].code,
        newCode: cb.code,
      });
    }
  }

  if (pairs.length === 0) return null;

  // Build the fragment
  var fragment = document.createDocumentFragment();
  var hasVisualDiff = false;

  for (var p = 0; p < pairs.length; p++) {
    var diff = computeLineDiff(pairs[p].oldCode, pairs[p].newCode);

    // Skip if there are no actual changes
    var hasChanges = false;
    for (var d = 0; d < diff.length; d++) {
      if (diff[d].type !== "unchanged") { hasChanges = true; break; }
    }
    if (!hasChanges) continue;

    hasVisualDiff = true;
    var html = renderDiffHTML(diff, pairs[p].lang);
    var wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    fragment.appendChild(wrapper.firstChild);
  }

  return hasVisualDiff ? fragment : null;
}
