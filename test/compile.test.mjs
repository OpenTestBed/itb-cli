// Offline test: the compile pipeline against the real ph4h feature.
// Run: node test/compile.test.mjs
//
// Pins ITB_ASSET_ROOT at the golden corpus's frozen fixtures. Without it the
// CLI looks for an itb-plugin-authoring checkout beside this repo — fine on a
// developer machine, absent on a CI runner, and the vendored fallback that
// used to cover that case is gone (it was 278 lines behind canonical and
// silently selected). The fixtures are committed, so this test is
// self-contained.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.ITB_ASSET_ROOT ??= path.join(here, '../packages/gherkin/test/corpus');

const { compileFeature, writeSuite } = await import('../src/compile.mjs');
const feature = path.join(here, '../features/ph4h-qr-integration.feature');

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
