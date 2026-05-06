import type { Theme } from "./svg.js";

export interface HtmlOptions {
  title?: string;
  theme?: Theme;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export function renderHtml(svgContent: string, opts: HtmlOptions = {}): string {
  const title = opts.title ?? "cc-grass";
  const theme = opts.theme ?? "dark";
  const bg = theme === "dark" ? "#0d1117" : "#ffffff";
  const fg = theme === "dark" ? "#c9d1d9" : "#1f2328";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    background: ${bg};
    color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    box-sizing: border-box;
  }
  .cc-grass-wrap { max-width: 100%; overflow-x: auto; }
  .cc-grass-wrap svg rect[data-date]:hover {
    stroke: ${theme === "dark" ? "#ffffff" : "#1f2328"};
    stroke-width: 1;
    cursor: default;
  }
</style>
</head>
<body>
<div class="cc-grass-wrap">
${svgContent}
</div>
</body>
</html>
`;
}
