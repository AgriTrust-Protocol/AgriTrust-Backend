import { readFileSync } from 'fs';
import { evaluatePerformanceSuite, PerformanceSample } from '../src/performance/regression';

const reportPath = process.argv[2] || process.env.PERFORMANCE_REPORT_PATH;

if (!reportPath) {
  console.error('Usage: npx ts-node scripts/check-performance-regression.ts <performance-report.json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as { samples?: PerformanceSample[] } | PerformanceSample[];
const samples = Array.isArray(report) ? report : report.samples ?? [];
const result = evaluatePerformanceSuite(samples);

if (!result.passed) {
  console.error('Performance regression detected:');
  for (const violation of result.violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Performance budget passed for ${samples.length} critical path(s).`);
