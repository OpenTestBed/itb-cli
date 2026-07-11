// End-to-end test: Gherkin -> compile -> deploy to a RUNNING ITB -> start a
// session -> poll. Needs itb-suite.config.yaml + the env keys it references.
// The ph4h suite has interactive steps (QR upload), so the expected terminal
// state here is: session CREATED and waiting for input (result UNDEFINED) —
// completing it is done by a human in the ITB UI. A non-interactive suite
// would reach SUCCESS/FAILURE within the poll window.
//
// Run: node test/e2e.mjs   (exit 0 = chain works end to end)
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFeature, writeSuite } from '../src/compile.mjs';
import { loadConfig, saveState, deploySuite, startTest, pollTest, resolveFromMaster, ensureDomainAndSpec, actorKeyFromDeploy, ensureOrganisation, ensureSystem, ensureConformance } from '../src/itb-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, '../itb-suite.config.yaml');
if (!fs.existsSync(configPath)) {
  console.error('SKIP e2e: no itb-suite.config.yaml (copy the example and fill in keys)');
  process.exit(2);
}
const cfg = loadConfig(configPath);
await resolveFromMaster(cfg);
await ensureDomainAndSpec(cfg);
const s = cfg.suites[0];
const feature = path.resolve(path.dirname(configPath), s.feature);

// 1. compile
const r = await compileFeature(feature);
const errors = (r.issues ?? []).filter(i => (i.severity ?? 'error') === 'error');
if (errors.length) { console.error('FAIL compile:', JSON.stringify(errors)); process.exit(1); }
const zip = await writeSuite(r.files, path.resolve(path.dirname(configPath), s.out), s.zip);
console.log('1/4 compile      OK ', path.basename(zip));

// 2. deploy (replace-in-place)
const dep = await deploySuite(cfg, zip);
const suiteId = dep.identifiers?.testSuite ?? r.files.find(f => f.type === 'testsuite')?.id;
console.log('2/4 deploy       OK  suite:', suiteId);
(cfg.execution ??= {}).actor ||= actorKeyFromDeploy(dep, 'User');
await ensureOrganisation(cfg);
await ensureSystem(cfg);
if (cfg.execution.system && cfg.execution.actor) await ensureConformance(cfg, cfg.execution.system, cfg.execution.actor);
saveState(cfg);   // persist resolved keys so re-runs reuse instead of re-creating

// 3. start a session for the first test case
const tcId = r.files.find(f => f.type === 'testcase')?.id;
const { sessionId, raw } = await startTest(cfg, tcId);
if (!sessionId) { console.error('FAIL start: no session id:', JSON.stringify(raw).slice(0, 400)); process.exit(1); }
console.log('3/4 start        OK  session:', sessionId);

// 4. poll — for the interactive ph4h suite, UNDEFINED = alive and waiting for the QR upload
const st = await pollTest(cfg, sessionId, { timeoutMs: 8000 });
console.log('4/4 status       OK  result:', st.result);

console.log('\nE2E CHAIN VERIFIED: gherkin -> compile -> deploy -> session running on ITB');
if (String(st.result).toUpperCase() === 'UNDEFINED') {
  console.log(`Complete it interactively: ${cfg.instance.baseUrl} -> log in as an organisation user`);
  console.log(`-> Test Sessions -> session ${sessionId} -> upload the QR (e.g. WHO-ITB/test-data/*.png)`);
}
