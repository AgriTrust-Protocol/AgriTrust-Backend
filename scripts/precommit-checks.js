#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { existsSync, readFileSync } = require('node:fs');
const { extname } = require('node:path');

const TEXT_EXTENSIONS = new Set(['.js', '.json', '.md', '.sql', '.ts', '.tsx', '.yaml', '.yml']);
const SECRET_PATTERNS = [
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: 'Generic token assignment', pattern: /(?:api[_-]?key|secret|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{24,}/i },
];

function run(command, args, options = {}) {
  const label = [command, ...args].join(' ');
  console.log(`\n→ ${label}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function getStagedFiles() {
  const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' });
  return output.split('\n').map((file) => file.trim()).filter(Boolean);
}

function isTextFile(file) {
  return TEXT_EXTENSIONS.has(extname(file).toLowerCase());
}

function scanFileForSecrets(file, contents) {
  return SECRET_PATTERNS
    .filter(({ pattern }) => pattern.test(contents))
    .map(({ name }) => `${file}: matched ${name}`);
}

function scanStagedFilesForSecrets(files = getStagedFiles()) {
  const findings = [];
  for (const file of files) {
    if (!existsSync(file) || !isTextFile(file)) continue;
    findings.push(...scanFileForSecrets(file, readFileSync(file, 'utf8')));
  }
  return findings;
}

function main() {
  const findings = scanStagedFilesForSecrets();
  if (findings.length > 0) {
    console.error('\nSecret scan failed:');
    findings.forEach((finding) => console.error(`- ${finding}`));
    process.exit(1);
  }

  if (process.env.AGRITRUST_PRECOMMIT_FULL === '1' || process.argv.includes('--full')) {
    run('npm', ['run', 'build']);
  }
  run('npm', ['test']);
  console.log('\nPre-commit checks passed.');
}

if (require.main === module) {
  main();
}

module.exports = {
  SECRET_PATTERNS,
  getStagedFiles,
  isTextFile,
  scanFileForSecrets,
  scanStagedFilesForSecrets,
};
