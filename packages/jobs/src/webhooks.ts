import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { claimDueDeliveries, recordAttempt, relayEvents, type Db, type DueDelivery } from '@d4/db';

/** Waits before attempts 2, 3, …; a delivery gets `RETRY_DELAYS_MS.length + 1` attempts in all. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
/** A webhook is switched off after this many deliveries in a row end in failure. */
export const DISABLE_AFTER = 5;
const TIMEOUT_MS = 10_000;
const LEASE_MS = 60_000;

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/**
 * `D4-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Receivers recompute it
 * with their secret and reject old timestamps to stop replays.
 */
export function signPayload(secret: string, body: string, at: Date = new Date()): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, now: Date = new Date()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now.getTime() / 1000 - t) > toleranceSec) return false;
  return signPayload(secret, body, new Date(t * 1000)) === header;
}

/**
 * Refuses URLs that would let a tenant reach the platform's own network: only http(s), no
 * credentials, and (unless `allowPrivate`, for local development) no loopback, private,
 * link-local or unique-local addresses after DNS resolution.
 */
export async function checkWebhookUrl(raw: string, allowPrivate: boolean): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return 'must use https';
  if (url.username || url.password) return 'must not contain credentials';
  if (allowPrivate) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `host '${host}' does not resolve`;
  }
  return addresses.some(isPrivateAddress) ? 'must not point to a private or local address' : null;
}

export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

export interface WebhookPassOptions {
  allowPrivate: boolean;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

/** One sender pass: relay new events into deliveries, then send whatever is due. */
export async function runWebhookPass(db: Db, opts: WebhookPassOptions): Promise<{ relayed: number; sent: number; failed: number }> {
  const now = opts.now ?? (() => new Date());
  let relayed = 0;
  for (;;) {
    const r = await relayEvents(db);
    relayed += r.events;
    if (r.events < 200) break;
  }
  const due = await claimDueDeliveries(db, now(), LEASE_MS);
  let sent = 0;
  let failed = 0;
  await Promise.all(
    due.map(async (d) => {
      const r = await attempt(d, opts, now());
      await recordAttempt(db, d, r, DISABLE_AFTER);
      if (r.ok) sent++;
      else failed++;
    }),
  );
  return { relayed, sent, failed };
}

async function attempt(d: DueDelivery, opts: WebhookPassOptions, at: Date) {
  const started = Date.now();
  const made = d.delivery.attempts + 1;
  const retry = () => (made <= RETRY_DELAYS_MS.length ? { retryAt: new Date(at.getTime() + RETRY_DELAYS_MS[made - 1]!) } : {});
  // Checked on every attempt: the address behind a name can change after the webhook was saved.
  const bad = await checkWebhookUrl(d.webhook.url, opts.allowPrivate);
  if (bad) return { ok: false, error: `URL ${bad}`, durationMs: 0 };
  const body = JSON.stringify(d.delivery.payload);
  try {
    const res = await (opts.fetchImpl ?? fetch)(d.webhook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'D4-Webhooks/1',
        'd4-event': d.delivery.eventType,
        'd4-delivery': d.delivery.id,
        'd4-signature': signPayload(d.webhook.secret, body, at),
      },
      body,
    });
    await res.body?.cancel().catch(() => undefined);
    const durationMs = Date.now() - started;
    if (res.status >= 200 && res.status < 300) return { ok: true, responseStatus: res.status, durationMs };
    return { ok: false, responseStatus: res.status, error: `HTTP ${res.status}`, durationMs, ...retry() };
  } catch (e) {
    const error = e instanceof Error ? (e.name === 'TimeoutError' ? `no response within ${TIMEOUT_MS / 1000} s` : e.message) : String(e);
    return { ok: false, error, durationMs: Date.now() - started, ...retry() };
  }
}
