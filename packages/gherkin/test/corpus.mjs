// Golden corpus — the regression net for the parser extraction.
//
// WHY THIS EXISTS: before this file there was exactly one test for 2,402 lines
// of compiler. The corpus is the 39 feature files that compile today; the
// snapshots are what they compiled to BEFORE any code moved. Every later phase
// has to reproduce them byte for byte.
//
//   node test/corpus.mjs --update    regenerate snapshots (review the diff!)
//   node test/corpus.mjs             verify — exits non-zero on any drift
//
// The corpus is deliberately SELF-CONTAINED. features/, components/ and
// lang/en.yml are frozen copies, so a snapshot mismatch always means the
// compiler changed — never that someone edited a dialect in another repo.
// components/ is a fixture, not a fourth copy of the dialects: the real ones
// stay canonical in each plugin repo and are synced by sync-dialects.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(here, 'corpus');
const FEATURES = path.join(CORPUS, 'features');
const EXPECTED = path.join(CORPUS, 'expected');

const update = process.argv.includes('--update');

/**
 * The compiler under test. Resolved late and by env var so the same corpus can
 * be pointed at the pre-move pipeline and the extracted package in turn — that
 * is the entire point of a baseline.
 */
// Defaults to the package's OWN implementation so `npm test` is
// self-contained — a published package must not need a sibling checkout to
// test itself. Point CORPUS_IMPL at ../../../src/compile.mjs to replay the
// same snapshots through the CLI adapter instead.
const IMPL = process.env.CORPUS_IMPL ?? './impl-package.mjs';
const { compileFeature } = await import(new URL(IMPL, import.meta.url).href);

function listFeatures() {
  return fs.readdirSync(FEATURES).filter(f => f.endsWith('.feature')).sort();
}

/** Normalise only line endings. Everything else must match exactly — the
 *  transpile is deterministic, so any other difference is a real change. */
const norm = s => s.replace(/\r\n/g, '\n');

let pass = 0, fail = 0, wrote = 0;
const failures = [];

for (const feature of listFeatures()) {
  const featurePath = path.join(FEATURES, feature);
  const outDir = path.join(EXPECTED, feature.replace(/\.feature$/, ''));

  let result;
  try {
    result = await compileFeature(featurePath);
  } catch (err) {
    fail++; failures.push(`${feature}: threw ${err.message}`);
    continue;
  }

  const errors = (result.issues ?? []).filter(i => (i.severity ?? 'error') === 'error');
  if (errors.length) {
    fail++; failures.push(`${feature}: ${errors.length} compile error(s): ${errors[0].message}`);
    continue;
  }

  if (update) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of result.files) {
      const p = path.join(outDir, f.filename);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, norm(f.xml), 'utf8');
      wrote++;
    }
    pass++;
    continue;
  }

  if (!fs.existsSync(outDir)) {
    fail++; failures.push(`${feature}: no snapshot — run with --update`);
    continue;
  }

  // Compare both directions: a file that vanished is as much a regression as
  // one whose content changed.
  const expectedFiles = new Set();
  (function walk(dir, base = outDir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, base);
      else expectedFiles.add(path.relative(base, p).split(path.sep).join('/'));
    }
  })(outDir);

  let bad = null;
  for (const f of result.files) {
    const rel = f.filename.split(path.sep).join('/');
    if (!expectedFiles.delete(rel)) { bad = `unexpected new file ${rel}`; break; }
    const want = norm(fs.readFileSync(path.join(outDir, rel), 'utf8'));
    if (norm(f.xml) !== want) { bad = `content differs in ${rel}`; break; }
  }
  if (!bad && expectedFiles.size) bad = `missing file(s): ${[...expectedFiles].join(', ')}`;

  if (bad) { fail++; failures.push(`${feature}: ${bad}`); } else pass++;
}

if (update) {
  console.log(`snapshots written: ${pass} feature(s), ${wrote} file(s)`);
  if (fail) { console.error(`\n${fail} feature(s) failed to compile:`); failures.forEach(f => console.error('  ' + f)); process.exit(1); }
} else {
  console.log(`corpus: ${pass} passed, ${fail} failed`);
  if (fail) { console.error('\nfailures:'); failures.forEach(f => console.error('  ' + f)); process.exit(1); }
}
