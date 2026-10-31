import { createInboxServer } from './http';
import { Inbox } from './inbox';
import { createSmtpServer } from './smtp';

/**
 * Development-only mail catcher for the local stack (replaces Mailpit): accepts every message
 * over SMTP and shows it through a Mailpit-compatible HTTP API. Nothing is delivered.
 *
 *   SMTP_MOCK_PORT          SMTP, default 1025
 *   SMTP_MOCK_HTTP_PORT     inbox API and page, default 8025
 *   SMTP_MOCK_MAX_MESSAGES  oldest are dropped beyond this, default 1000
 */
function main() {
  const inbox = new Inbox(Number(process.env['SMTP_MOCK_MAX_MESSAGES'] || 1000));
  const smtpPort = Number(process.env['SMTP_MOCK_PORT'] || 1025);
  const httpPort = Number(process.env['SMTP_MOCK_HTTP_PORT'] || 8025);
  const smtp = createSmtpServer((raw, envelope) => {
    const msg = inbox.add(raw, envelope);
    log('message received', { id: msg.id, to: envelope.to, subject: msg.mail.subject, bytes: raw.length });
    return msg.id;
  }).listen(smtpPort, '0.0.0.0');
  const http = createInboxServer(inbox).listen(httpPort, '0.0.0.0', () => log('mock SMTP ready', { smtpPort, httpPort }));
  const stop = () => {
    smtp.close();
    http.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

function log(message: string, fields: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

main();
