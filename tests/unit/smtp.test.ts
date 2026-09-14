import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import nodemailer, { type SMTPTransportOptions } from 'nodemailer';
import {
  addresses,
  configureSmtp,
  createSmtpCertificate,
  credentials,
  isolateSmtpEnvironment,
  startSmtpFixture,
} from '../helpers/smtp.ts';

// Each import gets its own module-level transport cache, without changing production code.
let moduleId = 0;
function freshSmtp(): Promise<typeof import('../../src/lib/smtp.ts')> {
  return import(`../../src/lib/smtp.ts?regression=${++moduleId}`);
}

test('sendNotification skips unconfigured SMTP and logs why', { timeout: 10_000 }, async (t) => {
  const directory = isolateSmtpEnvironment(t);
  const create = t.mock.method(nodemailer, 'createTransport', () => {
    throw new Error('Unconfigured SMTP must not create a transport');
  });
  const { sendNotification } = await freshSmtp();
  await sendNotification('Not sent', '<p>Not sent</p>');
  assert.equal(create.mock.callCount(), 0);
  const logs = readFileSync(join(directory, 'data/gitecho.log'), 'utf8');
  assert.match(logs, /SMTP not configured/);
  assert.match(logs, /"level":"debug"/);
});

for (const port of [465, 587]) {
  test(`sendNotification configures port ${port}, auth and caches the transport`, async (t) => {
    isolateSmtpEnvironment(t);
    configureSmtp(port);
    const transport = nodemailer.createTransport({ jsonTransport: true });
    t.after(() => transport.close());
    const create = t.mock.method(nodemailer, 'createTransport', () => transport);
    const send = t.mock.method(transport, 'sendMail');
    const { sendNotification } = await freshSmtp();

    await sendNotification('First', '<p>First</p>');
    await sendNotification('Second', '<p>Second</p>');

    assert.equal(create.mock.callCount(), 1);
    assert.deepEqual(create.mock.calls[0]?.arguments, [{
      host: '127.0.0.1', port, secure: port === 465, auth: credentials,
    }]);
    assert.equal(send.mock.callCount(), 2);
    assert.deepEqual(send.mock.calls[0]?.arguments[0], {
      ...addresses, subject: 'First', html: '<p>First</p>',
    });
  });
}

test('sendNotification delivers real SMTP HTML with redacted subject/body and success logs', { timeout: 10_000 }, async (t) => {
  const directory = isolateSmtpEnvironment(t);
  const fixture = await startSmtpFixture(t);
  configureSmtp(fixture.port);
  const { sendNotification } = await freshSmtp();
  await sendNotification(`Backup ${credentials.pass}`, `<p>${credentials.pass}</p>`);

  assert.equal(fixture.messages.length, 1);
  const message = fixture.messages[0]!;
  assert.equal(message.from, `<${addresses.from}>`);
  assert.deepEqual(message.to, [`<${addresses.to}>`]);
  assert.match(message.data, /Subject: Backup \*\*\*/);
  assert.match(message.data, /Content-Type: text\/html;/);
  assert.match(message.data, /<p>\*\*\*<\/p>/);
  assert.ok(!message.data.includes(credentials.pass));
  assert.equal(fixture.sessions[0]?.authenticated, true);
  const logs = readFileSync(join(directory, 'data/gitecho.log'), 'utf8');
  assert.match(logs, /\[smtp\] Sent: Backup \*\*\*/);
  assert.match(logs, /"level":"info"/);
  assert.ok(!logs.includes(credentials.pass));
});

