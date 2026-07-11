// FHIR TestPlan support — ported from itb-test-manager (vite.config.ts IG
// import + parseTestPlan). Zero npm deps: gunzip via node:zlib, tar via a
// minimal built-in reader.
//
// Sources accepted by loadIgSource():
//   - local .tgz            (an IG package archive)
//   - local directory       (an unpacked package/ or IG output folder)
//   - local TestPlan-*.json (a single resource; sibling files searched for .feature)
//   - http(s) URL           (a .tgz, or an IG base URL -> + /package.tgz)
//   - name#version          (resolved via packages.fhir.org)
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

/** Canonical namespace for stable cross-import identifiers (same as itb-test-manager). */
export const STABLE_ID_SYSTEM = 'http://smart-architecture/placeholder/actorids';

/** Minimal tar reader: 512-byte headers, octal sizes, ustar prefix + GNU longname. */
export function untar(buf) {
  const files = {};
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every(b => b === 0)) break;                    // end-of-archive
    const str = (start, len) => block.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '');
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(block[156] || 48);
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/, ''); }
    else {
      if (longName) { name = longName; longName = null; }
      if (type === '0' || type === '\0' || type === ' ') files[name] = Buffer.from(data);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function looksLikeGherkin(t) {
  return typeof t === 'string' && /Feature\s*:/.test(t) && /^\s*(Given|When|Then|Scenario|Background)/m.test(t);
}
function decodeBinaryToGherkin(b64) {
  try { return Buffer.from(String(b64), 'base64').toString('utf8'); } catch { return ''; }
}
function stableIdOf(resource) {
  const ids = Array.isArray(resource?.identifier) ? resource.identifier : [];
  for (const i of ids) if (i && i.system === STABLE_ID_SYSTEM && i.value) return String(i.value);
  return '';
}

/** Port of itb-test-manager's parseTestPlan (log noise removed). */
export function parseTestPlan(data, binaries = {}, rawFiles = {}) {
  const scope = (data.scope || []).filter(s => s.reference).map(s => ({ reference: s.reference, description: s.description || '' }));
  const parameters = (data.parameter || []).map(p => ({ name: p.name || '', value: p.valueString || '', mode: p.mode || '' }));
  const stableId = stableIdOf(data);

  const suites = (data.suite || []).map(s => {
    let gherkinFile = '', gherkinContent = '', itbZipFile = '', itbZipBase64 = '';
    let suiteType = 'unknown';

    for (const inp of (s.input || [])) {
      if (inp.name === 'gherkin-script') {
        suiteType = 'gherkin';
        gherkinFile = inp.file || '';
        const bRef = inp.sourceReference?.reference || '';
        if (bRef.startsWith('Binary/')) {
          const bid = bRef.split('/')[1];
          if (binaries[bid]?.data) {
            const candidate = decodeBinaryToGherkin(binaries[bid].data);
            if (looksLikeGherkin(candidate)) gherkinContent = candidate;
          }
        }
      } else if (inp.name === 'itb-test-suite') {
        suiteType = 'itb-zip';
        itbZipFile = inp.file || '';
      }
    }

    if (suiteType === 'gherkin' && !gherkinContent && gherkinFile) {
      const stem = path.parse(gherkinFile).name;
      for (const [bid, bdata] of Object.entries(binaries)) {
        if ((stem.includes(bid) || bid.includes(stem)) && bdata.data) {
          const candidate = decodeBinaryToGherkin(bdata.data);
          if (looksLikeGherkin(candidate)) { gherkinContent = candidate; break; }
        }
      }
      if (!gherkinContent) {
        for (const [fname, buf] of Object.entries(rawFiles)) {
          if (fname.endsWith(gherkinFile) || fname.endsWith(`/${gherkinFile}`) || fname.endsWith(`/${stem}.feature`)) {
            gherkinContent = buf.toString('utf8');
            break;
          }
        }
      }
    }

    if (suiteType === 'itb-zip' && itbZipFile) {
      const zipStem = path.parse(itbZipFile).name;
      for (const [bid, bdata] of Object.entries(binaries)) {
        if ((zipStem.includes(bid) || bid.includes(zipStem)) && bdata.data) { itbZipBase64 = bdata.data; break; }
      }
      if (!itbZipBase64) {
        for (const [fname, buf] of Object.entries(rawFiles)) {
          if (fname.endsWith(itbZipFile) || fname.endsWith(`/${itbZipFile}`)) { itbZipBase64 = buf.toString('base64'); break; }
        }
      }
    }

    const tests = (s.test || []).map(t => ({ name: t.name || '', description: t.description || '' }));
    return { name: s.name || '', description: s.description || '', type: suiteType,
             gherkin_file: gherkinFile, gherkin_content: gherkinContent,
             itb_zip_file: itbZipFile, itb_zip_base64: itbZipBase64, tests };
  });

  const types = suites.map(s => s.type).filter(t => t !== 'unknown');
  const testPlanType = types.includes('itb-zip') ? 'itb-zip' : types.includes('gherkin') ? 'gherkin' : 'unknown';

  return {
    id: data.id || '', name: data.title || data.name || data.id || '', description: data.description || '',
    url: data.url || '', scope, parameters, suites, type: testPlanType, stableId,
  };
}

function walkDir(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules' && entry.name !== '.git') walkDir(full, base, out); }
    else out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full);
  }
  return out;
}

