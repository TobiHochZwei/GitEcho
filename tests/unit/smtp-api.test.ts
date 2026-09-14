import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContext } from 'astro/middleware';
import nodemailer from 'nodemailer';
import { POST } from '../../src/pages/api/test/smtp.ts';
import {
  addresses,
  configureSmtp,
  credentials,
  isolateSmtpEnvironment,
  startSmtpFixture,
} from '../helpers/smtp.ts';

async function post(body: unknown, raw = false): Promise<Response> {
  const request = new Request('http://localhost/api/test/smtp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? String(body) : JSON.stringify(body),
  });
  const context: Parameters<typeof POST>[0] = createContext({ request, defaultLocale: 'en' });
  return POST(context);
}

const input = { host: '127.0.0.1', port: 587, ...credentials, ...addresses };

test('SMTP API reports all missing fields before creating a transport', async (t) => {
  isolateSmtpEnvironment(t);
  const create = t.mock.method(nodemailer, 'createTransport', () => {
    throw new Error('Missing fields must not create a transport');
  });
  for (const [body, raw] of [[{}, false], ['not-json', true]] as const) {
    const response = await post(body, raw);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(await response.json(), {
      ok: false, error: 'Missing SMTP fields: host, user, pass, from, to',
    });
  }
  assert.equal(create.mock.callCount(), 0);
});

for (const field of ['host', 'user', 'pass', 'from', 'to'] as const) {
  test(`SMTP API identifies missing ${field}`, async (t) => {
    isolateSmtpEnvironment(t);
    const response = await post({ ...input, [field]: '' });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, error: `Missing SMTP fields: ${field}` });
  });
}

for (const port of [undefined, 465, 587]) {
  test(`SMTP API configures TLS and default port (${port ?? 'omitted'})`, async (t) => {
    isolateSmtpEnvironment(t);
    const transport = nodemailer.createTransport({ jsonTransport: true });
    t.after(() => transport.close());
    const calls: string[] = [];
    t.mock.method(transport, 'verify', async () => { calls.push('verify'); return true; });
    const send = t.mock.method(transport, 'sendMail', async () => {
      calls.push('send');
      return { message: '{}' };
    });
    const create = t.mock.method(nodemailer, 'createTransport', () => transport);
    const response = await post({ ...input, port });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['verify', 'send']);
    assert.deepEqual(create.mock.calls[0]?.arguments, [{
      host: input.host, port: port ?? 587, secure: port === 465, auth: credentials,
    }]);
    assert.deepEqual(send.mock.calls[0]?.arguments[0], {
      ...addresses,
      subject: '✅ GitEcho test email',
      text: 'This is a test email from GitEcho confirming your SMTP configuration works.',
    });
  });
}

for (const source of ['request', 'stored', 'mixed', 'invalid-json'] as const) {
  test(`SMTP API verifies then sends real text mail using ${source} config`, { timeout: 10_000 }, async (t) => {
    isolateSmtpEnvironment(t);
    const fixture = await startSmtpFixture(t);
    if (source !== 'request') configureSmtp(fixture.port);
    const overriddenTo = 'override@example.test';
    const response = source === 'invalid-json'
      ? await post('{invalid', true)
      : await post(source === 'request'
        ? { ...input, port: fixture.port }
        : source === 'mixed' ? { to: overriddenTo, pass: '' } : {});
    const recipient = source === 'mixed' ? overriddenTo : addresses.to;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, message: `Test email sent to ${recipient}.` });
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(fixture.sessions.length, 2);
    assert.equal(fixture.sessions[0]?.authenticated, true);
    assert.ok(!fixture.sessions[0]?.commands.includes('MAIL'), 'verify must not submit mail');
    assert.ok(fixture.sessions[1]?.commands.includes('DATA'));
    assert.equal(fixture.messages.length, 1);
    const message = fixture.messages[0]!;
    assert.equal(message.from, `<${addresses.from}>`);
    assert.deepEqual(message.to, [`<${recipient}>`]);
    assert.match(message.data, /Content-Type: text\/plain;/);
    assert.ok(!message.data.includes('text/html'));
    // Nodemailer may wrap the text using quoted-printable soft line breaks.
    assert.match(message.data.replace(/=\r\n/g, ''), /This is a test email from GitEcho confirming your SMTP configuration works\./);
  });
}

for (const failure of ['authentication', 'send'] as const) {
  test(`SMTP API returns HTTP 400 for real ${failure} rejection`, { timeout: 10_000 }, async (t) => {
    isolateSmtpEnvironment(t);
    const fixture = await startSmtpFixture(t, {
      rejectAuth: failure === 'authentication', rejectData: failure === 'send',
    });
    const response = await post({ ...input, port: fixture.port });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    const body: unknown = await response.json();
    assert.ok(body && typeof body === 'object' && 'ok' in body && 'error' in body);
    assert.equal(body.ok, false);
    assert.equal(typeof body.error, 'string');
    assert.match(String(body.error), failure === 'authentication' ? /535.*Authentication rejected/ : /554.*Message rejected/);
    assert.equal(fixture.messages.length, 0);
    assert.equal(fixture.sessions.length, failure === 'authentication' ? 1 : 2);
    if (failure === 'authentication') {
      assert.ok(!fixture.sessions[0]?.commands.includes('MAIL'));
    } else {
      assert.ok(fixture.sessions[1]?.commands.includes('DATA'));
    }
  });
}
