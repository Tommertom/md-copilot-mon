# Architecture & Coding Standards

This document describes the target architecture, project conventions, and coding standards for **md-copilot-viewer**.

---

## 1. Project Overview

md-copilot-viewer is a Node.js tool that watches Copilot session artifacts (markdown files, SQLite databases, YAML workspace files, JSONL event logs) and serves a web-based dashboard for real-time monitoring and editing. It comprises:

- A **backend** Express server (TypeScript, compiled to ESM)
- A **frontend** consisting of a main markdown editor app plus six standalone mini-apps (diff, todos, events, session-files, session-checkpoints, session-research), all served as static vanilla JS/HTML/CSS

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Web Frontend                         │
│                                                          │
│  ┌──────────┐ ┌──────┐ ┌───────┐ ┌───────┐ ┌──────────┐│
│  │ Main App │ │ Diff │ │ Todos │ │Events │ │Files/Res/││
│  │ (editor) │ │      │ │       │ │       │ │Checkpoint││
│  └────┬─────┘ └──┬───┘ └──┬────┘ └──┬────┘ └────┬─────┘│
│       │           │        │         │            │      │
│       └───────────┴────────┴────┬────┴────────────┘      │
│                                 │ HTTP + SSE              │
└─────────────────────────────────┼────────────────────────┘
                                  │
