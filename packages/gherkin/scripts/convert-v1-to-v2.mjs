#!/usr/bin/env node
// Rewrite generation-1 feature files into the generation-2 syntax.
//
//   node scripts/convert-v1-to-v2.mjs <file-or-dir>...   (rewrites in place)
//   node scripts/convert-v1-to-v2.mjs --check <file>...  (prints the result)
//
// Mechanical where the mapping is one-to-one (quoted variables become $vars,
// reserved names become $response.status and friends, `conforms to` becomes
// `should conform to`); scripted where a v1 step hid state that v2 makes
// explicit (the HCERT pipeline). Lines it cannot map are left untouched, so
// the compiler reports them and a person decides.
//
// Steps are matched after the Gherkin keyword; doc strings, tables and
// comments are left exactly as they are.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const check = args.includes('--check');
const targets = args.filter(a => !a.startsWith('--'));

/** Known validator actors → the kind they are declared as. */
const KIND_BY_NAME = [
  [/^(FHIRValidator|Validator)$/, 'fhir-validator'],
  [/^(HCertDecoder|VHLResponder)$/, 'hcert-decoder'],
  [/^SmartHelper$/, 'smart-helper'],
  [/^TNGValidator$/, 'tng-validator'],
];

const RESERVED = {
  'response status': '$response.status',
  'response body': '$response.body',
  'response': '$response',
  'validation errors': '$validation.errors',
  'validation warnings': '$validation.warnings',
  'validation outcome': '$validation.outcome',
  'validation severity': '$validation.severity',
};

/** "name" | "name{a}{b}" | "lastReceived{method}" → $name.a.b */
function ref(quoted) {
  const inner = quoted.replace(/^"|"$/g, '');
  if (RESERVED[inner]) return RESERVED[inner];
  const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\{[^}]+\})*)$/.exec(inner);
  if (!m) return quoted;
  const segs = [...m[2].matchAll(/\{([^}]+)\}/g)].map(x => x[1]);
  let base = m[1] === 'lastReceived' ? '$received' : '$' + m[1];
  return base + segs.map(s => '.' + s).join('');
}

/** A right-hand value: numbers and booleans lose their quotes, "$x" → $x. */
function value(quoted) {
  const inner = quoted.replace(/^"|"$/g, '');
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(inner) || inner === 'true' || inner === 'false') return inner;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) return inner;
  return quoted;
}

const Q = '"([^"]*)"';
const A = '([A-Za-z][A-Za-z0-9_]*)';

/**
 * Rules: [regex on the step text, replacement(match, ctx) → text | null (drop) ].
 * First match wins. `ctx.sut` is the SUT actor for subject-less verbs.
 */
