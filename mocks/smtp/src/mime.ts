/** A parsed email: what the inbox API shows (Mailpit's field names). */
export interface Address {
  Name: string;
  Address: string;
}

export interface Attachment {
  PartID: string;
  FileName: string;
  ContentType: string;
  ContentID: string;
  Size: number;
  content: Buffer;
}

export interface ParsedMail {
  messageId: string;
  subject: string;
  date: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  text: string;
  html: string;
  attachments: Attachment[];
  inline: Attachment[];
}

interface Part {
  headers: Map<string, string>;
  body: Buffer;
}

/** Splits a message or body part into unfolded headers (lower-case names, first value wins) and body. */
function splitPart(raw: Buffer): Part {
  let sep = raw.indexOf('\r\n\r\n');
  let skip = 4;
  if (sep < 0) {
    sep = raw.indexOf('\n\n');
    skip = 2;
  }
  const head = (sep < 0 ? raw : raw.subarray(0, sep)).toString('utf8');
  const body = sep < 0 ? Buffer.alloc(0) : raw.subarray(sep + skip);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function charsetDecode(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** RFC 2047 encoded words (`=?utf-8?Q?…?=`, `=?utf-8?B?…?=`); whitespace between two of them is dropped. */
export function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[QqBb]\?[^?]*\?=)\s+(?==\?[^?]+\?[QqBb]\?[^?]*\?=)/g, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([QqBb])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return charsetDecode(bytes, charset);
    });
}

/** `type/subtype; a=b; c="d"`, including RFC 2231 `name*=utf-8''…` and continuations `name*0*=`. */
export function parseHeaderValue(value: string): { value: string; params: Record<string, string> } {
  const [main = '', ...rest] = value.match(/(?:[^;"]+|"(?:[^"\\]|\\.)*")+/g) ?? [];
  const raw: Record<string, { parts: string[]; extended: boolean }> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const m = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(p.slice(0, eq).trim().toLowerCase());
    if (!m) continue;
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    const entry = (raw[m[1]!] ??= { parts: [], extended: false });
    entry.parts[Number(m[2] ?? 0)] = v;
    if (m[3]) entry.extended = true;
  }
  const params: Record<string, string> = {};
  for (const [name, { parts, extended }] of Object.entries(raw)) {
    const joined = parts.join('');
    if (!extended) {
      params[name] = decodeWords(joined);
      continue;
    }
    const m = /^([^']*)'[^']*'(.*)$/.exec(joined);
    const bytes = Buffer.from((m ? m[2]! : joined).replace(/%([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    params[name] = charsetDecode(bytes, m?.[1] || 'utf-8');
  }
  return { value: main.trim().toLowerCase(), params };
}

/** `"Name" <a@b>, c@d` → addresses. */
export function parseAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  return (value.match(/(?:[^,"<]+|"(?:[^"\\]|\\.)*"|<[^>]*>)+/g) ?? []).flatMap((entry) => {
    const m = /^\s*(?:"?((?:[^"\\]|\\.)*?)"?\s*)?<([^>]+)>\s*$/.exec(entry);
    const name = m ? decodeWords(m[1] ?? '').trim() : '';
    const address = (m ? m[2]! : entry).trim();
    return address ? [{ Name: name, Address: address }] : [];
  });
}

function decodeBody(body: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
    case 'quoted-printable':
      return Buffer.from(
        body
          .toString('latin1')
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
        'latin1',
      );
    default:
      return body;
  }
}

/** The parts of a multipart body, split on its boundary. */
function children(body: Buffer, boundary: string): Buffer[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = body.indexOf(delimiter);
  while (start >= 0) {
    const lineEnd = body.indexOf('\n', start);
    if (lineEnd < 0 || body.subarray(start + delimiter.length, start + delimiter.length + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, lineEnd);
    if (next < 0) break;
    // The CRLF before the next delimiter belongs to the delimiter.
    const end = body[next - 2] === 0x0d ? next - 2 : next - 1;
    parts.push(body.subarray(lineEnd + 1, end));
    start = next;
  }
  return parts;
}

export function parseMail(raw: Buffer): ParsedMail {
  const top = splitPart(raw);
  const h = (name: string) => top.headers.get(name);
  const date = new Date(h('date') ?? Date.now());
  const mail: ParsedMail = {
    messageId: (h('message-id') ?? '').replace(/^<|>$/g, ''),
    subject: decodeWords(h('subject') ?? ''),
    date: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
    from: parseAddresses(h('from'))[0] ?? null,
    to: parseAddresses(h('to')),
    cc: parseAddresses(h('cc')),
    replyTo: parseAddresses(h('reply-to')),
    text: '',
    html: '',
    attachments: [],
    inline: [],
  };
  walk(top, '', mail);
  return mail;
}

/** Depth-first over the MIME tree; part ids follow Mailpit (`1`, `2`, `2.1` …). */
function walk(part: Part, id: string, mail: ParsedMail): void {
  const type = parseHeaderValue(part.headers.get('content-type') ?? 'text/plain');
  if (type.value.startsWith('multipart/') && type.params['boundary']) {
    children(part.body, type.params['boundary']).forEach((child, i) => walk(splitPart(child), id ? `${id}.${i + 1}` : String(i + 1), mail));
    return;
  }
  const disposition = parseHeaderValue(part.headers.get('content-disposition') ?? '');
  const fileName = disposition.params['filename'] ?? type.params['name'];
  const content = decodeBody(part.body, part.headers.get('content-transfer-encoding'));
  if (disposition.value === 'attachment' || disposition.value === 'inline' || fileName) {
    const a: Attachment = {
      PartID: id || '1',
      FileName: fileName ?? '',
      ContentType: type.value,
      ContentID: (part.headers.get('content-id') ?? '').replace(/^<|>$/g, ''),
      Size: content.length,
      content,
    };
    (disposition.value === 'inline' ? mail.inline : mail.attachments).push(a);
    return;
  }
  const decoded = charsetDecode(content, type.params['charset'] ?? 'utf-8');
  if (type.value === 'text/html' && !mail.html) mail.html = decoded;
  else if (type.value === 'text/plain' && !mail.text) mail.text = decoded.replace(/\r\n/g, '\n');
}
