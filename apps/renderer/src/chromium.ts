import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import type { Rasterize } from '@d4/jobs';

/** The bundled brand stand-in font, inlined so pages render the same with or without network. */
function fontCss(): string {
  const dir = join(dirname(require.resolve('@fontsource/source-sans-3/package.json')), 'files');
  return [400, 600]
    .map((w) => {
      const data = readFileSync(join(dir, `source-sans-3-latin-${w}-normal.woff2`)).toString('base64');
      return `@font-face{font-family:'Source Sans 3';font-weight:${w};font-style:normal;src:url(data:font/woff2;base64,${data}) format('woff2');}`;
    })
    .join('\n');
}

/**
 * One headless Chromium for the process; each render gets its own context (2× pixel density for
 * PNG). Pages are static HTML with inline SVG: no network, no scripts.
 */
export class Chromium {
  private browser?: Promise<Browser>;
  private readonly fonts = fontCss();

  private get(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true, ...(process.env['CHROMIUM_PATH'] && { executablePath: process.env['CHROMIUM_PATH'] }) });
    this.browser.catch(() => (this.browser = undefined));
    return this.browser;
  }

  readonly rasterize: Rasterize = async (html, opts) => {
    const browser = await this.get();
    const context = await browser.newContext({
      viewport: { width: Math.ceil(opts.width), height: Math.ceil(opts.height) },
      deviceScaleFactor: opts.format === 'png' ? 2 : 1,
      javaScriptEnabled: false,
    });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => (route.request().url().startsWith('data:') ? route.continue() : route.abort()));
      await page.setContent(html.replace('</style>', `${this.fonts}\n</style>`), { waitUntil: 'load' });
      // Inline fonts: wait until they are applied (the page has no scripts of its own).
      await page.waitForFunction('document.fonts.status === "loaded"').catch(() => undefined);
      const bytes =
        opts.format === 'pdf'
          ? await page.pdf({ width: `${opts.width}px`, height: `${opts.height}px`, printBackground: true, pageRanges: '1' })
          : await page.screenshot({ type: 'png', fullPage: true });
      return new Uint8Array(bytes);
    } finally {
      await context.close();
    }
  };

  async close() {
    if (this.browser) await (await this.browser).close().catch(() => undefined);
  }
}
