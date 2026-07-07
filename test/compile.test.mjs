// Offline test: the compile pipeline against the real ph4h feature.
// Run: node test/compile.test.mjs   (after: node src/build-compiler.mjs)
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileFeature, writeSuite, WB } from '../src/compile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const feature = path.join(WB, 'public/features/ph4h-qr-integration.feature');

const r = await compileFeature(feature);
const errors = (r.issues ?? []).filter(i => (i.severity ?? 'error') === 'error');
assert.equal(errors.length, 0, `parse errors: ${JSON.stringify(errors)}`);

const suite = r.files.find(f => f.type === 'testsuite');
const cases = r.files.filter(f => f.type === 'testcase');
assert.ok(suite, 'testsuite file generated');
assert.equal(cases.length, 1, 'one test case');

const tc = cases[0].xml;
for (const marker of [
  '/itb/igManager/process',
  '/itb/transform/process',
  'MedicationOverviewMinToMedicationOverviewBundle',
  'ExpressionValidator',                      // the non-empty transform-input guard
  'profiles.ihe.net/PHARM/MEOW/StructureDefinition/MedicationOverview',
]) assert.ok(tc.includes(marker), `testcase XML missing: ${marker}`);

const outDir = path.join(here, '../out/test-run');
fs.rmSync(outDir, { recursive: true, force: true });
const zip = await writeSuite(r.files, outDir, 'suite.zip');
assert.ok(fs.statSync(zip).size > 5000, 'zip has content');

console.log(`PASS compile: ${r.files.length} files, testcase '${cases[0].id}', zip ${fs.statSync(zip).size} bytes`);
