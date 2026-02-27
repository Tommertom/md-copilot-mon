# md-copilot-viewer

Node.js + TypeScript app that watches markdown files in the current directory and `~/.copilot`, serves a vanilla web UI, renders markdown (Mermaid + LaTeX), and supports DOCX download.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Environment

Create `.env` from `.env.template`.

- `LOAD_EXISTING_MD=true|false`: when `true`, existing markdown files are loaded at startup; when `false`, only newly created markdown files are tracked after startup.
- `EXCLUDE_PATTERN`: comma-separated quoted substrings to exclude by full path match, e.g. `"checkpoints/index.md","tmp/"`.

## Publish to npm

1. Ensure package name/version are correct in `package.json`.
2. Build + publish:

```bash
npm publish --access public
```

`prepublishOnly` runs the TypeScript build automatically.
