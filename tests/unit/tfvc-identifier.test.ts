import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTfvcIdentifier,
  parseTfvcIdentifier,
  safeTfvcName,
  tfvcDisplayName,
} from '../../src/lib/tfvc-identifier.ts';

describe('parseTfvcIdentifier', () => {
  it('parses a canonical identifier with an encoded path', () => {
    const id =
      'tfvc://dev.azure.com/contoso/PaymentsApp?path=' +
      encodeURIComponent('$/PaymentsApp/Main');
    const ref = parseTfvcIdentifier(id);
    assert.ok(ref);
    assert.equal(ref.org, 'contoso');
    assert.equal(ref.project, 'PaymentsApp');
    assert.equal(ref.path, '$/PaymentsApp/Main');
    assert.equal(ref.url, id);
  });

  it('returns undefined for non-tfvc schemes', () => {
    assert.equal(
      parseTfvcIdentifier('https://dev.azure.com/contoso/PaymentsApp/_git/repo'),
      undefined,
    );
  });

  it('returns undefined for the wrong host', () => {
    assert.equal(
      parseTfvcIdentifier('tfvc://example.com/contoso/proj?path=%24%2Fproj'),
      undefined,
    );
  });

  it('returns undefined when the path query is missing', () => {
    assert.equal(parseTfvcIdentifier('tfvc://dev.azure.com/contoso/proj'), undefined);
  });

  it('returns undefined when org or project is missing', () => {
    assert.equal(parseTfvcIdentifier('tfvc://dev.azure.com/contoso?path=%24'), undefined);
  });
});

describe('buildTfvcIdentifier', () => {
  it('round-trips through parseTfvcIdentifier', () => {
    const id = buildTfvcIdentifier('contoso', 'PaymentsApp', '$/PaymentsApp/Main');
    const ref = parseTfvcIdentifier(id);
    assert.ok(ref);
    assert.equal(ref.org, 'contoso');
    assert.equal(ref.project, 'PaymentsApp');
    assert.equal(ref.path, '$/PaymentsApp/Main');
  });

  it('trims trailing slashes so equivalent paths produce one identifier', () => {
    assert.equal(
      buildTfvcIdentifier('o', 'p', '$/p/Main/'),
      buildTfvcIdentifier('o', 'p', '$/p/Main'),
    );
  });

  it('encodes special characters in org and project', () => {
    const id = buildTfvcIdentifier('my org', 'a/b', '$/x');
    const ref = parseTfvcIdentifier(id);
    assert.ok(ref);
    assert.equal(ref.org, 'my org');
    assert.equal(ref.project, 'a/b');
  });
});

describe('tfvcDisplayName', () => {
  it('uses the last path segment', () => {
    assert.equal(tfvcDisplayName('$/PaymentsApp/Main', 'PaymentsApp'), 'Main');
  });

  it('falls back to the project name for a root path', () => {
    assert.equal(tfvcDisplayName('$/', 'PaymentsApp'), 'PaymentsApp');
  });

  it('ignores the leading $ segment', () => {
    assert.equal(tfvcDisplayName('$/PaymentsApp', 'fallback'), 'PaymentsApp');
  });
});

describe('safeTfvcName', () => {
  it('collapses disallowed characters to underscores', () => {
    assert.equal(safeTfvcName('My Project/Main'), 'My_Project_Main');
  });

  it('trims leading and trailing underscores', () => {
    assert.equal(safeTfvcName('///abc///'), 'abc');
  });

  it('falls back to "tfvc" when nothing usable remains', () => {
    assert.equal(safeTfvcName('///'), 'tfvc');
  });
});