function scanFiles(files) {
  const binaries = {};
  for (const [name, buf] of Object.entries(files)) {
    if (name.includes('Binary-') && name.endsWith('.json')) {
      try { const d = JSON.parse(buf.toString('utf8')); if (d.resourceType === 'Binary') binaries[d.id || ''] = d; } catch { /* skip */ }
    }
  }
  const testPlans = [];
  for (const [name, buf] of Object.entries(files)) {
    if (name.includes('TestPlan-') && name.endsWith('.json')) {
      try {
        const d = JSON.parse(buf.toString('utf8'));
        if (d.resourceType === 'TestPlan') {
          const tp = parseTestPlan(d, binaries, files);
          if (!testPlans.some(x => x.id === tp.id)) testPlans.push(tp);
        }
      } catch { /* skip */ }
    }
  }
  let meta = {};
  for (const key of ['package/package.json', 'package.json']) {
    if (files[key]) { try { meta = JSON.parse(files[key].toString('utf8')); } catch { /* skip */ } break; }
  }
  return { meta: { name: meta.name, version: meta.version, canonical: meta.canonical, fhirVersion: meta.fhirVersion }, testPlans };
}

/** Load any supported source and return { meta, testPlans }. */
export async function loadIgSource(source) {
  // local single TestPlan json
  if (fs.existsSync(source) && source.endsWith('.json')) {
    const data = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (data.resourceType !== 'TestPlan') throw new Error(`${source} is not a FHIR TestPlan`);
    const rawFiles = walkDir(path.dirname(source));
    return { meta: { name: '(single resource)' }, testPlans: [parseTestPlan(data, {}, rawFiles)] };
  }
  // local directory (unpacked package)
  if (fs.existsSync(source) && fs.statSync(source).isDirectory()) {
    return scanFiles(walkDir(source));
  }
  // local tgz
  if (fs.existsSync(source)) {
    return scanFiles(untar(gunzipSync(fs.readFileSync(source))));
  }
  // remote: name#version or URL
  let url = source;
  if (url.includes('#') && !url.startsWith('http')) {
    const [name, version] = url.split('#', 2);
    url = `https://packages.fhir.org/${name}/${version}`;
  }
  if (!url.endsWith('.tgz')) url = url.replace(/\/+$/, '') + '/package.tgz';
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
  return scanFiles(untar(gunzipSync(Buffer.from(await resp.arrayBuffer()))));
}
