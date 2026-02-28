/**
 * Encode a string as a URL-safe base64 identifier.
 */
export function toBase64Id(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

/**
 * Extract the title from the first line of a markdown string.
 * Returns an empty string when the first line is not an `# …` heading.
 */
export function extractFirstHeading(markdown: string): string {
  const [firstLine = ""] = markdown.split(/\r?\n/, 1);
  if (!firstLine.startsWith("# ")) {
    return "";
  }
  return firstLine.slice(2).trim();
}
