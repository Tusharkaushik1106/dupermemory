# Claude Operational Rules — DuperMemory Development

These are the rules I follow when working on this project. They exist to prevent hallucinated code, unnecessary complexity, and scope creep.

---

## Core Rules

### 1. No invented APIs
I do not use browser APIs, Chrome extension APIs, or web platform features unless I have confirmed they exist. If I am unsure, I say so and we verify first.

### 2. No imaginary libraries
Every `import` or `require` must reference a real, published package. If I want to add a dependency, I name it explicitly and ask before adding it. For this project, the default is zero dependencies.

### 3. Every file must be runnable
I do not write skeleton code, placeholder functions, or `// TODO` stubs unless explicitly asked. If a file is created, it must do what it claims to do.

### 4. Ask instead of assuming
If requirements are ambiguous — selector behavior, injection timing, event handling — I ask before writing code. A wrong assumption costs more than a clarifying question.

### 5. No jumping ahead in phases
We implement Phase 1 before Phase 2. Phase 2 before Phase 3. I do not speculatively implement future phase features "while I'm in the file."

### 6. Minimal surface area
I do not add error handling, logging, configuration options, or abstractions beyond what the current task requires. The right amount of code is the minimum that makes the feature work.

### 7. Read before editing
Before modifying any existing file, I read it in full. I do not edit based on assumptions about its contents.

### 8. No refactoring on the side
If I notice something that could be improved while fixing something else, I note it and ask. I do not silently refactor.

---

## Chrome Extension Specifics

- We are on Manifest V3. I do not use Manifest V2 APIs (e.g., `chrome.extension`, background pages).
- Service workers do not have DOM access. I never put DOM code in `background.js`.
- Content scripts run in isolated worlds. I never assume they share state with the page's JS.
- `chrome.storage.local` is async. All reads and writes use callbacks or promises correctly.
- `chrome.runtime.sendMessage` can fail silently if no listener is registered. I handle this.

---

## DOM Interaction Rules

- Selectors are confirmed by inspecting the live site before writing code. I do not guess selectors.
- React-controlled inputs require the native value setter + synthetic event dispatch. I use this pattern when needed and do not use `.value =` directly on React inputs.
- Streaming responses (where the AI types progressively) require waiting for completion before capturing. I do not capture mid-stream.

---

## Communication Style

- I flag uncertainty explicitly: "I'm not sure if X works this way — let me check" or "We need to confirm this selector against the live DOM."
- I surface open questions from `design.md` when they become relevant, rather than silently making a choice.
- I keep responses focused. I don't explain what I'm about to do at length — I do it and explain the result briefly.

---

## Change Control

- I do not modify `design.md` unilaterally. If I believe the architecture needs to change based on what I discover, I propose the change and get confirmation.
- I do not rename files, reorganize directories, or change the manifest structure without asking.

---

## Definition of Done (per task)

A task is done when:
1. The code runs without errors
2. It does what was specified — no more, no less
3. I have confirmed the behavior (by describing what I expect to happen, or by running it if possible)
4. No TODOs or stubs remain in the delivered code
