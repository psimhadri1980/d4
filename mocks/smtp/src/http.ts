import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Inbox, StoredMessage } from './inbox';
import type { Attachment } from './mime';

/**
 * The inbox over HTTP, using the subset of Mailpit's API (v1) that tools and tests use:
 *
 *   GET    /api/v1/messages[?start&limit]          newest first
 *   GET    /api/v1/search?query=…[&start&limit]    e.g. `to:someone@example.test subject:report`
 *   GET    /api/v1/message/:id                     headers, Text, HTML, Attachments
 *   GET    /api/v1/message/:id/raw                 the message as received
 *   GET    /api/v1/message/:id/part/:partId        one attachment's bytes
 *   DELETE /api/v1/messages                        all, or `{"IDs": [...]}`
 *   GET    /readyz, /livez, /                      health and a plain HTML list
 */
export function createInboxServer(inbox: Inbox): Server {
  return createServer((req, res) => {
    route(inbox, req, res).catch((e: unknown) => json(res, 500, { error: e instanceof Error ? e.message : String(e) }));
  });
}

async function route(inbox: Inbox, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://inbox.local');
  const path = url.pathname;
  if (path === '/readyz' || path === '/livez') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  if (req.method === 'GET' && path === '/') return html(res, inbox.list());
  if (req.method === 'GET' && (path === '/api/v1/messages' || path === '/api/v1/search')) {
    const all = path === '/api/v1/search' ? inbox.search(url.searchParams.get('query') ?? '') : inbox.list();
    const start = Math.max(0, Number(url.searchParams.get('start') ?? 0) || 0);
    const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50);
    const page = all.slice(start, start + limit);
    return json(res, 200, { total: inbox.list().length, unread: 0, count: page.length, messages_count: all.length, start, tags: [], messages: page.map(summary) });
  }
  if (req.method === 'DELETE' && path === '/api/v1/messages') {
    const body = await readBody(req);
    const ids = body ? (JSON.parse(body) as { IDs?: string[] }).IDs : undefined;
    inbox.delete(ids?.length ? ids : undefined);
    return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  }
  const m = /^\/api\/v1\/message\/([^/]+)(?:\/(raw|part\/([^/]+)))?$/.exec(path);
  const msg = m && req.method === 'GET' ? inbox.get(m[1]!) : undefined;
  if (!msg) return json(res, 404, { error: 'message not found' });
  if (m![2] === 'raw') return void res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(msg.raw);
  if (m![3]) {
    const part = [...msg.mail.attachments, ...msg.mail.inline].find((a) => a.PartID === m![3]);
    if (!part) return json(res, 404, { error: 'part not found' });
    return void res.writeHead(200, { 'content-type': part.ContentType, 'content-disposition': `attachment; filename="${part.FileName.replace(/"/g, '')}"` }).end(part.content);
  }
  return json(res, 200, detail(msg));
}

/** An attachment as listed (its bytes come from the part endpoint). */
const strip = (a: Attachment) => ({ PartID: a.PartID, FileName: a.FileName, ContentType: a.ContentType, ContentID: a.ContentID, Size: a.Size });

function summary(m: StoredMessage) {
  return {
    ID: m.id,
    MessageID: m.mail.messageId,
    Read: false,
    From: m.mail.from,
    To: m.mail.to,
    Cc: m.mail.cc,
    Bcc: bcc(m),
    ReplyTo: m.mail.replyTo,
    Subject: m.mail.subject,
    Created: m.created,
    Size: m.raw.length,
    Attachments: m.mail.attachments.length,
    Snippet: m.mail.text.replace(/\s+/g, ' ').trim().slice(0, 250),
  };
}

function detail(m: StoredMessage) {
  return {
    ID: m.id,
    MessageID: m.mail.messageId,
    From: m.mail.from,
    To: m.mail.to,
    Cc: m.mail.cc,
    Bcc: bcc(m),
    ReplyTo: m.mail.replyTo,
    ReturnPath: m.envelope.from,
    Subject: m.mail.subject,
    Date: m.mail.date,
    Text: m.mail.text,
    HTML: m.mail.html,
    Size: m.raw.length,
    Inline: m.mail.inline.map(strip),
    Attachments: m.mail.attachments.map(strip),
  };
}

/** Envelope recipients not named in To or Cc. */
function bcc(m: StoredMessage) {
  const named = new Set([...m.mail.to, ...m.mail.cc].map((a) => a.Address.toLowerCase()));
  return m.envelope.to.filter((a) => !named.has(a.toLowerCase())).map((a) => ({ Name: '', Address: a }));
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }).end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

function html(res: ServerResponse, messages: StoredMessage[]) {
  const rows = messages
    .map((m) => `<tr><td>${esc(m.created)}</td><td>${esc(m.mail.to.map((a) => a.Address).join(', '))}</td><td><a href="/api/v1/message/${m.id}/raw">${esc(m.mail.subject || '(no subject)')}</a></td><td>${m.mail.attachments.map((a) => `<a href="/api/v1/message/${m.id}/part/${a.PartID}">${esc(a.FileName)}</a>`).join(' ')}</td></tr>`)
    .join('');
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>D4 mock inbox</title><style>body{font:14px system-ui;margin:24px}td,th{padding:4px 12px;text-align:left;border-bottom:1px solid #ddd}</style></head><body><h1>D4 mock inbox</h1><p>${messages.length} message(s). Development only; nothing leaves this machine.</p><table><tr><th>Received</th><th>To</th><th>Subject</th><th>Attachments</th></tr>${rows}</table></body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}
