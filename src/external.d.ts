declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  interface TexmathOptions {
    engine: unknown;
    delimiters: string;
  }
  export default function texmath(md: MarkdownIt, options?: TexmathOptions): void;
}

declare module "html-to-docx" {
  export default function HTMLtoDOCX(
    html: string,
    header: null | string,
    options?: Record<string, unknown>
  ): Promise<Buffer>;
}
