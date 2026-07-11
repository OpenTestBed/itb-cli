// Minimal ITB REST client for the itb-suite MVP.
// Endpoints per ITB REST API (https://www.itb.ec.europa.eu/docs/itb-ta/latest/api/):
//   POST /api/rest/testsuite/deploy   (community key)  — deploy/replace suite zip
//   POST /api/rest/tests/start        (organisation key) — start a session
//   POST /api/rest/tests/status       (organisation key) — poll a session
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
function findWorkbench(fromDir) {
  const candidates = [
    process.env.ITB_WORKBENCH_PATH,
    path.resolve(fromDir, '../itb-plugin-authoring/app'), // in-ecosystem authoring plugin (canonical)
    path.resolve(fromDir, '../../test-workbench'),   // legacy sibling checkout
    path.resolve(fromDir, '../test-workbench'),      // flat clone layout
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'src/parser/gherkinParser.ts'))) return c;
  return null; // standalone: vendored deps
}
const WB = findWorkbench(path.resolve(here, '..'));
const DEPS = (WB && fs.existsSync(path.join(WB, 'node_modules', 'js-yaml'))) ? WB : path.resolve(here, '../vendor');
const yaml = createRequire(path.join(DEPS, 'package.json'))('js-yaml');

/** Load itb-suite.config.yaml with ${ENV_VAR} substitution.
 *  Also merges .itb-state.json (keys persisted by a previous init/run in
 *  another process) — ITB has no community-listing API, so without this each
 *  process would re-create the community/org/system it cannot find.
 *  Precedence: explicit config/env values win over persisted state. */
export function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const substituted = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => process.env[v] ?? '');
  const cfg = yaml.load(substituted);
  cfg.instance ??= {};
  cfg.instance.baseUrl = process.env.ITB_BASE_URL || cfg.instance.baseUrl || 'http://localhost:10003';
  cfg.__statePath = path.join(path.dirname(configPath), '.itb-state.json');
  try {
    const st = JSON.parse(fs.readFileSync(cfg.__statePath, 'utf8'));
    // Keys are instance-scoped, not address-scoped: the same ITB is
    // http://localhost:10003 on the host and http://gitb-ui:9000 inside the
    // authoring container — share the state, warn on the address difference.
    if (st.baseUrl && st.baseUrl !== cfg.instance.baseUrl) {
      console.warn(`(state written for ${st.baseUrl}, reusing for ${cfg.instance.baseUrl} — delete .itb-state.json if these are NOT the same ITB instance)`);
    }
    cfg.instance.communityApiKey ||= st.communityApiKey;
    cfg.instance.organisationApiKey ||= st.organisationApiKey;
    (cfg.target ??= {}).specification ||= st.specification;
    (cfg.execution ??= {}).system ||= st.system;
    cfg.execution.actor ||= st.actor;
    console.log(`(resumed keys from ${path.basename(cfg.__statePath)} — delete it to re-bootstrap)`);
  } catch { /* no state yet */ }
  return cfg;
}

/** Persist resolved keys so later processes reuse them instead of re-creating
 *  entities. reset.ps1 deletes this file (a wiped instance invalidates keys). */
export function saveState(cfg) {
  if (!cfg.__statePath) return;
  const st = {
    baseUrl: cfg.instance.baseUrl,
    communityApiKey: cfg.instance.communityApiKey || undefined,
    organisationApiKey: cfg.instance.organisationApiKey || undefined,
    specification: cfg.target?.specification || undefined,
    system: cfg.execution?.system || undefined,
    actor: cfg.execution?.actor || undefined,
  };
  fs.writeFileSync(cfg.__statePath, JSON.stringify(st, null, 2));
}

function base(cfg) { return cfg.instance.baseUrl.replace(/\/+$/, ''); }

