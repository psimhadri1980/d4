/** Small helpers for writing SVG as text. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const num = (n: number) => String(Math.round(n * 10) / 10);

/** Light-theme colours (Carbon tokens), fixed so files look the same everywhere. */
export const COLORS = {
  text: '#161616',
  textSecondary: '#525252',
  border: '#e0e0e0',
  borderStrong: '#8d8d8d',
  layer01: '#ffffff',
  layer02: '#f4f4f4',
  interactive: '#0f62fe',
  error: '#da1e28',
  success: '#24a148',
  planning: '#198038',
  edge: '#a8a8a8',
};

export const LAYER_COLORS: Record<string, string> = {
  Strategy: '#6929c4',
  Organisation: '#ee538b',
  Business: '#da1e28',
  Data: '#1192e8',
  Application: '#009d9a',
  Technology: '#002d9c',
  Governance: '#b28600',
  Design: '#a56eff',
  Planning: '#198038',
  System: '#8d8d8d',
};

export const FONT = "'Source Sans 3', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif";

export interface Svg {
  svg: string;
  width: number;
  height: number;
}

export function frame(width: number, height: number, body: string[], title: string): Svg {
  return {
    width,
    height,
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}" font-family="${esc(FONT)}" font-size="12">`,
      `<title>${esc(title)}</title>`,
      `<rect width="100%" height="100%" fill="${COLORS.layer01}"/>`,
      ...body,
      '</svg>',
    ].join('\n'),
  };
}
