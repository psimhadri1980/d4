const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32 (26 chars).
 * Lexicographically sortable by creation time. Uses Web Crypto, so it runs in Node and browsers.
 */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  // 256 is a multiple of 32, so `% 32` is unbiased.
  for (const b of bytes) rand += CROCKFORD.charAt(b % 32);
  return time + rand;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