async function jsonOrText(resp) {
  const text = await resp.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/** Deploy (or replace, updateSpecification=true) a suite zip into a specification. */
export async function deploySuite(cfg, zipPath) {
  const communityKey = cfg.instance.communityApiKey;
  const specification = cfg.target?.specification;
  if (!communityKey) throw new Error('Missing instance.communityApiKey (env ITB_COMMUNITY_KEY)');
  if (!specification) throw new Error('Missing target.specification (env ITB_SPEC_KEY)');

  const form = new FormData();
  form.append('specification', specification);
  form.append('updateSpecification', 'true');
  const buf = fs.readFileSync(zipPath);
  form.append('testSuite', new Blob([buf], { type: 'application/zip' }), path.basename(zipPath));

  const resp = await fetch(`${base(cfg)}/api/rest/testsuite/deploy`, {
    method: 'POST',
    headers: { ITB_API_KEY: communityKey },
    body: form,
  });
  const data = await jsonOrText(resp);
  if (!resp.ok) throw new Error(`deploy failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data; // includes identifiers (testSuite, specifications[].actors, testCases)
}

/** Undeploy (remove) a test suite from a specification.
 *  ITB REST: POST /api/rest/testsuite/undeploy, community key,
 *  body = { testSuite: <suite identifier>, specification: <spec API key> }. */
export async function undeploySuite(cfg, suiteId) {
  const communityKey = cfg.instance.communityApiKey;
  const specification = cfg.target?.specification;
  if (!communityKey) throw new Error('Missing instance.communityApiKey (run init first)');
  if (!specification) throw new Error('Missing target.specification (run init first, or --spec)');
  const resp = await fetch(`${base(cfg)}/api/rest/testsuite/undeploy`, {
    method: 'POST',
    headers: { ITB_API_KEY: communityKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ testSuite: suiteId, specification }),
  });
  const data = await jsonOrText(resp);
  if (!resp.ok) throw new Error(`undeploy failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

/** Start one test case session. Returns { sessionId, raw }. */
export async function startTest(cfg, testCaseId) {
  const orgKey = cfg.instance.organisationApiKey;
  const { system, actor } = cfg.execution ?? {};
  if (!orgKey) throw new Error('Missing instance.organisationApiKey (env ITB_ORG_KEY)');
  if (!system || !actor) throw new Error('Missing execution.system / execution.actor (env ITB_SYSTEM_KEY / ITB_ACTOR_KEY)');

  const resp = await fetch(`${base(cfg)}/api/rest/tests/start`, {
    method: 'POST',
    headers: { ITB_API_KEY: orgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ testCase: testCaseId, system, actor, forceSequentialExecution: true }),
  });
  const data = await jsonOrText(resp);
  if (!resp.ok) throw new Error(`tests/start failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 500)}`);
  const sessionId = data.sessionId ?? data.session ?? data.createdSessions?.[0]?.session ?? null;
  return { sessionId, raw: data };
}

/** One status check. Returns { result, raw } — result UNDEFINED while running/awaiting input. */
export async function testStatus(cfg, sessionId) {
  const orgKey = cfg.instance.organisationApiKey;
  const resp = await fetch(`${base(cfg)}/api/rest/tests/status`, {
    method: 'POST',
    headers: { ITB_API_KEY: orgKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId, withLogs: false }),
  });
  const data = await jsonOrText(resp);
  if (!resp.ok) throw new Error(`tests/status failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return { result: data.result ?? data.status ?? 'UNDEFINED', raw: data };
}

/** Poll until a final verdict or timeout. Interactive suites stay UNDEFINED
 *  until a user supplies inputs in the ITB UI — that is expected. */
export async function pollTest(cfg, sessionId, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { result: 'UNDEFINED' };
  while (Date.now() < deadline) {
    last = await testStatus(cfg, sessionId);
    if (last.result && !['UNDEFINED', 'RUNNING', 'PENDING'].includes(String(last.result).toUpperCase())) return last;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return last;
}

// ---------------------------------------------------------------------------
// Key auto-resolution — start from as few keys as possible.
//   masterApiKey  -> communities (find community by name -> its key + org keys)
//   communityKey  -> deploy; deploy RESPONSE carries the spec's actor API keys
//   communityKey  -> create system (PUT /system, org key in the body)
//   communityKey  -> ensure conformance statement (PUT /conformance/{sys}/{actor})
// Field names differ slightly across ITB versions — helpers probe candidates
// and log what they found, so mismatches are visible instead of silent.
// ---------------------------------------------------------------------------

function pick(obj, ...names) {
  for (const n of names) if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n];
  return undefined;
}
const norm = s => String(s ?? '').trim().toLowerCase();

async function apiGet(cfg, path, key) {
  const resp = await fetch(`${base(cfg)}${path}`, { headers: { ITB_API_KEY: key } });
  const data = await jsonOrText(resp);
  if (!resp.ok) throw new Error(`GET ${path}: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

/** Resolve community + organisation keys by name using only the master key. */
export async function resolveFromMaster(cfg) {
  const masterKey = cfg.instance.masterApiKey || process.env.ITB_MASTER_KEY;
  if (!masterKey) return cfg;
  const wantCommunity = norm(cfg.bootstrap?.community ?? cfg.instance.communityName);
  try {
    const data = await apiGet(cfg, '/api/rest/communities', masterKey);
    const list = Array.isArray(data) ? data : (data.communities ?? data.items ?? []);
    const match = list.find(c => !wantCommunity || [pick(c,'shortName'), pick(c,'fullName'), pick(c,'name')].map(norm).includes(wantCommunity)) ?? list[0];
    if (match) {
      cfg.instance.communityApiKey ||= pick(match, 'apiKey', 'key');
      console.log(`resolved community '${pick(match,'shortName','fullName','name')}' -> key ${cfg.instance.communityApiKey?.slice(0,8)}…`);
      const orgs = pick(match, 'organisations', 'organizations') ?? [];
      const wantOrg = norm(cfg.bootstrap?.organisation);
      const org = orgs.find(o => !wantOrg || [pick(o,'shortName'), pick(o,'fullName')].map(norm).includes(wantOrg)) ?? orgs[0];
      if (org) {
        cfg.instance.organisationApiKey ||= pick(org, 'apiKey', 'key');
        console.log(`resolved organisation '${pick(org,'shortName','fullName')}' -> key ${cfg.instance.organisationApiKey?.slice(0,8)}…`);
      }
    }
  } catch (e) {
    console.warn(`community listing not available via master key (${e.message.slice(0,120)})`);
    console.warn('-> set ITB_COMMUNITY_KEY from the UI (Community management -> API keys); org is then auto-created');
  }
  return cfg;
}

/** Pull the SUT actor's API key out of a deploy response. */
export function actorKeyFromDeploy(deployResult, actorId) {
  const specs = deployResult?.identifiers?.specifications ?? [];
  for (const s of specs) for (const a of s.actors ?? []) {
    const key = pick(a, 'identifier', 'apiKey', 'key');
    const id = pick(a, 'id', 'actorId', 'name');
    if (key && (!actorId || norm(id) === norm(actorId) || norm(key) === norm(actorId))) return key;
  }
  return null;
}

/** Ensure a system exists.
 *  Per the API docs, createSystem authorises with the COMMUNITY key in the
 *  ITB-API-KEY header; the target organisation's key goes in the BODY.
 *  (Sending the org key in the header yields 403 "not allowed to manage
 *  systems through the automation API" — there is no UI toggle for this.) */
export async function ensureSystem(cfg, name = 'itb-suite-sut') {
  if (cfg.execution?.system) return cfg.execution.system;
  const resp = await fetch(`${base(cfg)}/api/rest/system`, {
    method: 'PUT',
    headers: { ITB_API_KEY: cfg.instance.communityApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shortName: name, fullName: name,
      description: 'Auto-created by itb-suite', version: '1.0',
      organisation: cfg.instance.organisationApiKey,
    }),
  });
  const data = await jsonOrText(resp);
  if (!resp.ok) throw new Error(`system create failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`);
  const key = pick(data, 'apiKey', 'key');
  console.log(`system '${name}' -> key ${key?.slice(0,8)}…`);
  (cfg.execution ??= {}).system = key;
  return key;
}

/** Ensure a conformance statement binds the system to the actor.
 *  Community key first (community-scoped management op), org key as fallback. */
export async function ensureConformance(cfg, systemKey, actorKey) {
  for (const key of [cfg.instance.communityApiKey, cfg.instance.organisationApiKey]) {
    if (!key) continue;
    const resp = await fetch(`${base(cfg)}/api/rest/conformance/${systemKey}/${actorKey}`, {
      method: 'PUT', headers: { ITB_API_KEY: key },
    });
    if (resp.ok) { console.log('conformance statement ok'); return true; }
    console.warn(`conformance PUT (${key === cfg.instance.communityApiKey ? 'community' : 'org'} key): HTTP ${resp.status}`);
  }
  console.warn('conformance statement not confirmed (may already exist — continuing)');
  return false;
}

/** Ensure domain + specification exist (create via master key if missing) and
 *  set cfg.target.specification to the spec's API key. Names come from
 *  cfg.bootstrap: { domain, specification }. Fresh-instance path: ONE key. */
export async function ensureDomainAndSpec(cfg) {
  const masterKey = cfg.instance.masterApiKey || process.env.ITB_MASTER_KEY;
  const wantDomain = cfg.bootstrap?.domain;
  const wantSpec = cfg.bootstrap?.specification;
  if (cfg.target?.specification) return cfg;                       // explicit key wins
  if (!masterKey || !wantDomain || !wantSpec) return cfg;

  const findByName = (list, name) =>
    (Array.isArray(list) ? list : (list?.items ?? list?.domains ?? list?.specifications ?? []))
      .find(x => [pick(x,'shortName'), pick(x,'fullName'), pick(x,'name')].map(norm).includes(norm(name)));

  // 1. domain: find or create
  let domain;
  try { domain = findByName(await apiGet(cfg, '/api/rest/domains', masterKey), wantDomain); } catch { /* fallthrough */ }
  if (!domain) {
    const resp = await fetch(`${base(cfg)}/api/rest/domain`, {
      method: 'PUT', headers: { ITB_API_KEY: masterKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortName: wantDomain, fullName: wantDomain, description: 'Created by itb-suite init' }),
    });
    const data = await jsonOrText(resp);
    if (!resp.ok) throw new Error(`domain create failed: HTTP ${resp.status}: ${JSON.stringify(data).slice(0,300)}`);
    domain = { shortName: wantDomain, apiKey: pick(data, 'apiKey', 'key') };
  }
  const domainKey = pick(domain, 'apiKey', 'key');
  console.log(`domain '${wantDomain}' -> key ${domainKey?.slice(0,8)}…`);

  // 1b. community: a FRESH install has none — create one via the master key,
  // linked to the domain (community-scoped ops like spec management need it).
  if (!cfg.instance.communityApiKey) {
    const cname = cfg.bootstrap?.community ?? 'itb-suite';
    for (const [method, body] of [
      ['PUT',  { shortName: cname, fullName: cname, domain: domainKey }],
      ['POST', { shortName: cname, fullName: cname, domain: domainKey }],
      ['PUT',  { shortName: cname, fullName: cname }],   // some versions reject domain at create
    ]) {
      const resp = await fetch(`${base(cfg)}/api/rest/community`, {
        method, headers: { ITB_API_KEY: masterKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await jsonOrText(resp);
      if (resp.ok) {
        cfg.instance.communityApiKey = pick(data, 'apiKey', 'key');
        console.log(`community '${cname}' created (${method}) -> key ${cfg.instance.communityApiKey?.slice(0,8)}…`);
        if (!('domain' in body)) console.warn('NOTE: community created WITHOUT domain link — link it to the domain in the UI (community edit) before deploying');
        break;
      }
      console.warn(`community create ${method}${'domain' in body ? '+domain' : ''}: HTTP ${resp.status}: ${JSON.stringify(data).slice(0,200)}`);
    }
    if (!cfg.instance.communityApiKey) console.warn('could not create community via API — create it in the UI and set ITB_COMMUNITY_KEY');
  }

  // 2. specification under the domain: find or create
  let spec;
  try { spec = findByName(await apiGet(cfg, `/api/rest/domain/${domainKey}/specifications`, masterKey), wantSpec); } catch { /* fallthrough */ }
  if (!spec) {
    // Spec management is COMMUNITY-scoped in current ITB (master key gets 403,
    // observed live) — try the community key first when available.
    for (const key of [cfg.instance.communityApiKey, masterKey].filter(Boolean)) {
      const resp = await fetch(`${base(cfg)}/api/rest/specification`, {
        method: 'PUT', headers: { ITB_API_KEY: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortName: wantSpec, fullName: wantSpec, domain: domainKey, description: 'Created by itb-suite init' }),
      });
      const data = await jsonOrText(resp);
      if (resp.ok) { spec = { shortName: wantSpec, apiKey: pick(data, 'apiKey', 'key') }; break; }
      console.warn(`specification create with key ${key.slice(0,8)}…: HTTP ${resp.status}: ${JSON.stringify(data).slice(0,200)}`);
    }
    if (!spec) throw new Error(
      'could not create specification. Fix (one-time, in the ITB UI): ' +
      '1) Community management -> your community -> API keys -> copy the community key ' +
      'and set ITB_COMMUNITY_KEY; 2) edit the community and LINK it to the domain; ' +
      '3) re-run init.');
  }
  (cfg.target ??= {}).specification = pick(spec, 'apiKey', 'key');
  console.log(`specification '${wantSpec}' -> key ${cfg.target.specification?.slice(0,8)}…`);
  return cfg;
}

/** Browse the instance as a navigable tree using the COMMUNITY key only —
 *  no raw keys needed by the caller. Verified endpoints: getOrganisations
 *  (GET /api/rest/organisation) and getSystems
 *  (GET /api/rest/organisation/{org}/systems), both community-key scoped;
 *  the domain/specification listings are probed defensively. */
export async function browseTree(cfg) {
  const ck = cfg.instance.communityApiKey;
  if (!ck) throw new Error('no community key resolved — run init first (or set ITB_COMMUNITY_KEY)');
  const out = { baseUrl: cfg.instance.baseUrl, domain: null, specifications: [], organisations: [] };

  // domain linked to the community (getCommunityDomain convention)
  try {
    const d = await apiGet(cfg, '/api/rest/domain', ck);
    const dom = Array.isArray(d) ? d[0] : d;
    if (dom) out.domain = { name: pick(dom, 'shortName', 'fullName', 'name'), apiKey: pick(dom, 'apiKey', 'key') };
  } catch (e) { out.domainError = e.message.slice(0, 200); }

  const domainKey = out.domain?.apiKey;
  const specPaths = domainKey
    ? [`/api/rest/domain/${domainKey}/specifications`, '/api/rest/specification']
    : ['/api/rest/specification'];
  for (const p of specPaths) {
    try {
      const s = await apiGet(cfg, p, ck);
      const list = Array.isArray(s) ? s : (s?.items ?? s?.specifications ?? []);
      out.specifications = list.map(x => ({ name: pick(x, 'shortName', 'fullName', 'name'), apiKey: pick(x, 'apiKey', 'key') }));
      break;
    } catch { /* try next candidate */ }
  }

  try {
    const o = await apiGet(cfg, '/api/rest/organisation', ck);
    const orgs = Array.isArray(o) ? o : (o?.items ?? []);
    for (const org of orgs) {
      const entry = { name: pick(org, 'shortName', 'fullName'), apiKey: pick(org, 'apiKey', 'key'), systems: [] };
      try {
        const sys = await apiGet(cfg, `/api/rest/organisation/${entry.apiKey}/systems`, ck);
        const list = Array.isArray(sys) ? sys : (sys?.items ?? []);
        entry.systems = list.map(x => ({ name: pick(x, 'shortName', 'fullName'), apiKey: pick(x, 'apiKey', 'key'), version: pick(x, 'version') }));
      } catch (e) { entry.systemsError = e.message.slice(0, 200); }
      out.organisations.push(entry);
    }
  } catch (e) { out.organisationsError = e.message.slice(0, 200); }

  out.current = {
    specification: cfg.target?.specification ?? null,
    system: cfg.execution?.system ?? null,
    actor: cfg.execution?.actor ?? null,
  };
  return out;
}

/** Ensure an organisation exists (create via community key if missing). */
export async function ensureOrganisation(cfg, name = 'itb-suite-org') {
  if (cfg.instance.organisationApiKey) return cfg.instance.organisationApiKey;
  if (!cfg.instance.communityApiKey) return null;
  const resp = await fetch(`${base(cfg)}/api/rest/organisation`, {
    method: 'PUT',
    headers: { ITB_API_KEY: cfg.instance.communityApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shortName: cfg.bootstrap?.organisation ?? name, fullName: cfg.bootstrap?.organisation ?? name }),
  });
  const data = await jsonOrText(resp);
  if (!resp.ok) { console.warn(`organisation create: HTTP ${resp.status}: ${JSON.stringify(data).slice(0,200)}`); return null; }
  cfg.instance.organisationApiKey = pick(data, 'apiKey', 'key');
  console.log(`organisation -> key ${cfg.instance.organisationApiKey?.slice(0,8)}…`);
  return cfg.instance.organisationApiKey;
}