const RULES = [
  // ── actors ────────────────────────────────────────────────────────
  [new RegExp(`^${A} is the system under test(?: (?:on|at) "?(https?://[^"\\s]+)"?)?(?: as defined by "?(https?://[^"\\s]+)"?)?$`),
    (m) => `${m[1]} is the system under test${m[2] ? ` at "${m[2]}"` : ''}${m[3] ? ` as defined by "${m[3]}"` : ''}`],
  [new RegExp(`^${A} is (?:available|infrastructure)(?: as ${Q})?(?: (?:on|at) "?(https?://[^"\\s]+)"?)?(?: as defined by "?(https?://[^"\\s]+)"?)?$`),
    (m) => {
      // An aliased actor (`as "FHIR Validation Service"`) keeps its alias
      // and stays infrastructure; only bare validator names become kinds.
      const kind = m[2] ? undefined : KIND_BY_NAME.find(([re]) => re.test(m[1]))?.[1];
      const tail = `${m[3] ? ` at "${m[3]}"` : ''}${m[4] ? ` as defined by "${m[4]}"` : ''}`;
      if (kind) return `${m[1]} is a ${kind}${tail}`;
      return `${m[1]} is infrastructure${m[2] ? ` as "${m[2]}"` : ''}${tail}`;
    }],
  [new RegExp(`^${A} is loaded with package "?([^"\\s]+)"?$`), (m) => `${m[1]} is loaded with package "${m[2]}"`],

  // ── hcert pipeline (state made explicit) ──────────────────────────
  [new RegExp(`^${A} uploads a QR image to ${A}$`), (m) => `${m[1]} uploads a file as $qrImage\n    And ${m[1]} scans $qrImage on ${m[2]} as $qrData`],
  [new RegExp(`^${A} enters a PIN$`), (m) => `${m[1]} is asked for $pin with "Enter the PIN for retrieving the content"`],
  [/^extract "\/qr_data" as "rawQRData"$/, () => null],
  [new RegExp(`^${A} decodes HC1 on ${A}$`), (m, ctx) => { ctx.hcert = true; return `${m[1]} decodes $qrData on ${m[2]} as $hcert`; }],
  [new RegExp(`^${A} extracts metadata on ${A}$`), (m) => `${m[1]} extracts metadata from $hcert on ${m[2]} as $metadata`],
  [new RegExp(`^${A} verifies COSE signature on ${A} with:$`), (m, ctx) => { ctx.dropSig = 3; return `${m[1]} verifies the signature of $hcert on ${m[2]} with:`; }],
  [/^extract "\/valid" as "sigValid"$/, () => null],
  [/^"sigValid" should be "true"$/, () => null],
  [new RegExp(`^${A} extracts SHL reference on ${A}$`), (m) => `${m[1]} extracts the SHL link from $hcert on ${m[2]} as $shlLink`],
  [new RegExp(`^${A} authorizes SHL on ${A} with url and pin$`), (m) => `${m[1]} authorizes $shlLink on ${m[2]} with pin $pin as $manifest`],
  [new RegExp(`^${A} authorizes SHL on ${A} with url and wrong pin ${Q}$`), (m) => `${m[1]} authorizes $shlLink on ${m[2]} with pin "${m[3]}" expecting status 401`],
  [/^extract "\/manifest" as "manifestVal"$/, () => null],
  [new RegExp(`^${A} fetches FHIR from ${A} with manifest$`), (m) => `${m[1]} fetches the FHIR content of $manifest on ${m[2]} as $firstResource`],
  [/^extract "\/fhir\/0\/resource" as "firstResource"$/, () => null],
  [/^extract "(\/payload\/[^"]*|\/hcert_inner_json)" as "([^"]+)"$/, (m, ctx) => ctx.hcert ? `extract "${m[1]}" from $hcert as $${m[2]}` : null],
  [/^"([A-Za-z_][A-Za-z0-9_]*)" is set$/, () => null],

  // ── FHIR validator ────────────────────────────────────────────────
  [new RegExp(`^${A} loads IG ${Q} on ${A}$`), (m, ctx) => { ctx.asserted = true; return `${m[1]} loads IG "${m[2]}" on ${m[3]}`; }],
  [new RegExp(`^${A} transforms ${Q} (?:on|via) ${A} with map ${Q} as ${Q}$`), (m, ctx) => { ctx.asserted = true; return `${m[1]} transforms $${m[2]} with map "${m[4]}" on ${m[3]} as $${m[5]}`; }],
  [new RegExp(`^transform ${Q} using map ${Q} as ${Q}$`), (m, ctx) => { ctx.asserted = true; return `${ctx.sut} transforms $${m[1]} with map "${m[2]}" as $${m[3]}`; }],
  [new RegExp(`^${A} parses FML ${Q} on ${A} as ${Q}$`), (m, ctx) => { ctx.asserted = true; return `${m[1]} parses FML $${m[2]} on ${m[3]} as $${m[4]}`; }],
  [new RegExp(`^${A} registers StructureMap ${Q} on ${A}$`), (m, ctx) => { ctx.asserted = true; return `${m[1]} registers StructureMap $${m[2]} on ${m[3]}`; }],
  [new RegExp(`^${A} validates ${Q} against ${Q} via ${A} targeting ${A}$`), (m) => `${m[1]} validates $${m[2]} against "${m[3]}" on ${m[4]} targeting ${m[5]}`],
  [new RegExp(`^${A} validates ${Q} against ${Q} on ${A}$`), (m) => `${m[1]} validates $${m[2]} against "${m[3]}" on ${m[4]}`],
  [new RegExp(`^validate ${Q} against ${Q} with best practice ${Q}$`), (m, ctx) => `${ctx.sut} validates $${m[1]} against "${m[2]}" with:\n      | option       | value |\n      | bestPractice | ${m[3]} |`],
  [new RegExp(`^validate ${Q} against ${Q} with resource id ${Q}$`), (m, ctx) => `${ctx.sut} validates $${m[1]} against "${m[2]}" with:\n      | option     | value |\n      | resourceId | ${m[3]} |`],
  [new RegExp(`^validate ${Q} against ${Q}$`), (m, ctx) => `${ctx.sut} validates $${m[1]} against "${m[2]}"`],
  [/^the validation should pass$/, () => `$validation.errors should be 0`],
  [/^the validation should fail$/, () => `$validation.errors should be greater than 0`],
  [new RegExp(`^${Q} should be a valid (\\S+) resource$`), (m) => `${ref(`"${m[1]}"`)} should be a valid ${m[2]} resource`],
  [new RegExp(`^${Q} conforms to ${Q} downgrading slicing errors$`), (m) => `${ref(`"${m[1]}"`)} should conform to "${m[2]}" ignoring slicing errors`],
  [new RegExp(`^${Q} conforms to ${Q} downgrading errors matching ${Q}$`), (m) => `${ref(`"${m[1]}"`)} should conform to "${m[2]}" ignoring errors matching "${m[3]}"`],
  [new RegExp(`^${Q} conforms to ${Q}$`), (m) => `${ref(`"${m[1]}"`)} should conform to "${m[2]}"`],
  [new RegExp(`^${Q} matches pattern:$`), (m) => `${ref(`"${m[1]}"`)} should match pattern:`],
  [new RegExp(`^partially match ${Q} against:$`), (m) => `${ref(`"${m[1]}"`)} should match pattern:`],
  [new RegExp(`^${Q} should NOT match:$`), (m) => `${ref(`"${m[1]}"`)} should not match pattern:`],
  [/^the generated resource type should be "([^"]+)"$/, (m) => `$generatedResource at "/resourceType" should be "${m[1]}"`],
  [new RegExp(`^${Q} does not match pattern:$`), (m) => `${ref(`"${m[1]}"`)} should not match pattern:`],
  [new RegExp(`^assert FHIRPath ${Q} on ${Q}$`), (m) => `${ref(`"${m[2]}"`)} should satisfy "${m[1]}"`],
  [new RegExp(`^evaluate FHIRPath ${Q} on ${Q} and expect ${Q}$`), (m) => `${ref(`"${m[2]}"`)} at "${m[1]}" should be ${value(`"${m[3]}"`)}`],
  [new RegExp(`^evaluate FHIRPath ${Q} on ${Q} as ${Q}$`), (m) => `extract "${m[1]}" from ${ref(`"${m[2]}"`)} as $${m[3]}`],
  [new RegExp(`^evaluate FHIRPath ${Q} and expect ${Q}$`), (m) => `$response.body at "${m[1]}" should be ${value(`"${m[2]}"`)}`],
  [new RegExp(`^evaluate FHIRPath ${Q} exists$`), (m) => `$response.body at "(${m[1]}).exists()" should be true`],
  [new RegExp(`^evaluate FHIRPath ${Q} count is ([0-9]+)$`), (m) => `$response.body at "(${m[1]}).count()" should be ${m[2]}`],
  [new RegExp(`^summarize ${Q} as ${Q} ${Q} ${Q}$`), (m, ctx) => `${ctx.sut} summarizes $${m[1]} as $summary`],
  [new RegExp(`^generate test data from profile ${Q}(?: as ${Q})?$`), (m, ctx) => `${ctx.sut} generates test data from "${m[1]}" as $${m[2] ?? 'generatedResource'}`],
  [new RegExp(`^generate required test data from profile ${Q}$`), (m, ctx) => `${ctx.sut} generates required test data from "${m[1]}" as $generatedResource`],
  [new RegExp(`^generate required test data as ${Q} from profile ${Q}( with values:)?$`), (m, ctx) => `${ctx.sut} generates required test data from "${m[2]}" as $${m[1]}${m[3] ?? ''}`],
  [new RegExp(`^generate required test data from profile ${Q} with mappings ${Q} as ${Q}$`), (m, ctx) => `${ctx.sut} generates required test data from "${m[1]}" with mappings $${m[2]} as $${m[3]}`],
  [new RegExp(`^define mappings ${Q} with parts:$`), (m) => `set $${m[1]} to mappings with parts:`],
  [new RegExp(`^define mappings ${Q}:$`), (m) => `set $${m[1]} to mappings:`],
  [new RegExp(`^define data ${Q}:$`), (m) => `set $${m[1]} to data:`],
  [new RegExp(`^define resource ${Q} as:$`), (m) => `set $${m[1]} to:`],
  [new RegExp(`^modify ${Q} against profile ${Q} with operations:$`), (m, ctx) => `${ctx.sut} modifies $${m[1]} against "${m[2]}" with operations:`],
  [new RegExp(`^modify ${Q} with operations:$`), (m, ctx) => `${ctx.sut} modifies $${m[1]} with operations:`],

  // ── TNG ───────────────────────────────────────────────────────────
  [new RegExp(`^${A} inspects (.+?) on ${A} as ${Q}$`), (m) => `${m[1]} inspects ${m[2].replace(/issued by "([^"]+)"/, 'issued by $$$1')} on ${m[3]} as $${m[4]}`],
  [new RegExp(`^no CA in the TLS group verifies ${Q}$`), (m) => `no CA in the TLS group verifies $${m[1]}`],
  [new RegExp(`^${Q} should be signed by ${Q}$`), (m) => `$${m[1]} should be signed by $${m[2]}`],
  [new RegExp(`^${Q} should be rejected$`), (m) => `$${m[1]} should be rejected by $caCert`],
  [new RegExp(`^${Q} notAfter should not exceed ${Q} notAfter$`), (m) => `$${m[1]} notAfter should not exceed $${m[2]} notAfter`],
  [new RegExp(`^${Q} (keyUsage|extension|EKU|basicConstraints CA|basicConstraints pathLen|public key algorithm|public key|subject CN|subject country|validity) (.*)$`),
    (m) => `$${m[1]} ${m[2]} ${m[3].replace(/should be "(true|false)"/, 'should be $1')}`],
  [new RegExp(`^${Q} should be placed at domain, group and filename$`), (m) => `$${m[1]} should be placed at domain, group and filename`],

  // ── HTTP ──────────────────────────────────────────────────────────
  [new RegExp(`^${A} (posts|puts|patches) (?:to|on) ${A} at ${Q} with id ${Q} and body ${Q}$`), (m) => `${m[1]} ${m[2]} to ${m[3]} at "${m[4]}" with id $${m[5]} with body $${m[6]}`],
  [new RegExp(`^${A} (posts|puts|patches) (?:to|on) ${A} at ${Q} with id ${Q} and:$`), (m) => `${m[1]} ${m[2]} to ${m[3]} at "${m[4]}" with id $${m[5]} with:`],
  [new RegExp(`^${A} (posts|puts|patches) (?:to|on) ${A} at ${Q} with body ${Q}$`), (m) => `${m[1]} ${m[2]} to ${m[3]} at "${m[4]}" with body $${m[5]}`],
  [new RegExp(`^${A} gets from ${A} at ${Q} with id ${Q} as ${Q}$`), (m) => `${m[1]} gets from ${m[2]} at "${m[3]}" with id $${m[4]} as $${m[5]}`],
  [new RegExp(`^${A} gets from ${A} at ${Q} as ${Q}$`), (m) => `${m[1]} gets from ${m[2]} at "${m[3]}" as $${m[4]}`],
  [new RegExp(`^${A} gets ${Q} as ${Q}$`), (m) => `${m[1]} gets "${m[2]}" as $${m[3]}`],
  [new RegExp(`^${A} deletes on ${A} at ${Q} with id ${Q}$`), (m) => `${m[1]} deletes on ${m[2]} at "${m[3]}" with id $${m[4]}`],
  [new RegExp(`^${A} posts ${Q} to ${A} at ${Q} ([0-9]+|\\$[A-Za-z_][A-Za-z0-9_]*) times, paced manually$`), (m) => `${m[1]} posts $${m[2]} to ${m[3]} at "${m[4]}" ${m[5]} times, paced manually`],
  [new RegExp(`^set header ${Q} from ${Q}$`), (m) => `set header "${m[1]}" to $${m[2]}`],
  [new RegExp(`^set bearer token from ${Q}$`), (m) => `set bearer token from $${m[1]}`],
  [new RegExp(`^${A} receives a request from ${A} within "([0-9]+)" seconds$`), (m) => `${m[1]} receives a request from ${m[2]} within ${m[3]} seconds`],
  [new RegExp(`^${A} replies to ${A} with status "([0-9]+)" and body ${Q}$`), (m) => `${m[1]} replies to ${m[2]} with status ${m[3]} and body $${m[4]}`],
  [new RegExp(`^${A} replies to ${A} with status "([0-9]+)" and:$`), (m) => `${m[1]} replies to ${m[2]} with status ${m[3]} and:`],

  // ── binding ───────────────────────────────────────────────────────
  [new RegExp(`^set ${Q} to now with format ${Q}$`), (m) => `set $${m[1]} to now with format "${m[2]}"`],
  [new RegExp(`^set ${Q} to now$`), (m) => `set $${m[1]} to now`],
  [new RegExp(`^set ${Q} to ${Q}$`), (m) => `set $${m[1]} to ${value(`"${m[2]}"`)}`],
  [new RegExp(`^set ${Q} to:$`), (m) => `set $${m[1]} to:`],
  [new RegExp(`^extract ${Q} from ${Q} as ${Q}$`), (m) => `extract "${m[1]}" from ${ref(`"${m[2]}"`)} as $${m[3]}`],
  [new RegExp(`^extract ${Q} as ${Q}$`), (m) => `extract "${m[1]}" as $${m[2]}`],
  [new RegExp(`^call scriptlet ${Q} as ${Q}( with:)?$`), (m) => `call scriptlet "${m[1]}" as $${m[2]}${m[3] ?? ''}`],

  // ── interaction ───────────────────────────────────────────────────
  [new RegExp(`^${A} is asked for ${Q}( with ${Q})?$`), (m) => `${m[1]} is asked for $${m[2]}${m[3] ?? ''}`],
  [new RegExp(`^${A} is informed ${Q} with ${Q}$`), (m) => `${m[1]} is informed "${m[2]}" with ${ref(`"${m[3]}"`)}`],

  // ── assertions ────────────────────────────────────────────────────
  [new RegExp(`^${Q} should equal ${Q} minus ${Q}$`), (m) => `${ref(`"${m[1]}"`)} should equal ${ref(`"${m[2]}"`)} minus ${value(`"${m[3]}"`)}`],
  [new RegExp(`^${Q} should (be|not be|contain|not contain) ${Q}$`), (m) => `${ref(`"${m[1]}"`)} should ${m[2]} ${value(`"${m[3]}"`)}`],
  [new RegExp(`^${Q} should not be empty$`), (m) => `${ref(`"${m[1]}"`)} should not be empty`],
  [new RegExp(`^if ${Q} (is not empty|is ${Q}) then ${Q} should (be|contain) ${Q}$`),
    (m) => `# (v1 conditional removed — express it as a Rule or an explicit assertion) if "${m[1]}" ${m[2]} then "${m[3]}" should ${m[4]} "${m[5]}"`],
];