┌─────────────────────────────────┼────────────────────────┐
│              Express Backend    │                         │
│                                 │                         │
│  ┌──────────┐  ┌────────────┐  ┌┴──────────┐             │
│  │  Watcher │  │  Session   │  │  REST /   │             │
│  │(chokidar)│  │   Store    │  │  SSE API  │             │
│  └────┬─────┘  └─────┬──────┘  └───────────┘             │
│       │               │                                   │
│  ┌────┴────┐   ┌──────┴──────┐                            │
│  │Markdown │   │  SQLite /   │                            │
│  │  Index  │   │  YAML / FS  │                            │
│  └─────────┘   └─────────────┘                            │
└──────────────────────────────────────────────────────────┘
```

### Backend Layers

| Layer              | Responsibility                                                                      | Files                        |
| ------------------ | ----------------------------------------------------------------------------------- | ---------------------------- |
| **Entry / Server** | Express setup, route definitions, SSE management, env config, startup logic         | `src/index.ts`, `src/cli.ts` |
| **Watcher**        | File system watching via chokidar, markdown index (in-memory), change notifications | `src/watcher.ts`             |
| **Session Store**  | SQLite DB reads, workspace YAML parsing, session discovery, event log parsing       | `src/session-store.ts`       |
| **Markdown**       | Markdown-to-HTML rendering, DOCX export                                             | `src/markdown.ts`            |
| **Types**          | Shared type definitions                                                             | `src/types.ts`               |

### Frontend Structure

Each mini-app is a standalone HTML page with its own `app.js` and `styles.css`. All apps follow the same sidebar + main content layout pattern and connect to the backend via REST + SSE.

| App                 | Path                    | Purpose                                                            |
| ------------------- | ----------------------- | ------------------------------------------------------------------ |
| Main                | `/`                     | Markdown file list, preview, editor, save, copy/paste, DOCX export |
| Diff                | `/diff/`                | Git diff rendering per session (side-by-side via Diff2Html)        |
| Todos               | `/todos/`               | Session SQLite table viewer                                        |
| Events              | `/events/`              | Session `events.jsonl` timeline and raw viewer                     |
| Session Files       | `/session-files/`       | Session-attached files browser & download                          |
| Session Research    | `/session-research/`    | Session research files browser & download                          |
| Session Checkpoints | `/session-checkpoints/` | Checkpoint JSON viewer                                             |

---

## 3. Data Flow

### File Watching & SSE

1. `MarkdownIndex` watches configured roots via chokidar
2. On file add/change/unlink, the index updates its in-memory `Map<path, FileEntry>`
3. Change listeners fire, which broadcast `data: changed\n\n` to connected SSE clients
4. Frontend `EventSource` receives events and debounces a `refreshFiles()` / `refreshSessions()` call

### Session Discovery

1. `discoverSessions()` scans tracked file paths for `session-state/` directories
2. For each directory: reads SQLite `.db` files, `workspace.yml`, and first `.md` file
3. Returns `SessionInfo[]` which is cached in-memory (invalidated on file changes)

---

## 4. Coding Standards

### 4.1 TypeScript (Backend)

- **Strict mode**: `tsconfig.json` uses `"strict": true` — never disable
- **ESM**: Project uses `"type": "module"` with `NodeNext` module resolution. Use `.js` extensions in imports
- **No `any`**: Avoid `any` types. Use proper types, generics, or `unknown` with type narrowing
- **Named exports**: Prefer named exports over default exports
- **Error handling**: Use typed error narrowing (`as NodeJS.ErrnoException`) rather than bare `catch` blocks. Always handle filesystem errors explicitly (check `code === "ENOENT"` etc.)
- **Async/await**: Prefer `async`/`await` over raw promises. Use `void` prefix for fire-and-forget promise calls
- **Immutability**: Prefer `const` over `let`. Use `readonly` on class fields and function params where applicable
- **Function size**: Keep functions under ~50 lines. Extract helpers for complex logic
- **Early return**: Prefer early returns / guard clauses over deep nesting

### 4.2 JavaScript (Frontend)

- **Vanilla JS**: No build step or framework. Use ES module `<script type="module">`
- **DOM references**: Acquire element references once at module top
- **Event listeners**: Use `addEventListener`, never inline `onclick`
- **HTML escaping**: Always escape user-supplied content before inserting into DOM. Use the `escapeHtml()` pattern (create element, set `textContent`, read `innerHTML`)
- **Fetch error handling**: Always check `res.ok` before calling `res.json()`
- **SSE reconnection**: All apps must implement exponential/linear backoff reconnection for `EventSource`
- **No global pollution**: Keep all state in module-scoped variables

### 4.3 CSS

- **No frameworks/preprocessors**: Plain CSS, one stylesheet per app
- **Box-sizing**: All files start with `* { box-sizing: border-box; }`
- **Layout**: Use CSS Grid for the app shell (sidebar + content), Flexbox for toolbars/lists
- **Naming**: Use descriptive class names. ID selectors for JS hooks, class selectors for styling. No BEM required but be consistent
- **Responsiveness**: Add `@media` breakpoints for toolbar layouts at narrow widths
- **Design tokens**: Use consistent color values. Prefer CSS custom properties for repeated values (colors, spacing, radii)

### 4.4 HTML

- **Semantic markup**: Use `<aside>`, `<main>`, `<article>`, `<section>`, `<nav>` appropriately
- **Accessibility**: All interactive elements must have accessible names (`aria-label`, visible text, or `role`). Use `tabindex` and keyboard handlers on custom interactive elements
- **External dependencies**: Load from CDN with version pinning (e.g., `katex@0.16.25`, not `katex@latest`)

### 4.5 General

- **No dead code**: Remove unused variables, imports, and functions
- **Comments**: Use comments to explain _why_, not _what_. Keep JSDoc for public API functions
- **Error messages**: User-facing error messages should be actionable. Log stack traces server-side only
- **Security**: Validate and sanitize all user input. Use path traversal guards for file downloads. Apply rate limiting to mutation endpoints
- **Testing**: (Aspirational) Add unit tests for pure functions (`markdown.ts`, `session-store.ts` parsing logic, `watcher.ts` path utilities). Add integration tests for API routes

---

## 5. Project Structure (Target)

```
md-copilot-viewer/
├── src/
│   ├── cli.ts                 # CLI entry point (shebang)
│   ├── index.ts               # Express server, routes, SSE, startup
│   ├── markdown.ts            # Markdown rendering & DOCX export
│   ├── session-store.ts       # Session discovery, SQLite/YAML/JSONL reads
│   ├── watcher.ts             # File watching & in-memory markdown index
│   ├── types.ts               # Shared type definitions
│   ├── util.ts                # (Proposed) Shared pure utility functions
│   └── external.d.ts          # Ambient module declarations
├── web/
│   ├── index.html             # Main app
│   ├── app.js                 # Main app logic
│   ├── styles.css             # Main app styles
│   ├── shared.js              # (Proposed) Shared frontend utilities
│   ├── shared.css             # (Proposed) Shared base styles
│   ├── diff/                  # Git diff mini-app
│   ├── todos/                 # Todos mini-app
│   ├── events/                # Events mini-app
│   ├── session-files/         # Session files mini-app
│   ├── session-checkpoints/   # Session checkpoints mini-app
│   └── session-research/      # Session research mini-app
├── package.json
├── tsconfig.json
├── .env.template
├── ARCHITECTURE.md            # This file
├── CODE_QUALITY_PLAN.md       # Improvement plan
├── README.md
└── LICENSE
```

---

## 6. API Design Conventions

- **RESTful routes**: Use resource-oriented paths (`/api/sessions/:id/events`)
- **Consistent error format**: Always return `{ error: string }` on failure
- **HTTP status codes**: Use `400` for bad input, `404` for not found, `409` for conflicts, `500` for server errors
- **SSE endpoints**: Use `text/event-stream` content type, `no-cache`, and `X-Accel-Buffering: no`
- **Rate limiting**: Apply to all mutation endpoints (save, commit)
- **No sensitive data in responses**: Display paths use `~` substitution via `toDisplayPath()`

---

## 7. Dependency Policy

- Keep dependencies minimal; each must justify its inclusion
- Pin major versions in `package.json` (`^` ranges acceptable for minor/patch)
- External CDN assets must be version-pinned in HTML `<script>`/`<link>` tags
- Prefer Node.js built-in modules (`node:fs`, `node:path`, `node:os`) over third-party alternatives

---

## 8. Build & Distribution

- TypeScript compiles to `dist/` via `tsc`
- `web/` is served as-is (no bundler, no transpilation)
- CLI entry is `dist/cli.js` (registered as `md-copilot-viewer` bin)
- `prepublishOnly` ensures build runs before `npm publish`
- Published files: `dist/`, `web/`, `.env.template`, `README.md`, `LICENSE`
