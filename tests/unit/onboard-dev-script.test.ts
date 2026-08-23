import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const scriptPath = join(root, 'scripts', 'onboard-dev.sh');
const script = readFileSync(scriptPath, 'utf8');

describe('developer onboarding script', () => {
  it('is executable and uses strict shell settings', () => {
    if (process.platform !== 'win32') {
      expect(statSync(scriptPath).mode & 0o111).toBeGreaterThan(0);
    }
    expect(script).toContain('set -euo pipefail');
  });

  it('documents setup options and protects existing env files', () => {
    expect(script).toContain('--skip-install');
    expect(script).toContain('--run-tests');
    expect(script).toContain('--force-env');
    expect(script).toContain('.env already exists; leaving it unchanged');
  });

  it('requires the supported Node.js baseline before installing dependencies', () => {
    expect(script).toContain('require_command node');
    expect(script).toContain('require_command npm');
    expect(script).toContain('Node.js v18 or newer is required');
    expect(script.indexOf('Node.js v18 or newer is required')).toBeLessThan(
      script.indexOf('npm ci'),
    );
  });
});
