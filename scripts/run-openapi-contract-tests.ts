import { spawn } from 'child_process';

const vitest = spawn('npx', ['vitest', 'run', 'tests/unit/openapi-validator.test.ts'], {
  stdio: 'inherit',
  shell: false,
});

vitest.on('exit', (code) => {
  process.exit(code ?? 1);
});
