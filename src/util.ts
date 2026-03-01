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
