import { createServer, type Server, type Socket } from 'node:net';

export interface Envelope {
  from: string;
  to: string[];
}

/** Receives each accepted message; returns its id for the 250 reply. */
type OnMessage =(raw: Buffer, envelope: Envelope) => string;

const NAME = 'd4-mock-smtp';
const MAX_MESSAGE_BYTES =50 * 1024 * 1024;

/**
 * An SMTP server (RFC 5321 subset) that accepts every message: EHLO/HELO, AUTH PLAIN/LOGIN
 * (any credentials), MAIL, RCPT, DATA with dot-unstuffing, RSET, NOOP, VRFY and QUIT. No TLS.
 */
export function createSmtpServer(onMessage: OnMessage): Server {
  return createServer((socket) => void new Session(socket, onMessage));
}

class Session {
  private buf: Buffer = Buffer.alloc(0);
  private from: string | null = null;
  private to: string[] = [];
  private mode: 'command' | 'data' | 'auth' | 'auth-user' | 'auth-pass' = 'command';
  private data: Buffer[] = [];
  private dataBytes = 0;

  constructor(
    private readonly socket: Socket,
    private readonly onMessage: OnMessage,
  ) {
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('error', () => socket.destroy());
    this.reply(220, `${NAME} ESMTP ready`);
  }

  private reply(code: number, ...lines: string[]) {
    if (this.socket.writable) this.socket.write(lines.map((l, i) => `${code}${i < lines.length - 1 ? '-' : ' '}${l}\r\n`).join(''));
  }

  private receive(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (let eol = this.buf.indexOf('\r\n'); eol >= 0; eol = this.buf.indexOf('\r\n')) {
      const line = this.buf.subarray(0, eol);
      this.buf = this.buf.subarray(eol + 2);
      if (this.mode === 'data') this.dataLine(line);
      else this.command(line.toString('utf8'));
    }
  }

  private dataLine(line: Buffer) {
    if (line.length === 1 && line[0] === 0x2e) {
      this.mode = 'command';
      if (this.dataBytes > MAX_MESSAGE_BYTES) this.reply(552, 'Message exceeds fixed maximum message size');
      else this.reply(250, `OK: queued as ${this.onMessage(Buffer.concat(this.data), { from: this.from ?? '', to: this.to })}`);
      this.reset();
      return;
    }
    // Dot-stuffing: a leading '.' was doubled by the client.
    const content = line[0] === 0x2e ? line.subarray(1) : line;
    this.dataBytes += content.length + 2;
    if (this.dataBytes <= MAX_MESSAGE_BYTES) this.data.push(content, Buffer.from('\r\n'));
  }

  private command(line: string) {
    if (this.mode !== 'command') return this.authStep(line);
    const verb = line.split(' ', 1)[0]!.toUpperCase();
    const arg = line.slice(verb.length).trim();
    switch (verb) {
      case 'EHLO':
        this.reset();
        return this.reply(250, NAME, `SIZE ${MAX_MESSAGE_BYTES}`, '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN LOGIN');
      case 'HELO':
        this.reset();
        return this.reply(250, NAME);
      case 'AUTH': {
        const [mech, initial] = arg.split(/\s+/);
        if (mech?.toUpperCase() === 'PLAIN') {
          if (initial) return this.reply(235, '2.7.0 Authentication successful');
          this.mode = 'auth';
          return this.reply(334, '');
        }
        if (mech?.toUpperCase() === 'LOGIN') {
          this.mode = 'auth-user';
          return this.reply(334, Buffer.from('Username:').toString('base64'));
        }
        return this.reply(504, '5.5.4 Unrecognized authentication type');
      }
      case 'MAIL': {
        const m = /^FROM:\s*<([^>]*)>/i.exec(arg);
        if (!m) return this.reply(501, '5.5.4 Syntax: MAIL FROM:<address>');
        this.reset();
        this.from = m[1]!;
        return this.reply(250, '2.1.0 OK');
      }
      case 'RCPT': {
        if (this.from === null) return this.reply(503, '5.5.1 Error: need MAIL command');
        const m = /^TO:\s*<([^>]+)>/i.exec(arg);
        if (!m) return this.reply(501, '5.5.4 Syntax: RCPT TO:<address>');
        this.to.push(m[1]!);
        return this.reply(250, '2.1.5 OK');
      }
      case 'DATA':
        if (!this.to.length) return this.reply(503, '5.5.1 Error: need RCPT command');
        this.mode = 'data';
        return this.reply(354, 'End data with <CR><LF>.<CR><LF>');
      case 'RSET':
        this.reset();
        return this.reply(250, '2.0.0 OK');
      case 'NOOP':
        return this.reply(250, '2.0.0 OK');
      case 'VRFY':
        return this.reply(252, '2.0.0 Cannot VRFY user, but will accept message');
      case 'QUIT':
        this.reply(221, '2.0.0 Bye');
        return void this.socket.end();
      case 'STARTTLS':
        return this.reply(454, '4.7.0 TLS not available');
      default:
        return this.reply(502, '5.5.2 Error: command not recognized');
    }
  }

  private authStep(line: string) {
    if (line === '*') {
      this.mode = 'command';
      return this.reply(501, '5.7.0 Authentication cancelled');
    }
    if (this.mode === 'auth-user') {
      this.mode = 'auth-pass';
      return this.reply(334, Buffer.from('Password:').toString('base64'));
    }
    this.mode = 'command';
    this.reply(235, '2.7.0 Authentication successful');
  }

  private reset() {
    this.from = null;
    this.to = [];
    this.data = [];
    this.dataBytes = 0;
  }
}
