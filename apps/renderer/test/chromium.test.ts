import { describe, expect, it } from 'vitest';
import { pageHtml } from '@d4/render';
import { Chromium } from '../src/chromium';
import { loadConfig } from '../src/config';

const svg = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#0f62fe"/><text x="10" y="30">Hello</text></svg>', width: 400, height: 200 };

describe('renderer config', () => {
  it('defaults to one render at a time on its own queue', () => {
    const c = loadConfig({ POSTGRES_URL: 'postgres://u:p@h/d', NEO4J_PASSWORD: 'x', REDIS_URL: 'redis://r:6379', S3_ENDPOINT: 'http://s3:8333', S3_ACCESS_KEY: 'k', S3_SECRET_KEY: 's', D4_PUBLIC_URL: 'http://localhost:5173' });
    expect(c).toMatchObject({ RENDER_CONCURRENCY: 1, RENDER_HEALTH_PORT: 3003 });
    expect(c.RENDER_QUEUE).toBeUndefined();
  });
});

// Needs Chromium: runs in the renderer image (or with CHROMIUM_PATH / installed Playwright browsers).
describe.skipIf(!process.env['D4_TEST_CHROMIUM'])('Chromium rasterizer', () => {
  it('makes a PDF and a 2× PNG', async () => {
    const chrome = new Chromium(process.env['CHROMIUM_PATH']);
    try {
      const pdf = await chrome.rasterize(pageHtml(svg, { title: 't', fit: { width: 1123, height: 794 } }), { format: 'pdf', width: 1123, height: 794 });
      expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe('%PDF-');
      const png = await chrome.rasterize(pageHtml(svg, { title: 't' }), { format: 'png', width: 448, height: 248 });
      expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
      // IHDR width at 2× device pixels.
      expect(new DataView(png.buffer, png.byteOffset).getUint32(16)).toBe(896);
    } finally {
      await chrome.close();
    }
  }, 60_000);
});