for (const failure of ['authentication', 'message'] as const) {
  test(`sendNotification logs ${failure} rejection without throwing`, { timeout: 10_000 }, async (t) => {
    const directory = isolateSmtpEnvironment(t);
    const fixture = await startSmtpFixture(t, {
      rejectAuth: failure === 'authentication',
      rejectData: failure === 'message',
    });
    configureSmtp(fixture.port);
    const { sendNotification } = await freshSmtp();
    await assert.doesNotReject(sendNotification(`Failed ${credentials.pass}`, '<p>Failure</p>'));

    assert.equal(fixture.messages.length, 0);
    assert.equal(fixture.sessions[0]?.commands.includes('DATA'), failure === 'message');
    const logs = readFileSync(join(directory, 'data/gitecho.log'), 'utf8');
    assert.match(logs, /"level":"error"/);
    assert.match(logs, /\[smtp\] Failed to send email/);
    assert.match(logs, failure === 'authentication' ? /535/ : /554/);
    assert.ok(!logs.includes('[smtp] Sent:'));
    assert.ok(!logs.includes(credentials.pass));
  });
}

for (const security of ['plain', 'implicit', 'starttls'] as const) {
  test(`Nodemailer verifies and sends over ${security} loopback SMTP`, { timeout: 15_000 }, async (t) => {
    const directory = isolateSmtpEnvironment(t);
    const certificate = security === 'plain' ? undefined : createSmtpCertificate(directory);
    const fixture = await startSmtpFixture(t, { security, certificate });
    const options: SMTPTransportOptions = {
      host: '127.0.0.1',
      port: fixture.port,
      secure: security === 'implicit',
      requireTLS: security === 'starttls',
      auth: credentials,
      connectionTimeout: 2_000,
      greetingTimeout: 2_000,
      socketTimeout: 2_000,
      // Trust only this generated certificate, only on this transport.
      tls: certificate ? { ca: certificate.cert, servername: 'localhost', rejectUnauthorized: true } : undefined,
    };
    const transport = nodemailer.createTransport(options);
    t.after(() => transport.close());
    assert.equal(await transport.verify(), true);
    assert.equal(fixture.messages.length, 0, 'verify must not submit a message');
    const info = await transport.sendMail({
      ...addresses, subject: 'Local regression', text: 'SMTP fixture delivery.',
    });
    assert.deepEqual(info.accepted, [addresses.to]);
    assert.deepEqual(info.rejected, []);
    assert.ok(info.response);
    assert.match(info.response, /250/);
    assert.ok(info.messageId);
    assert.equal(fixture.messages.length, 1);
    assert.match(fixture.messages[0]!.data, /SMTP fixture delivery\./);
    assert.equal(fixture.messages[0]?.encrypted, security !== 'plain');
    assert.equal(fixture.sessions.length, 2);
    for (const session of fixture.sessions) {
      assert.equal(session.authenticated, true);
      assert.equal(session.commands.includes('STARTTLS'), security === 'starttls');
      if (security === 'starttls') {
        assert.deepEqual(session.commands.slice(0, 4), ['EHLO', 'STARTTLS', 'EHLO', 'AUTH']);
      }
    }
  });
}

test('Nodemailer preserves typed SMTP authentication errors from verify and send', { timeout: 10_000 }, async (t) => {
  isolateSmtpEnvironment(t);
  const fixture = await startSmtpFixture(t, { rejectAuth: true });
  const transport = nodemailer.createTransport({
    host: '127.0.0.1', port: fixture.port, secure: false, auth: credentials,
    connectionTimeout: 2_000, greetingTimeout: 2_000, socketTimeout: 2_000,
  });
  t.after(() => transport.close());
  function isAuthError(error: unknown): boolean {
    assert.ok(error instanceof Error);
    assert.ok('code' in error);
    assert.equal(error.code, 'EAUTH');
    assert.ok('responseCode' in error);
    assert.equal(error.responseCode, 535);
    assert.ok('command' in error);
    assert.equal(error.command, 'AUTH PLAIN');
    return true;
  }
  await assert.rejects(transport.verify(), isAuthError);
  await assert.rejects(transport.sendMail({ ...addresses, subject: 'Rejected', text: 'Never sent' }), isAuthError);
  assert.equal(fixture.sessions.length, 2);
  assert.equal(fixture.messages.length, 0);
  assert.ok(fixture.sessions.every((session) => !session.commands.includes('MAIL')));
});
