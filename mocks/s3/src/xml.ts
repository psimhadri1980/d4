const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' };

const escapeXml =(s: string) => s.replace(/[<>&'"]/g, (c) => ESCAPES[c]!);

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e] ?? whole;
  });
}

/** One element; a list of strings is taken as already-built child elements. */
export function el(name: string, content: string | number | boolean | readonly string[]): string {
  const inner = Array.isArray(content) ? content.join('') : escapeXml(String(content));
  return `<${name}>${inner}</${name}>`;
}

export function xmlDocument(root: string, children: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NS}">${children.join('')}</${root}>`;
}

/** Inner text of each `<name>` element. Request bodies here (Delete, CompleteMultipartUpload) are small and flat. */
export function elements(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]!);
}

export const text = (xml: string, name: string): string | undefined => {
  const v = elements(xml, name)[0];
  return v === undefined ? undefined : unescapeXml(v.trim());
};
