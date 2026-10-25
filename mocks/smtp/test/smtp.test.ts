import type { Server } from 'node:http';
import type { AddressInfo, Server as NetServer } from 'node:net';
import { createTransport, type Transporter } from 'nodemailer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInboxServer } from '../src/http';
import { Inbox } from '../src/inbox';
import { decodeWords, parseAddresses, parseHeaderValue } from '../src/mime';
import { createSmtpServer } from '../src/smtp';

const inbox = new Inbox();
let smtp: NetServer;
let http: Server;
let api: string;
let mailer: Transporter;

const listen = <T extends NetServer | Server>(s: T) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const get = async (path: string) => (await fetch(`${api}${path}`)).json() as Promise<any>;

beforeAll(async () => {
  smtp = createSmtpServer((raw, envelope) => inbox.add(raw, envelope).id);
  http = createInboxServer(inbox);
  const smtpPort = await listen(smtp);
  api = `http://127.0.0.1:${await listen(http)}`;
  mailer = createTransport({ host: '127.0.0.1', port: smtpPort, secure: false, auth: { user: 'any', pass: 'thing' } });
});
afterAll(() => {
  mailer.close();
  smtp.close();
  http.close();
});
beforeEach(() => inbox.delete());

describe('mock SMTP with nodemailer', () => {
  it('accepts a message with an attachment and serves it the way Mailpit does', async () => {
    await mailer.sendMail({
      from: 'D4 Reports <reports@d4.local>',
      to: ['ada@example.test'],
      bcc: 'hidden@example.test',
      subject: 'Weekly roadmap (2026-10-25) – ünïcode',
      text: 'The report is ready.\nReports: http://localhost:5173/w/1/reports\n.leading dot',
      attachments: [{ filename: 'roadmap ä.pdf', content: Buffer.from('%PDF-1.7 test'), contentType: 'application/pdf' }],
    });

    const search = await get(`/api/v1/search?query=${encodeURIComponent('to:ada@example.test')}`);
    expect(search.messages).toHaveLength(1);
    expect(search.messages[0]).toMatchObject({ Subject: 'Weekly roadmap (2026-10-25) – ünïcode', Attachments: 1, From: { Name: 'D4 Reports', Address: 'reports@d4.local' } });

    const msg = await get(`/api/v1/message/${search.messages[0].ID}`);
    expect(msg.Text).toContain('/reports');
    expect(msg.Text).toContain('\n.leading dot');
    expect(msg.Bcc).toEqual([{ Name: '', Address: 'hidden@example.test' }]);
    expect(msg.Attachments).toEqual([{ PartID: '2', FileName: 'roadmap ä.pdf', ContentType: 'application/pdf', ContentID: '', Size: 13 }]);

    const part = await fetch(`${api}/api/v1/message/${msg.ID}/part/2`);
    expect(await part.text()).toBe('%PDF-1.7 test');
  });

  it('searches by recipient, subject and words, and deletes', async () => {
    await mailer.sendMail({ from: 'a@d4.local', to: 'one@example.test', subject: 'Alpha report', text: 'first' });
    await mailer.sendMail({ from: 'a@d4.local', to: 'two@example.test', subject: 'Beta report', text: 'second' });
    expect((await get('/api/v1/messages')).messages_count).toBe(2);
    expect((await get('/api/v1/search?query=subject:beta')).messages.map((m: any) => m.To[0].Address)).toEqual(['two@example.test']);
    expect((await get('/api/v1/search?query=report%20first')).messages).toHaveLength(1);
    await fetch(`${api}/api/v1/messages`, { method: 'DELETE' });
    expect((await get('/api/v1/messages')).messages_count).toBe(0);
  });
});

describe('MIME helpers', () => {
  it('decodes encoded words, parameters and address lists', () => {
    expect(decodeWords('=?UTF-8?Q?caf=C3=A9?= =?UTF-8?B?IGJhcg==?=')).toBe('café bar');
    expect(parseHeaderValue(`attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf`)).toEqual({ value: 'attachment', params: { filename: 'résumé.pdf' } });
    expect(parseHeaderValue('multipart/mixed; boundary="--a;b"').params['boundary']).toBe('--a;b');
    expect(parseAddresses('"Doe, Jane" <jane@x.test>, bob@y.test')).toEqual([
      { Name: 'Doe, Jane', Address: 'jane@x.test' },
      { Name: '', Address: 'bob@y.test' },
    ]);
  });
});
