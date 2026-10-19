import { createTransport, type Transporter } from 'nodemailer';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
}

/** Sends report emails; the worker and renderer get one when SMTP is configured. */
export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  /** `smtp://user:pass@host:port` (or `smtps://`). */
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(url);
  }

  async send(m: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content), contentType: a.contentType })),
    });
  }

  close() {
    this.transport.close();
  }
}

/** For tests: keeps what would have been sent. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(m: MailMessage) {
    this.sent.push(m);
  }
}
