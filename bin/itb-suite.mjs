#!/usr/bin/env node
// itb-suite — MVP of the ITB test manager authoring loop.
//   compile   Gherkin feature -> ITB test suite zip (local, instant)
//   deploy    compile + POST to /api/rest/testsuite/deploy (replace-in-place)
//   run       deploy + start test case(s) via /api/rest/tests/start
//   status    poll one session
// Config: itb-suite.config.yaml (see itb-suite.config.example.yaml); secrets via env.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileFeature, writeSuite } from '../src/compile.mjs';
import { loadConfig, deploySuite, startTest, testStatus, pollTest } from '../src/itb-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const [cmd, ...args] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { flags[args[i].slice(2)] = args[i + 1]?.startsWith('--') || args[i + 1] === undefined ? true : args[++i]; }
  else positional.push(args[i]);
}

const configPath = flags.config ?? path.join(ROOT, 'itb-suite.config.yaml');

function needConfig() {
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}\nCopy itb-suite.config.example.yaml to itb-suite.config.yaml and fill it in.`);
    process.exit(2);
  }
  return loadConfig(configPath);
}

async function doCompile(featurePath, outDir, zipName) {
  const r = await compileFeature(featurePath);
  if (r.issues?.length) {
    for (const i of r.issues) console.error(`[${i.severity ?? 'issue'}] ${i.message ?? JSON.stringify(i)}`);
    const errors = r.issues.filter(i => (i.severity ?? 'error') === 'error');
    if (errors.length) { console.error(`${errors.length} error(s) — aborting`); process.exit(1); }
  }
  const zip = await writeSuite(r.files, outDir, zipName);
  const suite = r.files.find(f => f.type === 'testsuite');
  const cases = r.files.filter(f => f.type === 'testcase');
  console.log(`compiled: suite '${suite?.id}' with ${cases.length} test case(s), ${r.files.length} file(s)`);
  console.log(`zip: ${zip}`);
  return { zip, suiteId: suite?.id, caseIds: cases.map(c => c.id) };
}

function suiteEntry(cfg) {
  const s = cfg.suites?.[0];
  if (!s) { console.error('No suites[] entry in config'); process.exit(2); }
  return {
    feature: path.resolve(path.dirname(configPath), s.feature),
    out: path.resolve(path.dirname(configPath), s.out ?? 'out/suite'),
    zip: s.zip ?? 'suite.zip',
  };
}

switch (cmd) {
  case 'compile': {
    const feature = positional[0] ?? suiteEntry(needConfig()).feature;
    await doCompile(feature, flags.out ?? 'out/suite', flags.zip ?? 'suite.zip');
    break;
  }
  case 'deploy': {
    const cfg = needConfig();
    const s = suiteEntry(cfg);
    const { zip } = await doCompile(s.feature, s.out, s.zip);
    const res = await deploySuite(cfg, zip);
    const ids = res.identifiers ?? res;
    console.log('deployed:', JSON.stringify(ids, null, 2).slice(0, 1500));
    console.log(`\nView it: ${cfg.instance.baseUrl} -> Domain -> Specification (suite replaced in place)`);
    break;
  }
  case 'run': {
    const cfg = needConfig();
    const s = suiteEntry(cfg);
    const { zip, caseIds } = await doCompile(s.feature, s.out, s.zip);
    await deploySuite(cfg, zip);
    console.log('deployed ok; starting session(s)...');
    const wanted = flags.case ? [flags.case] : caseIds;
    for (const tc of wanted) {
      const { sessionId, raw } = await startTest(cfg, tc);
      if (!sessionId) { console.error('no session id returned:', JSON.stringify(raw)); continue; }
      console.log(`session ${sessionId} started for ${tc}`);
      const st = await pollTest(cfg, sessionId, { timeoutMs: Number(flags.wait ?? 10) * 1000 });
      console.log(`status: ${st.result}`);
      if (String(st.result).toUpperCase() === 'UNDEFINED') {
        console.log(`(interactive steps pending — open ${cfg.instance.baseUrl} as an organisation user`);
        console.log(` and continue the session: Test Sessions -> ${sessionId})`);
      }
    }
    break;
  }
  case 'status': {
    const cfg = needConfig();
    const session = flags.session ?? positional[0];
    if (!session) { console.error('usage: itb-suite status --session <id>'); process.exit(2); }
    const st = await testStatus(cfg, session);
    console.log(st.result, JSON.stringify(st.raw).slice(0, 800));
    break;
  }
  default:
    console.log(`itb-suite (MVP)
usage:
  node bin/itb-suite.mjs compile [feature.feature] [--out dir] [--zip name]
  node bin/itb-suite.mjs deploy  [--config itb-suite.config.yaml]
  node bin/itb-suite.mjs run     [--case <testCaseId>] [--wait <seconds>]
  node bin/itb-suite.mjs status  --session <id>
First: node src/build-compiler.mjs   (one-time, rebuild after workbench parser changes)`);
}
