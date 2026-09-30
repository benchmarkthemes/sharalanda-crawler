#!/usr/bin/env node
/**
 * Gate before committing generated data. Refuses to pass anything that would
 * corrupt the published files, whatever the cause: conflict markers, invalid
 * JSON, or a suspiciously empty result.
 *
 * Usage: node scripts/validate-data.mjs data/theme-details.json:1000 data/x.json
 *        (the optional :N is a minimum row count for an array)
 */

import { readFile } from 'node:fs/promises';

const CONFLICT_RE = /^(<{7}|={7}|>{7})/m;

async function check(spec) {
  const [file, min] = spec.split(':');
  const problems = [];

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    return [`${file}: cannot read (${err.code ?? err.message})`];
  }

  // Markers first: they are also why the JSON would fail to parse, and saying
  // "conflict markers" is far more useful than a parse error at some offset.
  if (CONFLICT_RE.test(raw)) {
    const count = raw.split('\n').filter((l) => /^(<{7}|={7}|>{7})/.test(l)).length;
    problems.push(`${file}: contains ${count} merge-conflict marker lines`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    problems.push(`${file}: invalid JSON (${err.message.slice(0, 80)})`);
    return problems;
  }

  if (min) {
    if (!Array.isArray(parsed)) {
      problems.push(`${file}: expected an array to count rows against`);
    } else if (parsed.length < Number(min)) {
      problems.push(`${file}: only ${parsed.length} rows, expected at least ${min}`);
    }
  }

  return problems;
}

const specs = process.argv.slice(2);
if (specs.length === 0) {
  console.error('usage: validate-data.mjs <file[:minRows]>...');
  process.exit(2);
}

const problems = (await Promise.all(specs.map(check))).flat();

if (problems.length) {
  console.error('Data validation failed — refusing to commit:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`Validated ${specs.length} file(s): no conflict markers, valid JSON, row counts OK.`);
