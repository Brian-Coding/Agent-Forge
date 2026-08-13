#!/usr/bin/env bun
import { checkCoverageFile } from './check-coverage';

try {
  const totals = await checkCoverageFile(process.argv[2]);
  console.log(
    `Coverage gate passed: ${totals.files} production files, `
    + `${totals.linesHit}/${totals.linesFound} lines (${totals.linePercent.toFixed(2)}%), `
    + `${totals.functionsHit}/${totals.functionsFound} functions (${totals.functionPercent.toFixed(2)}%).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
