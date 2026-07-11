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
import { spawn } from 'node:child_process';
import { loadConfig, saveState, deploySuite, undeploySuite, startTest, testStatus, pollTest, resolveFromMaster, ensureDomainAndSpec, actorKeyFromDeploy, ensureOrganisation, ensureSystem, ensureConformance, browseTree } from '../src/itb-client.mjs';
import { loadIgSource } from '../src/testplan.mjs';

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
  const cfg = loadConfig(configPath);
  // Navigation-driven selection (from `browse`/the manager UI) — no raw env keys needed:
  if (flags.spec)   (cfg.target ??= {}).specification = flags.spec;
  if (flags.system) (cfg.execution ??= {}).system = flags.system;
  if (flags.actor)  (cfg.execution ??= {}).actor = flags.actor;
  return cfg;
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
    await resolveFromMaster(cfg);       // no-ops when keys already known (state/env)
    await ensureDomainAndSpec(cfg);     // no-ops when target.specification is set
    saveState(cfg);
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
    await resolveFromMaster(cfg);                       // master key -> community/org keys
    await ensureDomainAndSpec(cfg);                     // master key -> domain + spec (created if absent)
    const s = suiteEntry(cfg);
    const { zip, caseIds } = await doCompile(s.feature, s.out, s.zip);
    const dep = await deploySuite(cfg, zip);
    console.log('deployed ok');
    // actor key comes free from the deploy response; system auto-created; statement ensured
    (cfg.execution ??= {}).actor ||= actorKeyFromDeploy(dep, cfg.execution?.actorId ?? 'User');
    if (cfg.execution.actor) console.log('actor key (from deploy):', cfg.execution.actor.slice(0,8)+'…');
    await ensureOrganisation(cfg);
    await ensureSystem(cfg);
    if (cfg.execution.system && cfg.execution.actor) await ensureConformance(cfg, cfg.execution.system, cfg.execution.actor);
    saveState(cfg);                                     // later processes reuse, not re-create
    console.log('starting session(s)...');
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
  case 'init': {
    const cfg = needConfig();
    await resolveFromMaster(cfg);
    await ensureDomainAndSpec(cfg);           // also creates the community on fresh installs
    await ensureOrganisation(cfg);
    try { await ensureSystem(cfg); } catch (e) {
      console.warn(`system create: ${e.message}`);
      console.warn('-> fallback: create the system once in the UI (organisation -> Systems),');
      console.warn('   copy its API key, set ITB_SYSTEM_KEY, then re-run init');
    }
    saveState(cfg);                                     // later processes reuse, not re-create
    console.log('init complete. resolved:');
    console.log('  community key   :', cfg.instance.communityApiKey ?? '(none)');
    console.log('  organisation key:', cfg.instance.organisationApiKey ?? '(none)');
    console.log('  specification   :', cfg.target?.specification ?? '(none)');
    console.log('  system key      :', cfg.execution?.system ?? '(none)');
    break;
  }
  case 'undeploy': {
    const cfg = needConfig();
    await resolveFromMaster(cfg);
    await ensureDomainAndSpec(cfg);
    // suite id: --suite <id>, else derived from the configured feature (local compile)
    let suiteId = flags.suite;
    if (!suiteId || suiteId === true) {
      const s = suiteEntry(cfg);
      const r = await compileFeature(s.feature);
      suiteId = r.files.find(f => f.type === 'testsuite')?.id;
    }
    if (!suiteId) { console.error('cannot determine suite id — pass --suite <id>'); process.exit(2); }
    const res = await undeploySuite(cfg, suiteId);
    console.log(`undeployed '${suiteId}':`, JSON.stringify(res).slice(0, 400));
    break;
  }
  case 'testplan': {
    const source = positional[0];
    if (!source) { console.error('usage: itb-suite testplan <pkg.tgz|dir|TestPlan.json|url|name#version> [--import] [--deploy]'); process.exit(2); }
    const { meta, testPlans } = await loadIgSource(source);
    console.log(`source: ${meta.name ?? source} ${meta.version ?? ''} — ${testPlans.length} TestPlan(s)`);
    for (const tp of testPlans) {
      const g = tp.suites.filter(s => s.type === 'gherkin');
      const z = tp.suites.filter(s => s.type === 'itb-zip');
      console.log(`- ${tp.id}${tp.stableId ? ` [${tp.stableId}]` : ''} '${tp.name}' type=${tp.type}` +
        ` gherkin=${g.filter(s => s.gherkin_content).length}/${g.length} zips=${z.filter(s => s.itb_zip_base64).length}/${z.length}`);
    }
    if (!flags.import && !flags.deploy) { console.log('\n(--import writes .feature files into features/; --deploy also deploys each suite)'); break; }

    const cfg = needConfig();
    if (flags.deploy) { await resolveFromMaster(cfg); await ensureDomainAndSpec(cfg); }
    for (const tp of testPlans) {
      const baseName = String(tp.stableId || tp.id || 'testplan').replace(/[^\w.-]/g, '_');
      let i = 0;
      for (const s of tp.suites) {
        i++;
        const suffix = tp.suites.length > 1 ? `-${i}` : '';
        if (s.type === 'gherkin' && s.gherkin_content) {
          const fname = `${baseName}${suffix}.feature`;
          const fpath = path.join(ROOT, 'features', fname);
          fs.writeFileSync(fpath, s.gherkin_content);
          console.log(`imported features/${fname}`);
          if (flags.deploy) {
            const { zip } = await doCompile(fpath, path.join(ROOT, 'out', baseName + suffix), `${baseName}${suffix}.zip`);
            await deploySuite(cfg, zip);
            console.log(`deployed ${fname}`);
          }
        } else if (s.type === 'itb-zip' && s.itb_zip_base64 && flags.deploy) {
          const zpath = path.join(ROOT, 'out', `${baseName}${suffix}-prebuilt.zip`);
          fs.mkdirSync(path.dirname(zpath), { recursive: true });
          fs.writeFileSync(zpath, Buffer.from(s.itb_zip_base64, 'base64'));
          await deploySuite(cfg, zpath);
          console.log(`deployed prebuilt zip for ${tp.id}`);
        } else if (s.type === 'gherkin') {
          console.warn(`SKIP ${tp.id}: gherkin content not found (file ref: ${s.gherkin_file})`);
        }
      }
    }
    if (flags.deploy) saveState(cfg);
    break;
  }
  case 'watch': {
    const cfg0 = needConfig();
    const s = suiteEntry(cfg0);
    const action = flags.run ? 'run' : 'deploy';
    const passthrough = [];
    if (flags.spec) passthrough.push('--spec', flags.spec);
    if (flags.system) passthrough.push('--system', flags.system);
    console.log(`watching ${s.feature}`);
    console.log(`on save -> itb-suite ${action}   (Ctrl+C to stop)`);
    let timer = null, busy = false, pending = false;
    const self = fileURLToPath(import.meta.url);
    const kick = () => {
      if (busy) { pending = true; return; }
      busy = true;
      console.log(`\n--- ${new Date().toLocaleTimeString()} change detected -> ${action} ---`);
      const child = spawn(process.execPath, [self, action, ...passthrough], { cwd: ROOT, stdio: 'inherit' });
      child.on('close', (code) => {
        busy = false;
        console.log(`--- ${action} finished (exit ${code}); watching... ---`);
        if (pending) { pending = false; kick(); }
      });
    };
    fs.watch(s.feature, () => { clearTimeout(timer); timer = setTimeout(kick, 400); });
    kick();                                   // run once at start
    await new Promise(() => {});              // keep alive
  }
  case 'browse': {
    const cfg = needConfig();
    await resolveFromMaster(cfg);
    const tree = await browseTree(cfg);
    console.log('___BROWSE_JSON___');       // marker so UIs can split logs from data
    console.log(JSON.stringify(tree, null, 2));
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
  node bin/itb-suite.mjs init    # fresh instance: creates domain+spec, resolves keys
  node bin/itb-suite.mjs deploy  [--config itb-suite.config.yaml]
  node bin/itb-suite.mjs run     [--case <testCaseId>] [--wait <seconds>]
  node bin/itb-suite.mjs watch   [--run]  # feature save -> auto deploy (or deploy+run)
  node bin/itb-suite.mjs undeploy [--suite <id>]  # remove the suite from the spec
  node bin/itb-suite.mjs testplan <src> [--import] [--deploy]  # FHIR TestPlan / IG package
  node bin/itb-suite.mjs browse  # instance tree (domain, specs, orgs, systems) as JSON
  node bin/itb-suite.mjs status  --session <id>
Selection flags (override config/state): --spec <key> --system <key> --actor <key>
First: node src/build-compiler.mjs   (one-time, rebuild after workbench parser changes)`);
}
