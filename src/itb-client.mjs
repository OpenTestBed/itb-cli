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
const WB = path.resolve(here, '../../../test-workbench');
const yaml = createRequire(path.join(WB, 'package.json'))('js-yaml');

/** Load itb-suite.config.yaml with ${ENV_VAR} substitution. */
export function loadConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const substituted = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => process.env[v] ?? '');
  const cfg = yaml.load(substituted);
  cfg.instance ??= {};
  cfg.instance.baseUrl = process.env.ITB_BASE_URL || cfg.instance.baseUrl || 'http://localhost:10003';
  return cfg;
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
