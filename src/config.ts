import dotenv from "dotenv";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE_NAME = ".env-md-copilot-viewer";
const ENV_TEMPLATE_NAME = ".env.template";
const DEFAULT_ENV_TEMPLATE = `# Server port used by \`npm run dev\` / \`npm start\` (defaults to 3011)
PORT=3011
# true: if PORT is in use, keep incrementing until a free port is found
AUTO_INCREMENT_PORT=true

# true: include existing .md files at startup, false: only track newly created files after startup
LOAD_EXISTING_MD=true

# Comma-separated quoted path substrings to exclude from results
# Example: "checkpoints/index.md","tmp/","node_modules/"
EXCLUDE_PATTERN='"checkpoints/index.md"'

# Maximum number of most recently updated files sent to the frontend
FILE_MAX_LIMIT=20

# Comma-separated list of extra flags appended to every copilot CLI invocation
# Example: --flag1,--flag2
COPILOT_FLAGS=

# Comma-separated list of Copilot CLI model names available in the Prompt app
# Example: gpt-4.1,claude-opus-4-5,o3
COPILOT_MODELS=

# Default model used for CLI spawning when no model is explicitly selected
# Must be one of the models listed in COPILOT_MODELS (if COPILOT_MODELS is set)
# Example: claude-opus-4.5
COPILOT_DEFAULT_MODEL=
`;

function ensureEnvFile(): string {
  const cwdEnvPath = path.resolve(process.cwd(), ENV_FILE_NAME);
  if (fsSync.existsSync(cwdEnvPath)) {
    return cwdEnvPath;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFile), "..");
  const packageTemplatePath = path.resolve(packageRoot, ENV_TEMPLATE_NAME);

  if (fsSync.existsSync(packageTemplatePath)) {
    fsSync.copyFileSync(packageTemplatePath, cwdEnvPath);
    return cwdEnvPath;
  }

  fsSync.writeFileSync(cwdEnvPath, DEFAULT_ENV_TEMPLATE, "utf8");
  return cwdEnvPath;
}

function parseExcludePatterns(rawValue: string | undefined): string[] {
  if (!rawValue) {
    return [];
  }
  const matches = rawValue.matchAll(/"([^"]+)"/g);
  return [...matches].map((match) => match[1]).filter((item) => item.length > 0);
}

function parseFileMaxLimit(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 20;
  }
  return Math.floor(parsed);
}

export const envFilePath = ensureEnvFile();
dotenv.config({ path: envFilePath });

export const port = Number(process.env.PORT || 3011);
export const autoIncrementPort = process.env.AUTO_INCREMENT_PORT !== "false";
export const loadExistingMd = process.env.LOAD_EXISTING_MD !== "false";
export const excludePatterns = parseExcludePatterns(process.env.EXCLUDE_PATTERN);
export const fileMaxLimit = parseFileMaxLimit(process.env.FILE_MAX_LIMIT);
export const copilotModels = (process.env.COPILOT_MODELS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
export const copilotDefaultModel = (process.env.COPILOT_DEFAULT_MODEL ?? "").trim();
export const copilotFlags = (process.env.COPILOT_FLAGS ?? "")
  .split(",")
  .map((f) => f.trim())
  .filter(Boolean);
