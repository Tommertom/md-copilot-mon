# Code Quality Improvement Plan

A prioritized plan for improving code quality, maintainability, and robustness of **md-copilot-viewer**, based on a full architecture review and the feedback from [PR #10](https://github.com/Tommertom/md-copilot-mon/pull/10).

---

## Priority 1 — Critical DRY Violations & Structural Issues

### 1.1 Extract shared backend utilities into `src/util.ts`

**Problem**: Two identical implementations of base64url ID encoding exist — `toId()` in `watcher.ts` and `toSessionId()` in `session-store.ts`. Both do `Buffer.from(x, "utf8").toString("base64url")`. The heading extraction logic also appears in three places: `watcher.ts` (`extractTitle`), `session-store.ts` (inline first-line parsing), and `markdown.ts` (`extractTitle` via regex).

**Recommendation**: Create `src/util.ts` with shared `toBase64Id()` and `extractFirstHeading()` functions. Import them in all three files. This was the core recommendation from PR #10 and remains valid.

**Files affected**: `src/watcher.ts`, `src/session-store.ts`, `src/markdown.ts`, new `src/util.ts`

### 1.2 Extract shared frontend utilities into `web/shared.js`

**Problem**: Massive code duplication across the six mini-app `app.js` files:
- `escapeHtml()` is copy-pasted identically in `todos/app.js`, `events/app.js`, `session-files/app.js`, `session-checkpoints/app.js`, `session-research/app.js`
- `formatSize()` is duplicated in `session-files/app.js`, `session-checkpoints/app.js`, `session-research/app.js`
- `formatMtime()` is duplicated in the same three files
- `renderSessionList()` is near-identical across all six sub-apps (~30 lines each)
- `refreshSessions()` follows the same fetch → update → render pattern in every app
- `connectSessionChangeEvents()` with reconnect/debounce logic is copy-pasted identically in all six sub-apps (~20 lines each)

**Recommendation**: Create `web/shared.js` exporting: `escapeHtml()`, `formatSize()`, `formatMtime()`, `renderSessionList()`, `connectSessionChangeEvents()`, and a base `refreshSessions()` helper. Each mini-app imports and customizes via callbacks.

**Files affected**: All `web/*/app.js` files, new `web/shared.js`

### 1.3 Extract shared CSS into `web/shared.css`

**Problem**: The base CSS reset, sidebar layout, session list styling, toolbar, placeholder, and data-table styles are duplicated (often identically) across all six `styles.css` files. A visual or spacing change requires updating six files.

**Recommendation**: Create `web/shared.css` containing the common rules (box-sizing reset, body, `.app` grid, `.sidebar`, `.session-item-*`, `.toolbar`, `.content`, `.placeholder`, `.data-table`). Each sub-app CSS then imports or links the shared file and adds only page-specific overrides.

**Files affected**: All `web/*/styles.css`, new `web/shared.css`

---

## Priority 2 — Robustness & Error Handling (from PR #10)

### 2.1 Add graceful shutdown handling

**Problem**: The HTTP server reference is discarded after the port-binding loop in `start()`. There are no `SIGTERM`/`SIGINT` handlers. If the process is killed, the chokidar watcher is never closed, which can leave stale file handles.

**Recommendation**: Retain the `http.Server` reference from `createServer(app)`. Add signal handlers that:
1. Close the HTTP server
2. Call `index.stop()` to close the chokidar watcher
3. Exit cleanly

This was a key recommendation from PR #10.

**Files affected**: `src/index.ts`

### 2.2 Fix `refreshFiles()` missing `res.ok` check

**Problem**: In `web/app.js`, `refreshFiles()` calls `fetch("/api/files")` and immediately calls `res.json()` without checking `res.ok`. A non-200 response (e.g. 500) will cause a JSON parse error instead of showing a meaningful message.

**Recommendation**: Add an `if (!res.ok)` guard before parsing, matching the pattern already used in the sub-apps.

**Files affected**: `web/app.js`

### 2.3 Initialize Mermaid only once

**Problem**: `mermaid.initialize({ startOnLoad: false })` is called on every `renderMermaidInEditor()` invocation. This is wasteful and could cause unexpected resets of mermaid state.

**Recommendation**: Add a module-level `mermaidInitialized` flag and only call `mermaid.initialize()` once. This was flagged in PR #10.

**Files affected**: `web/app.js`

---

## Priority 3 — Type Safety & Code Quality

### 3.1 Remove `any` types from `markdown.ts`

**Problem**: The custom fence renderer uses `any` for all parameters:
```ts
md.renderer.rules.fence = (tokens: any, idx: any, options: any, env: any, self: any) => {
```
This defeats TypeScript's purpose and hides potential bugs.

**Recommendation**: Use the proper markdown-it types: `Token[]`, `number`, `Options`, `object`, `Renderer`. This was flagged in PR #10.

**Files affected**: `src/markdown.ts`, potentially `src/external.d.ts`

### 3.2 Improve `external.d.ts` declarations

**Problem**: `markdown-it-texmath` and `html-to-docx` have bare `declare module` with no type information. This means all imports from these modules are `any`.

**Recommendation**: Add minimal type signatures for the functions actually used, or find/create `@types/*` packages.

**Files affected**: `src/external.d.ts`

### 3.3 Reduce `index.ts` file size

**Problem**: `src/index.ts` is 776 lines — it defines environment handling, utility functions, type definitions, all API routes, SSE management, session resolution helpers, and the server startup logic in a single file.

**Recommendation**: Extract into focused modules:
- `src/config.ts` — env file handling, `ensureEnvFile()`, config parsing
- `src/routes.ts` or `src/routes/*.ts` — route handler definitions
- `src/sse.ts` — SSE client management, broadcast helpers
- Keep `src/index.ts` as the thin composition root

**Files affected**: `src/index.ts`, new files

---

## Priority 4 — Backend Deduplication (from PR #10)

### 4.1 Extract `resolveSession()` helper

**Problem**: The pattern `getCachedSessions() → find(s => s.id === id) → 404 if not found` is repeated in 10+ route handlers (sessions/:id, sessions/:id/events, sessions/:id/files, etc.).

**Recommendation**: Create a `resolveSession(req, res)` helper that returns the `SessionInfo` or sends a 404 and returns `null`. Each route handler becomes 2-3 lines shorter.

**Files affected**: `src/index.ts`

### 4.2 Extract SSE registration helpers

**Problem**: The SSE setup block (set headers, flush, add to client set, handle close) appears twice — once for `/api/changes` and once for `/api/session-changes`. The broadcast loop also appears twice in `index.onChange()`.

**Recommendation**: Create `registerSseClient(res, clientSet)` and `broadcastSse(clientSet, data)` helpers.

**Files affected**: `src/index.ts`

---

## Priority 5 — Frontend Architecture Improvements

### 5.1 Add loading states

**Problem**: When data is being fetched, users see stale content or empty containers with no indication of loading. Only the diff viewer shows a loading message.

**Recommendation**: Add consistent loading indicators across all apps. Show a spinner or "Loading..." text when fetching data.

**Files affected**: All `web/*/app.js`

### 5.2 Add error boundaries / user-facing error messages

**Problem**: Most frontend fetch errors are logged to `console.error` with no visible feedback to the user. The user sees a blank area or stale data.

**Recommendation**: Display inline error messages (e.g., a red banner or placeholder text) when API calls fail, with a retry option.

**Files affected**: All `web/*/app.js`

### 5.3 Consider a lightweight client-side router or shared shell

**Problem**: Each mini-app is a completely separate HTML page. Navigation between them requires full page loads (via `window.open` popups). There's no shared navigation or state.

**Recommendation**: For now, the pop-out model is intentional and useful. However, consider adding a shared navigation header component (injected via JS) so users can switch between views without the menu. This is low priority — the pop-out model is a deliberate feature.

---

## Priority 6 — Security Hardening

### 6.1 Add Content Security Policy headers

**Problem**: No CSP headers are set. The app loads scripts from CDN (`cdn.jsdelivr.net`) and uses `contenteditable`, which could be vectors for XSS.

**Recommendation**: Add a `Content-Security-Policy` header via Express middleware, allowing only the specific CDN origins and `'self'`.

**Files affected**: `src/index.ts`

### 6.2 Add input validation middleware

**Problem**: Route parameters like session IDs and table names are used after lookup but aren't validated for format. The `resolveSessionDownloadPath()` function correctly prevents path traversal, but there's no early input validation.

**Recommendation**: Add lightweight input validation (e.g., check that `:id` is a valid base64url string, `:table` matches `^[a-zA-Z_][a-zA-Z0-9_]*$`).

**Files affected**: `src/index.ts`

### 6.3 Audit `contenteditable` security

**Problem**: The editor uses `contenteditable="true"` on an `<article>`. Pasted HTML is not sanitized — it goes through `turndownService.turndown()` on save, which converts back to markdown, but the rendered HTML could contain scripts during editing.

**Recommendation**: Sanitize pasted HTML on the `paste` event to strip `<script>`, `<iframe>`, `on*` attributes, etc. Consider using DOMPurify.

**Files affected**: `web/app.js`, `web/index.html`

---

## Priority 7 — Developer Experience

### 7.1 Add linting

**Problem**: No ESLint or Biome configuration exists. Code style is consistent by convention only.

**Recommendation**: Add ESLint (or Biome) with a config for TypeScript strict rules. Add a `lint` script to `package.json`. Consider adding Prettier for formatting.

**Files affected**: New config files, `package.json`

### 7.2 Add unit tests

**Problem**: Zero tests exist. Pure functions in `markdown.ts`, `session-store.ts`, and `watcher.ts` are eminently testable.

**Recommendation**: Add a test runner (Vitest or Node.js built-in test runner). Start with:
- `markdown.ts`: `extractTitle()`, `renderMarkdown()` edge cases
- `session-store.ts`: `readWorkspaceYaml()`, `findSessionStateDir()`
- `watcher.ts`: `isMarkdown()`, `isWorkspaceYaml()`, `extractTitle()`, path utilities
- `index.ts`: `parseExcludePatterns()`, `parseFileMaxLimit()`, `toDisplayPath()`, `toSafeAttachmentFileName()`, `resolveSessionDownloadPath()`

**Files affected**: New `test/` directory, `package.json`

### 7.3 Add JSDoc comments to public functions

**Problem**: Backend functions have minimal to no documentation comments. Frontend functions have one JSDoc comment (`renderMarkdownToHtml`). The code is generally readable but intent is not always clear.

**Recommendation**: Add JSDoc to all exported functions and class methods, describing purpose, params, return values, and thrown errors.

**Files affected**: All `src/*.ts` files

---

## Priority 8 — Performance & Polish

### 8.1 Batch `fs.stat` calls in `collectSessionFiles`

**Problem**: `collectSessionFiles()` calls `fs.stat()` individually for every file in a directory tree, sequentially via a `for...of` loop.

**Recommendation**: Use `Promise.all` to parallelize stat calls within each directory, similar to how `walk()` in `watcher.ts` already does.

**Files affected**: `src/index.ts`

### 8.2 Add `Cache-Control` headers for static assets

**Problem**: Static web assets are served via `express.static()` with default caching. During development this is fine, but in production the CDN-loaded assets and app JS/CSS could benefit from cache headers.

**Recommendation**: Set `maxAge` on `express.static()` for production builds, or add ETags.

**Files affected**: `src/index.ts`

### 8.3 Consider dark mode

**Problem**: All CSS is hard-coded to a light theme. Users working in dark IDE themes may find the bright UI jarring.

**Recommendation**: Add `@media (prefers-color-scheme: dark)` rules or a toggle. Low priority but improves usability for the target audience (developers).

**Files affected**: All CSS files

---

## Summary — PR #10 Relevance Check

The following recommendations from PR #10 **remain valid** and are incorporated above:

| PR #10 Recommendation | Status | Plan Reference |
|---|---|---|
| Extract `toBase64Id()` + `extractFirstHeading()` into `src/util.ts` | **Still needed** — duplications remain in current `main` | §1.1 |
| `registerSseClient()` / `broadcastSse()` helpers | **Still needed** — two identical SSE blocks remain | §4.2 |
| `resolveSession()` helper | **Still needed** — 10+ duplicated lookup patterns | §4.1 |
| Graceful shutdown (retain server ref, signal handlers) | **Still needed** — no shutdown handling exists | §2.1 |
| Type `any` in `markdown.ts` fence renderer | **Still needed** — all params still `any` | §3.1 |
| `mermaid.initialize()` called every render | **Still needed** — no guard flag | §2.3 |
| `refreshFiles()` missing `res.ok` check | **Still needed** — no guard exists | §2.2 |
| `js-yaml` + `WorkspaceInfo` + `readWorkspaceYaml()` | **Already merged** into `main` — no action needed | — |
| `isWorkspaceYaml()` watcher detection | **Already merged** into `main` — no action needed | — |
| `/api/active-sessions` endpoint | **Already merged** into `main` — no action needed | — |

---

## Implementation Order

Suggested order for tackling these improvements:

1. **§1.1** Backend util extraction (quick win, zero risk)
2. **§2.1–2.3** Robustness fixes (graceful shutdown, res.ok, mermaid init)
3. **§3.1–3.2** Type safety (any removal, external.d.ts)
4. **§4.1–4.2** Backend deduplication (resolveSession, SSE helpers)
5. **§1.2–1.3** Frontend shared JS/CSS extraction (biggest effort, biggest DRY payoff)
6. **§3.3** Split index.ts into modules
7. **§7.1–7.2** Linting and testing infrastructure
8. **§5.1–5.2** Frontend UX improvements
9. **§6.1–6.3** Security hardening
10. **§8.1–8.3** Performance and polish
