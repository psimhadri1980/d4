import { esc, type Svg } from './svg';

/** Paper sizes for PDF output, in CSS pixels at 96 dpi (landscape). */
export const PAPER = { A4: { width: 1123, height: 794 }, A3: { width: 1587, height: 1123 } } as const;

/**
 * An HTML page holding one SVG, for headless Chromium to print (PDF) or screenshot (PNG). The SVG
 * is scaled down to fit the page when it is larger; it is never scaled up.
 */
export function pageHtml(svg: Svg, opts: { title: string; fit?: { width: number; height: number } }): string {
  const scale = opts.fit ? Math.min(1, (opts.fit.width - 48) / svg.width, (opts.fit.height - 48) / svg.height) : 1;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)}</title>
<style>
  @page { margin: 0; ${opts.fit ? `size: ${opts.fit.width}px ${opts.fit.height}px;` : ''} }
  html, body { margin: 0; background: #ffffff; }
  .sheet { padding: 24px; ${opts.fit ? `width: ${opts.fit.width - 48}px; height: ${opts.fit.height - 48}px; overflow: hidden;` : ''} }
  .sheet > svg { width: ${Math.round(svg.width * scale)}px; height: ${Math.round(svg.height * scale)}px; display: block; }
</style>
</head>
<body><div class="sheet">${svg.svg.replace(/^<svg /, '<svg preserveAspectRatio="xMinYMin meet" ')}</div></body>
</html>
`;
}
