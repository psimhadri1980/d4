import { randomBytes } from 'node:crypto';
import { parseMail, type Address, type ParsedMail } from './mime';
import type { Envelope } from './smtp';

export interface StoredMessage {
  id: string;
  created: string;
  raw: Buffer;
  envelope: Envelope;
  mail: ParsedMail;
}

/** Received messages in memory, newest first, capped so a long-running stack does not grow forever. */
export class Inbox {
  private messages: StoredMessage[] = [];

  constructor(private readonly limit = 1000) {}

  add(raw: Buffer, envelope: Envelope): StoredMessage {
    const msg: StoredMessage = { id: randomBytes(16).toString('base64url'), created: new Date().toISOString(), raw, envelope, mail: parseMail(raw) };
    this.messages.unshift(msg);
    this.messages.length = Math.min(this.messages.length, this.limit);
    return msg;
  }

  list(): StoredMessage[] {
    return this.messages;
  }

  get(id: string): StoredMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  /** Deletes the given messages, or all of them. */
  delete(ids?: string[]): void {
    this.messages = ids ? this.messages.filter((m) => !ids.includes(m.id)) : [];
  }

  /**
   * Mailpit-style search: space-separated terms, all of which must match, case-insensitively.
   * `to:`, `from:`, `subject:` and `is:`/`has:attachment` look at one field; bare words at
   * subject, addresses and text. `"quoted phrases"` keep their spaces.
   */
  search(query: string): StoredMessage[] {
    const terms = (query.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((t) => t.replace(/"/g, '').toLowerCase());
    return this.messages.filter((m) => terms.every((t) => matches(m, t)));
  }
}

const addresses = (list: (Address | null)[]) => list.flatMap((a) => (a ? [`${a.Name} <${a.Address}>`.toLowerCase()] : []));

function matches(m: StoredMessage, term: string): boolean {
  const [field, value] = term.includes(':') ? [term.slice(0, term.indexOf(':')), term.slice(term.indexOf(':') + 1)] : ['', term];
  const to = [...addresses([...m.mail.to, ...m.mail.cc]), ...m.envelope.to.map((a) => a.toLowerCase())];
  const from = [...addresses([m.mail.from]), m.envelope.from.toLowerCase()];
  switch (field) {
    case 'to':
      return to.some((a) => a.includes(value));
    case 'from':
      return from.some((a) => a.includes(value));
    case 'subject':
      return m.mail.subject.toLowerCase().includes(value);
    case 'has':
    case 'is':
      return value === 'attachment' ? m.mail.attachments.length > 0 : false;
    default:
      return [m.mail.subject.toLowerCase(), m.mail.text.toLowerCase(), ...to, ...from].some((s) => s.includes(term));
  }
}
