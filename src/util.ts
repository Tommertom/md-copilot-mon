import os from "node:os";
import path from "node:path";

/**
 * Encodes a file-system path as a base64url string for use as an opaque ID.
 */
export function toBase64Id(x: string): string {
  return Buffer.from(x, "utf8").toString("base64url");
}

/**
 * Extracts the text of the first ATX heading (# Heading) from markdown text.
 * Returns an empty string if no heading is found.
 */
export function extractFirstHeading(text: string): string {
  const [firstLine = ""] = text.split(/\r?\n/, 1);
  if (!firstLine.startsWith("# ")) {
    return "";
  }
  return firstLine.slice(2).trim();
}

/** Replaces the home directory prefix with `~` for display. */
export function toDisplayPath(filePath: string): string {
  const homePath = os.homedir();
  if (filePath === homePath) {
    return "~";
  }
  const homePrefix = homePath + path.sep;
  if (filePath.startsWith(homePrefix)) {
    return `~/${filePath.slice(homePrefix.length).replaceAll(path.sep, "/")}`;
  }
  return filePath;
}

/** Sanitises a file name for use as a Content-Disposition attachment filename. */
export function toSafeAttachmentFileName(fileName: string): string {
  const baseName = path.basename(fileName);
  const extension = path.extname(baseName).replace(/[^A-Za-z0-9]/g, "");
  const stem = path.basename(baseName, path.extname(baseName)).replace(/[^A-Za-z0-9_-]/g, "_");
  return `${stem || "download"}${extension ? `.${extension}` : ""}`;
}

/** Formats a copilot invocation as a readable command line for logging. */
export function formatCopilotCmd(args: readonly string[]): string {
  const parts = ["copilot", ...args.map((a) => (/[\s"'\\]/.test(a) ? JSON.stringify(a) : a))];
  return parts.join(" ");
}
