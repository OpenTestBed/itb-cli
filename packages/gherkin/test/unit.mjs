// Unit checks for the parts of the language the corpus cannot see: which
// dialects apply (appliesWhen), dialect dependencies (requires), and the
// warnings a feature's @dialect: tags produce. Plain assertions, no runner.
//
//   node test/unit.mjs      exits non-zero on the first failure

import assert from 'node:assert/strict';
import {
  evaluateAppliesWhen, dialectApplies, describeDocument,
  dialectDependencies, checkDependencies, checkRequirements, parseRequirements,
} from '../dist/index.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// ── appliesWhen ────────────────────────────────────────────────────
const passport = describeDocument('p.json', '{"generalProductInformation":{"batteryCategory":"ev"}}');
const patient = describeDocument('pat.json', '{"resourceType":"Patient"}');
const bp = {
  any: [
    { specification: '32023R1542|2023/1542' },
    { document: { pointer: '/generalProductInformation/batteryCategory', exists: true } },
  ],
};

t('describeDocument tells FHIR JSON from plain JSON', () => {
  assert.equal(passport.mediaType, 'application/json');
  assert.equal(patient.mediaType, 'application/fhir+json');
  assert.equal(describeDocument('x.xml', '<Patient xmlns="http://hl7.org/fhir"/>').mediaType, 'application/fhir+xml');
});
t('a specification id matches', () => {
  const r = evaluateAppliesWhen(bp, { specifications: ['CELEX:32023R1542'] });
  assert.equal(r.applies, true);
  assert.match(r.why, /32023R1542/);
});
t('a document pointer matches', () => {
  assert.equal(evaluateAppliesWhen(bp, { documents: [passport] }).applies, true);
});
t('nothing matching says why', () => {
  const r = evaluateAppliesWhen(bp, { specifications: ['http://hl7.org/fhir/uv/ips'], documents: [patient] });
  assert.equal(r.applies, false);
  assert.match(r.why, /no specification matches/);
  assert.match(r.why, /no JSON document has/);
});
t('mediaType, all and not', () => {
  const plainJson = { all: [{ mediaType: 'application/json' }, { not: { mediaType: 'application/fhir+json' } }] };
  assert.equal(evaluateAppliesWhen(plainJson, { documents: [passport] }).applies, true);
  assert.equal(evaluateAppliesWhen(plainJson, { documents: [patient] }).applies, false);
});
t('equals and matches on a pointer', () => {
  assert.equal(evaluateAppliesWhen({ document: { pointer: '/resourceType', equals: 'Patient' } }, { documents: [patient] }).applies, true);
  assert.equal(evaluateAppliesWhen({ document: { pointer: '/resourceType', matches: '^Obs' } }, { documents: [patient] }).applies, false);
});
t('a malformed condition is an error, not "does not apply"', () => {
  assert.throws(() => evaluateAppliesWhen({ fileGlob: '*.json' }, {}), /unrecognised condition "fileGlob"/);
  assert.throws(() => evaluateAppliesWhen({ any: [], all: [] }, {}), /one key per condition/);
});
t('a dialect that declares nothing is undefined, not guessed', () => {
  assert.equal(dialectApplies({}, { documents: [passport] }), undefined);
});

// ── requires ───────────────────────────────────────────────────────
const comp = (id, version, extra = {}) => ({
  manifest: { id, name: id, version: '1', language: { steps: 'steps.yml', version }, ...extra },
  enabled: true, status: 'unknown',
});
const parent = comp('json-policy', '0.1.0');
const child = comp('battery-passport', '0.1.0', { requires: [{ dialect: 'json-policy', version: '^0.1' }] });

t('requires: both forms normalise', () => {
  assert.deepEqual(dialectDependencies({ requires: ['json-policy@^0.1', { dialect: 'x' }, 42] }),
    [{ id: 'json-policy', range: '^0.1' }, { id: 'x', range: undefined }]);
});
t('a child with its parent loaded is fine', () => {
  assert.deepEqual(checkDependencies(child, [parent, child]), { ok: true });
});
t('a missing, disabled or out-of-range parent is reported', () => {
  assert.match(checkDependencies(child, [child]).message, /not loaded/);
  assert.match(checkDependencies(child, [{ ...parent, enabled: false }, child]).message, /disabled/);
  assert.match(checkDependencies(child, [comp('json-policy', '1.0.0'), child]).message, /\^0\.1 — 1\.0\.0/);
});
t('a dialect requiring nothing is undefined', () => {
  assert.equal(checkDependencies(parent, [parent]), undefined);
});

// ── @dialect: tags ─────────────────────────────────────────────────
const core = { id: 'itb-core-en', specVersion: '2.2.0', version: 2, locale: 'en', steps: [] };
const warnings = (tags, comps) => checkRequirements(parseRequirements(tags), core, comps).map(i => i.message);

t('naming the child without its parent warns', () => {
  const w = warnings(['lang:itb-core-en@^2', 'dialect:battery-passport'], [parent, child]);
  assert.equal(w.length, 1);
  assert.match(w[0], /builds on "json-policy" — add @dialect:json-policy@\^0\.1/);
});
t('naming both is silent', () => {
  assert.deepEqual(warnings(['dialect:json-policy', 'dialect:battery-passport'], [parent, child]), []);
});
t('a parent that is not loaded warns from the tags too', () => {
  const w = warnings(['dialect:json-policy', 'dialect:battery-passport'], [child]);
  assert.ok(w.some(m => /requires dialect "json-policy", which is not loaded/.test(m)));
  assert.ok(w.some(m => /builds on "json-policy", which is not loaded/.test(m)));
});

console.log(`unit: ${n} passed`);
