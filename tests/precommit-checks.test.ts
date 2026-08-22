import { describe, expect, it } from 'vitest';

const {
  isTextFile,
  scanFileForSecrets,
  scanStagedFilesForSecrets,
} = require('../scripts/precommit-checks');

describe('precommit checks', () => {
  it('limits secret scanning to repository text files', () => {
    expect(isTextFile('src/cache/cache-service.ts')).toBe(true);
    expect(isTextFile('docs/pre-commit-hooks.md')).toBe(true);
    expect(isTextFile('fixtures/photo.png')).toBe(false);
  });

  it('detects common high-risk secret formats', () => {
    const findings = scanFileForSecrets(
      'config/example.ts',
      ['const ', 'token = ', '"abcdefghijklmnopqrstuvwxyz123456";'].join(''),
    );

    expect(findings).toEqual(['config/example.ts: matched Generic token assignment']);
  });

  it('returns no findings for safe staged files', () => {
    const findings = scanStagedFilesForSecrets(['package.json']);

    expect(findings).toEqual([]);
  });
});