/** Dialect verbs that now assert HTTP success themselves. */
const SELF_ASSERTING = /^(?:[A-Za-z][A-Za-z0-9_]*) (?:loads IG|transforms|parses FML|registers StructureMap|scans|decodes|verifies the signature|extracts metadata|extracts the SHL link|authorizes|fetches the FHIR content|is loaded with package)\b/;

function convertFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const out = [];
  const ctx = { sut: 'Client', hcert: false, asserted: false, dropSig: 0 };

  // Find the SUT for subject-less verbs.
  for (const l of lines) {
    const m = /^\s*(?:Given|When|Then|And|But)\s+([A-Za-z][A-Za-z0-9_]*) is the system under test/.exec(l);
    if (m) { ctx.sut = m[1]; break; }
  }

  let inDoc = false;
  let prevSelfAsserting = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*"""/.test(line)) { inDoc = !inDoc; out.push(line); continue; }
    if (inDoc) { out.push(line); continue; }

    // Tags: bump language/dialect requirements.
    if (/^\s*@/.test(line)) {
      out.push(line
        .replace(/@lang:itb-core-en@[^\s]+/g, '@lang:itb-core-en@^2')
        .replace(/@dialect:(fhir-validator|hcert-decoder|smart-helper|tng-certificate)@[^\s]+/g, '@dialect:$1@^2'));
      continue;
    }

    const m = /^(\s*)(Given|When|Then|And|But)(\s+)(.*?)\s*$/.exec(line);
    if (!m) { out.push(line); continue; }
    const [, indent, kw, sp, text] = m;

    // Status checks right after a self-asserting verb are redundant now.
    if (prevSelfAsserting && /^"response status" should be "200"$/.test(text)) { continue; }
    prevSelfAsserting = false;

    let replaced = text;
    let matched = false;
    for (const [re, fn] of RULES) {
      const mm = re.exec(text);
      if (!mm) continue;
      const r = fn(mm, ctx);
      matched = true;
      if (r === null) { replaced = null; break; }
      replaced = r;
      break;
    }
    if (replaced === null) continue; // dropped line
    if (!matched) replaced = text;

    if (SELF_ASSERTING.test(replaced)) prevSelfAsserting = true;
    if (/^# \(v1 conditional removed/.test(replaced)) { out.push(`${indent}${replaced}`); continue; }
    out.push(`${indent}${kw}${sp}${replaced}`);
  }
  // Collapse the blank line a dropped step may leave doubled.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return text;
}

function* walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (e === '_old') continue;
      yield* walk(path.join(p, e));
    }
  } else if (p.endsWith('.feature')) yield p;
}

let n = 0;
for (const t of targets) {
  for (const f of walk(t)) {
    const converted = convertFile(f);
    if (check) { console.log(`===== ${f}\n${converted}`); continue; }
    if (converted !== fs.readFileSync(f, 'utf8')) { fs.writeFileSync(f, converted, 'utf8'); n++; }
  }
}
if (!check) console.log(`converted ${n} file(s)`);
