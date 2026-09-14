import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { createSecureContext, createServer as createTlsServer, TLSSocket } from 'node:tls';
import type { TestContext } from 'node:test';

export const credentials = { user: 'smtp-test-user', pass: 'synthetic-smtp-password' };
export const addresses = { from: 'sender@example.test', to: 'recipient@example.test' };

export function isolateSmtpEnvironment(t: TestContext): string {
  const directory = mkdtempSync(join(process.cwd(), '.smtp-test-'));
  const overrides: Record<string, string | undefined> = {
    CONFIG_DIR: join(directory, 'config'),
    DATA_DIR: join(directory, 'data'),
    BACKUPS_DIR: join(directory, 'backups'),
    LOG_LEVEL: 'debug',
    LOG_MAX_BYTES: '10485760',
    SMTP_HOST: undefined,
    SMTP_PORT: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_FROM: undefined,
    SMTP_TO: undefined,
    GITHUB_PAT: undefined,
    AZUREDEVOPS_PAT: undefined,
    GITLAB_PAT: undefined,
    MASTER_KEY: undefined,
    NOTIFY_ON_SUCCESS: 'false',
  };
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

export function configureSmtp(port: number): void {
  Object.assign(process.env, {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    SMTP_USER: credentials.user,
    SMTP_PASS: credentials.pass,
    SMTP_FROM: addresses.from,
    SMTP_TO: addresses.to,
  });
}

export interface SmtpCertificate {
  key: Buffer;
  cert: Buffer;
}

export function createSmtpCertificate(directory: string): SmtpCertificate {
  const keyPath = join(directory, 'smtp-key.pem');
  const certPath = join(directory, 'smtp-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'pipe', timeout: 10_000 });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

interface FixtureOptions {
  rejectAuth?: boolean;
  rejectData?: boolean;
  security?: 'plain' | 'implicit' | 'starttls';
  certificate?: SmtpCertificate;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  data: string;
  encrypted: boolean;
}

export interface SmtpSession {
  commands: string[];
  authenticated: boolean;
  encrypted: boolean;
}

export interface SmtpFixture {
  port: number;
  messages: SmtpMessage[];
  sessions: SmtpSession[];
}

/** Minimal, bounded SMTP peer: binds only loopback and never relays messages. */
export async function startSmtpFixture(
  t: TestContext,
  options: FixtureOptions = {},
): Promise<SmtpFixture> {
  const security = options.security ?? 'plain';
  if (security !== 'plain') assert.ok(options.certificate);
  const secureContext = options.certificate && createSecureContext(options.certificate);
  const sockets = new Set<Socket>();
  const sessions: SmtpSession[] = [];
  const messages: SmtpMessage[] = [];

  function track(socket: Socket): void {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  }

  function accept(initialSocket: Socket): void {
    let socket = initialSocket;
    track(socket);
    const session: SmtpSession = {
      commands: [],
      authenticated: false,
      encrypted: socket instanceof TLSSocket,
    };
    sessions.push(session);
    let buffer = '';
    let inData = false;
    let authChallenge = false;
    let from = '';
    let to: string[] = [];
    let data: string[] = [];

    function reply(line: string): void {
      socket.write(`${line}\r\n`);
    }

    function authenticate(encoded: string): void {
      const [, user, pass] = Buffer.from(encoded, 'base64').toString().split('\0');
      session.authenticated = !options.rejectAuth &&
        user === credentials.user && pass === credentials.pass;
      reply(session.authenticated ? '235 2.7.0 Authenticated' : '535 5.7.8 Authentication rejected');
    }

    function receive(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      if (buffer.length > 128 * 1024) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (options.rejectData) reply('554 5.3.0 Message rejected');
            else {
              messages.push({ from, to: [...to], data: data.join('\r\n'), encrypted: session.encrypted });
              reply('250 2.0.0 Queued as fixture-message');
            }
          } else {
            data.push(line.replace(/^\.\./, '.'));
            if (data.length > 2_000) socket.destroy();
          }
          continue;
        }
        if (authChallenge) {
          authChallenge = false;
          authenticate(line);
          continue;
        }
        const [command = '', ...args] = line.split(' ');
        session.commands.push(command.toUpperCase());
        switch (command.toUpperCase()) {
          case 'EHLO':
          case 'HELO':
            reply('250-localhost');
            if (security === 'starttls' && !session.encrypted) reply('250-STARTTLS');
            reply('250 AUTH PLAIN');
            break;
          case 'STARTTLS': {
            assert.ok(secureContext);
            reply('220 2.0.0 Ready for TLS');
            socket.removeListener('data', receive);
            socket = new TLSSocket(socket, { isServer: true, secureContext });
            track(socket);
            session.encrypted = true;
            session.authenticated = false;
            buffer = '';
            socket.on('data', receive);
            break;
          }
          case 'AUTH':
            if (args[0] !== 'PLAIN') reply('504 5.5.4 Unsupported authentication');
            else if (args[1]) authenticate(args[1]);
            else {
              authChallenge = true;
              reply('334 ');
            }
            break;
          case 'MAIL':
            if (!session.authenticated) reply('530 5.7.0 Authentication required');
            else {
              from = line.slice('MAIL FROM:'.length).trim();
              to = [];
              data = [];
              reply('250 2.1.0 Sender accepted');
            }
            break;
          case 'RCPT':
            to.push(line.slice('RCPT TO:'.length).trim());
            reply('250 2.1.5 Recipient accepted');
            break;
          case 'DATA':
            inData = true;
            reply('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'QUIT':
            socket.end('221 2.0.0 Goodbye\r\n');
            break;
          default:
            reply('502 5.5.1 Unsupported command');
        }
      }
    }

    socket.on('data', receive);
    reply('220 localhost SMTP regression fixture');
  }

  const server = security === 'implicit'
    ? createTlsServer(options.certificate!, accept)
    : createServer(accept);
  // Track TCP sockets before an implicit TLS handshake, including failed handshakes.
  server.on('connection', track);
  server.on('tlsClientError', () => {});
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  }, 8_000);
  t.after(async () => {
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, messages, sessions };
}
