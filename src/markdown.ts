import MarkdownIt from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import HTMLtoDOCX from "html-to-docx";
import { extractFirstHeading } from "./util.js";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
  .use(texmath, { engine: katex, delimiters: "dollars" });

const defaultFence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self): string => {
  const token = tokens[idx];
  const info = (token.info || "").trim();
  if (info === "mermaid") {
    return `<pre class="mermaid">${md.utils.escapeHtml(token.content)}</pre>`;
  }
  if (defaultFence) {
    return defaultFence(tokens, idx, options, env, self);
  }
  return self.renderToken(tokens, idx, options);
};

function generateStyledHtml(htmlContent: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="color-scheme" content="light">
  <title>${title}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: 'Times New Roman', Times, serif; font-size: 12pt; line-height: 1.5; color: #333; background: #fff; }
    h1 { font-size: 24pt; margin: 24pt 0 12pt; color: #2c3e50; }
    h2 { font-size: 18pt; margin: 18pt 0 10pt; color: #34495e; }
    h3 { font-size: 14pt; margin: 14pt 0 8pt; }
    p { margin: 0 0 10pt; text-align: justify; }
    ul, ol { margin: 0 0 10pt; padding-left: 20pt; }
    blockquote { margin: 10pt 0; padding-left: 15pt; border-left: 3px solid #3498db; color: #666; font-style: italic; }
    code { font-family: 'Courier New', Courier, monospace; font-size: 10pt; background-color: #f4f4f4; padding: 2pt 4pt; }
    pre { font-family: 'Courier New', Courier, monospace; font-size: 10pt; background-color: #f4f4f4; padding: 10pt; margin: 10pt 0; white-space: pre-wrap; word-wrap: break-word; }
    table { border-collapse: collapse; width: 100%; margin: 10pt 0; }
    th, td { border: 1px solid #ddd; padding: 8pt; text-align: left; }
    th { background-color: #f5f5f5; }
    a { color: #3498db; text-decoration: underline; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;
}

export function renderMarkdown(markdown: string): string {
  return md.render(markdown);
}

export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const title = extractFirstHeading(markdown) || "Document";
  const htmlContent = md.render(markdown);
  const fullHtml = generateStyledHtml(htmlContent, title);
  return HTMLtoDOCX(fullHtml, null, {
    title,
    subject: "Converted from Markdown",
    creator: "Marky-compatible exporter",
    font: "Times New Roman",
    fontSize: 24
  });
}
