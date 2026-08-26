// xmlGenerator.ts
import type { ParsedScenario, ParseIssue } from '../types.js';
import type { IRAction } from './gherkinParser.js';
import type { ComponentScriptlet } from './languageCatalog.js';

export interface GeneratedFile {
  filename: string;
  xml: string;
  type: 'testsuite' | 'testcase' | 'scriptlet';
  id: string;
  name: string;
}

export interface XMLOutput {
  testcaseName: string;
  xml: string;               // backwards compat: full combined XML preview
  files: GeneratedFile[];    // individual files for zip download
  scriptletCount?: number;
  /** Problems raised while generating — currently unresolved scriptlet ids. */
  issues?: ParseIssue[];
}

export class XMLGenerator {
  constructor(private parser: any) {}

  /**
   * Scriptlets read from the active file source, keyed by their suite-relative
   * path (`scriptlets/<id>.xml`). Loaded asynchronously by the app, so they are
   * pushed in rather than fetched here — generate() stays synchronous.
   */
  private externalScriptlets = new Map<string, string>();

  setExternalScriptlets(scriptlets: Map<string, string>) {
    this.externalScriptlets = scriptlets;
  }

  /** Collect all scriptlets from enabled components loaded by the parser */
  private getComponentScriptlets(): ComponentScriptlet[] {
    const components = this.parser?.getComponents?.() ?? [];
    const scriptlets: ComponentScriptlet[] = [];
    for (const comp of components) {
      if (comp.enabled && comp.scriptlets) {
        scriptlets.push(...comp.scriptlets);
      }
    }
    return scriptlets;
  }


  generate(parsed: ParsedScenario): XMLOutput {
    const featureTitle = (parsed as any).__featureTitle ?? (parsed.scenario as any).feature ?? 'Feature';
    const featureDescription = (parsed as any).__featureDescription ?? featureTitle;
    const scenarioIRs = (parsed as any).__scenarioIRs as { name: string; ir: IRAction[] }[] | undefined;

    // Feature-level @tags. `@continue-on-error` / `@non-blocking` make the
    // testcase's <steps> non-blocking (stopOnError="false"): a failed check
    // still reports red and still fails the test overall, but subsequent steps
    // keep running (e.g. a DEV-env COSE signature that can't verify against an
    // incomplete trustlist shouldn't abort the SHL/FHIR pipeline). Default
    // stays "true" so unrelated tests are unaffected.
    const featureTags: string[] = (parsed as any).__featureTags ?? [];
    const stopOnError =
      featureTags.includes('continue-on-error') || featureTags.includes('non-blocking')
        ? 'false'
        : 'true';

    const files: GeneratedFile[] = [];

    // If we have multiple scenarios, generate individual test case files + a test suite
    const scenarios = scenarioIRs && scenarioIRs.length > 0
      ? scenarioIRs
      : [{ name: parsed.scenario.name || 'Test Case', ir: (parsed as any).__ir ?? [] }];

    // Parse scriptlet param types once per generation — used by
    // collectVariables to align caller-var declarations with what each
    // scriptlet's <params><var> declares. Without this the ITB rejects
    // string→map (and similar) at scriptlet call boundaries.
    const scriptletParamTypes = parseScriptletParamTypes(this.getComponentScriptlets());

    // Generate individual test case XMLs
    for (const sc of scenarios) {
      const testcaseId = toId(sc.name);
      const actors = collectActors(sc.ir);
      const variables = collectVariables(sc.ir, scriptletParamTypes);
      const stepsXml = emitIR(sc.ir);
      const actorsXml = emitActors(actors);
      const variablesXml = emitVariables(variables);
      const testcaseXml = `<?xml version="1.0" encoding="UTF-8"?>
<testcase id="${escapeAttr(testcaseId)}"
          xmlns="http://www.gitb.com/tdl/v1/"
          xmlns:gitb="http://www.gitb.com/core/v1/">
  <metadata>
    <gitb:name>${escapeXml(sc.name)}</gitb:name>
    <gitb:version>1.0</gitb:version>
    <gitb:description>${escapeXml(featureTitle)}</gitb:description>
  </metadata>

  <actors>
${indent(actorsXml, 4)}
  </actors>
${variablesXml ? `\n  <variables>\n${indent(variablesXml, 4)}\n  </variables>\n` : ''}
  <steps stopOnError="${stopOnError}">
${indent(stepsXml || '<!-- no steps generated for this scenario -->', 4)}
  </steps>

  <output>
    <success>
      <default>"Test case completed successfully."</default>
    </success>
    <failure>
      <default>"Test case failed. Check step reports and logs."</default>
    </failure>
  </output>
</testcase>`;

      files.push({
        filename: `${testcaseId}.xml`,
        xml: testcaseXml,
        type: 'testcase',
        id: testcaseId,
        name: sc.name
      });
    }

    // Generate test suite XML
    const suiteId = toId(featureTitle);
    const testcaseRefs = files
      .filter(f => f.type === 'testcase')
      .map(f => `  <testcase id="${escapeAttr(f.id)}"/>`)
      .join('\n');

    // Collect all actors from all scenarios
    const allActors = new Map<string, { name?: string; role?: string; endpoint?: string; canonical?: string }>();
    for (const sc of scenarios) {
      for (const a of collectActors(sc.ir)) {
        if (!allActors.has(a.id)) allActors.set(a.id, { name: a.name, role: a.role, endpoint: a.endpoint, canonical: a.canonical });
      }
    }
    const suiteActorsXml = emitSuiteActors([...allActors.entries()].map(([id, v]) => ({ id, ...v })));

    const testsuiteXml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite id="${escapeAttr(suiteId)}"
           xmlns="http://www.gitb.com/tdl/v1/"
           xmlns:gitb="http://www.gitb.com/core/v1/">
  <metadata>
    <gitb:name>${escapeXml(featureTitle)}</gitb:name>
    <gitb:version>1.0</gitb:version>
    <gitb:description>${escapeXml(featureDescription)}</gitb:description>
  </metadata>

  <actors>
${indent(suiteActorsXml, 4)}
  </actors>

${testcaseRefs}

</testsuite>`;

    files.unshift({
      filename: `${suiteId}.xml`,
      xml: testsuiteXml,
      type: 'testsuite',
      id: suiteId,
      name: featureTitle
    });

    // Scriptlets: inline body → file source → component. No stub fallback.
    const scriptletIssues: ParseIssue[] = [];
    const scriptletFiles = generateScriptlets(
      scenarios,
      this.getComponentScriptlets(),
      this.externalScriptlets,
      scriptletIssues,
    );
    files.push(...scriptletFiles);

    // Combined preview: test suite + all test cases separated by comments
    const combinedXml = files.map(f =>
      `<!-- ===== ${f.type}: ${f.filename} ===== -->\n${f.xml}`
    ).join('\n\n');

    return {
      testcaseName: featureTitle,
      xml: combinedXml,
      files,
      scriptletCount: scriptletFiles.length,
      issues: scriptletIssues,
    };
  }
}


interface DeclaredActor {
  id: string;
  name?: string;
  role?: string;
  endpoint?: string;
  canonical?: string;
}

interface DeclaredVariable {
  name: string;
  varType: string;
  value?: string;
}

/**
 * Parse each shipped scriptlet XML to extract its declared param types.
 * Result maps a scriptlet's <call path="..."> to { paramName -> type }.
 *
 * Used to prevent the "Conversion from [string] to [map] not supported"
 * error that ITB throws when a caller passes `$var` (declared string) to
 * a scriptlet input declared type="map" (like serializeJsonObject.xml).
 */
function parseScriptletParamTypes(
  scriptlets: ComponentScriptlet[]
): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  const paramsBlockRe = /<params>([\s\S]*?)<\/params>/;
  const varRe = /<var\s+name="([^"]+)"\s+type="([^"]+)"\s*\/?>/g;
  for (const s of scriptlets) {
    const paramsMatch = paramsBlockRe.exec(s.xml);
    if (!paramsMatch) continue;
    const paramMap = new Map<string, string>();
    let m: RegExpExecArray | null;
    varRe.lastIndex = 0;
    while ((m = varRe.exec(paramsMatch[1])) !== null) {
      paramMap.set(m[1], m[2]);
    }
    if (paramMap.size > 0) result.set(s.path, paramMap);
  }
  return result;
}

/**
 * Walk `call` actions; if any input passes a bare $var to a scriptlet
 * whose param declares a non-string type, upgrade the source var to that
 * type. ITB does no implicit conversion at scriptlet call boundaries.
 */
function upgradeVarsForScriptletCalls(
  ir: IRAction[],
  vars: DeclaredVariable[],
  scriptletParamTypes: Map<string, Map<string, string>>
): void {
  const varRefRe = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
  const walk = (actions: IRAction[]) => {
    for (const a of actions) {
      if (a.type === 'call' && a.inputs) {
        const paramTypes = scriptletParamTypes.get(a.path);
        if (paramTypes) {
          for (const [paramName, value] of Object.entries(a.inputs)) {
            const expectedType = paramTypes.get(paramName);
            if (!expectedType || expectedType === 'string') continue;
            const m = varRefRe.exec(value);
            if (!m) continue;
            const v = vars.find(x => x.name === m[1]);
            if (v && v.varType !== expectedType) v.varType = expectedType;
          }
        }
      } else if (a.type === 'foreach' && a.do) {
        walk(a.do);
      } else if (a.type === 'repeat' && a.do) {
        walk(a.do);
      }
    }
  };
  walk(ir);
}

function collectVariables(
  ir: IRAction[],
  scriptletParamTypes?: Map<string, Map<string, string>>
): DeclaredVariable[] {
  const vars: DeclaredVariable[] = [];
  const seen = new Set<string>();

  // 1. Explicitly declared variables
  for (const a of ir) {
    if (a.type === 'declareVariable' && !seen.has(a.name)) {
      seen.add(a.name);
      vars.push({ name: a.name, varType: a.varType, value: a.value });
    }
  }

  // 2. Variables created by <process output="varName"> — ITB requires pre-declaration
  for (const a of ir) {
    if (a.type === 'process' && a.output && !seen.has(a.output)) {
      seen.add(a.output);
      vars.push({ name: a.output, varType: 'string' });
    }
  }

  // 2b. Variables created by <call output="varName"> — scriptlet output
  for (const a of ir) {
    if (a.type === 'call' && a.output && !seen.has(a.output)) {
      seen.add(a.output);
      vars.push({ name: a.output, varType: 'map' });
    }
  }

  // 3. Variables created by <send id="xxx"> or <receive id="xxx">
  for (const a of ir) {
    if ((a.type === 'send' || a.type === 'receive') && a.id && !seen.has(a.id)) {
      seen.add(a.id);
      vars.push({ name: a.id, varType: 'map' });
    }
  }

  // 4a-c. Variables created by <assign to="...">. Walk recursively into
  // foreach.do and repeat.do — assigns inside loops also need declaring.
  // For our `i` counter, declare with an initial value of "0" so the
  // first counter-bump inside the loop can reference it without "Invalid
  // variable reference" errors (ITB rejects reads of uninitialised vars).
  const walkAssigns = (actions: IRAction[]) => {
    for (const a of actions) {
      if (a.type === 'assign' && a.to) {
        if (a.to.includes('{')) {
          const baseName = a.to.split('{')[0];
          if (baseName && !seen.has(baseName)) {
            seen.add(baseName);
            vars.push({ name: baseName, varType: 'map' });
          }
        } else if (a.append && !seen.has(a.to)) {
          seen.add(a.to);
          vars.push({ name: a.to, varType: 'list[map]' });
        } else if (!seen.has(a.to)) {
          seen.add(a.to);
          // Loop counter — pre-initialise to 0 in the <var> block.
          if (a.to === 'i') {
            vars.push({ name: a.to, varType: 'string', value: '0' });
          } else {
            vars.push({ name: a.to, varType: 'string' });
          }
        }
      } else if (a.type === 'foreach' && a.do) {
        walkAssigns(a.do);
      } else if (a.type === 'repeat' && a.do) {
        walkAssigns(a.do);
      }
    }
  };
  walkAssigns(ir);

  // 5. Variables created by <interact> requests
  for (const a of ir) {
    if (a.type === 'interact' && a.requests) {
      for (const req of a.requests) {
        // Variable may be "$rawQRData" or "rawQRData" — normalise to bare name
        const varName = req.variable?.replace(/^\$/, '');
        if (varName && !seen.has(varName)) {
          seen.add(varName);
          vars.push({ name: varName, varType: 'string' });
        }
      }
    }
  }

  // 6. Variables *referenced* in step expressions (e.g. $FHIRValidatorBase) that
  // weren't declared anywhere else. ITB requires every $var to be declared in
  // <variables> or implicitly created by a step; otherwise import fails with TDL-040.
  for (const name of collectReferencedVars(ir)) {
    if (!seen.has(name)) {
      seen.add(name);
      vars.push({ name, varType: 'string' });
    }
  }

  // 7. Type-upgrade pass: variables passed as bare $var to a scriptlet input
  // whose declared type is non-string (e.g. serializeJsonObject expects map).
  // Without this, ITB throws "Conversion from [string] to [map] not supported"
  // at the <call> boundary because it does no implicit coercion there.
  if (scriptletParamTypes) {
    upgradeVarsForScriptletCalls(ir, vars, scriptletParamTypes);
  }

  return vars;
}

/** TDL builtins / iterator vars that are implicitly available — never declare. */
const RESERVED_VAR_NAMES = new Set([
  'row',         // <foreach> iterator
  'tableRows',   // table rows in <foreach from="$tableRows">
  'docString',   // Gherkin doc-string content
  'iterator',    // some <foreach> variants
]);

/**
 * Walk the IR and collect every $identifier referenced in string-valued fields
 * (inputs, assign values, log values, etc.). Used to synthesize <var> declarations
 * for references that aren't otherwise declared.
 */
function collectReferencedVars(ir: IRAction[]): Set<string> {
  const refs = new Set<string>();

  const scan = (s: string | undefined) => {
    if (!s) return;
    // Match $identifier — but NOT ${...} (freemarker template syntax inside
    // string templates, where ${name} is the freemarker var, not a TDL ref).
    const re = /\$(?!\{)([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      const name = m[1];
      if (!RESERVED_VAR_NAMES.has(name)) refs.add(name);
    }
  };

  const scanInputs = (inputs?: Record<string, string>) => {
    if (!inputs) return;
    for (const v of Object.values(inputs)) scan(v);
  };

  const walk = (actions: IRAction[]) => {
    for (const a of actions) {
      if (a.type === 'send' || a.type === 'receive' || a.type === 'verify' || a.type === 'process' || a.type === 'call') {
        scanInputs(a.inputs);
      }
      if (a.type === 'assign') {
        scan(a.value);
      }
      if (a.type === 'log') {
        scan(a.value);
      }
      if (a.type === 'listAppend') {
        for (const v of Object.values(a.item)) scan(v);
      }
      if (a.type === 'foreach') {
        scan(a.from);
        if (a.do) walk(a.do);
      }
      if (a.type === 'repeat') {
        scan(a.count);
        if (a.do) walk(a.do);
      }
    }
  };
  walk(ir);

  return refs;
}

function emitVariables(vars: DeclaredVariable[]): string {
  if (vars.length === 0) return '';
  return vars.map(v => {
    if (v.value != null) {
      return `<var name="${escapeAttr(v.name)}" type="${escapeAttr(v.varType)}">\n  <value>${escapeXml(v.value)}</value>\n</var>`;
    }
    return `<var name="${escapeAttr(v.name)}" type="${escapeAttr(v.varType)}"/>`;
  }).join('\n');
}

function collectActors(ir: IRAction[]): DeclaredActor[] {
  const actors: DeclaredActor[] = [];
  const seen = new Set<string>();
  for (const a of ir) {
    if (a.type === 'declareActor' && !seen.has(a.id)) {
      seen.add(a.id);
      actors.push({ id: a.id, name: a.name, role: a.role, endpoint: a.endpoint, canonical: a.canonical });
    }
  }
  // If no actors were declared, use defaults
  if (actors.length === 0) {
    actors.push({ id: 'Client', role: 'SUT' });
    actors.push({ id: 'FHIRServer', role: 'infra' });
  }
  return actors;
}

// Role mapping: our (SUT|infra) onto the GITB-faithful role attribute.
// GITB's TDL XSD only allows role="SUT" or role="SIMULATED" at the testcase-level
// <gitb:actor> reference, and NO role attribute on the testsuite-level actor block.
function gitbRoleAttr(role?: string): string {
  if (role === 'SUT') return ' role="SUT"';
  if (role === 'infra') return ' role="SIMULATED"';
  return '';
}

/**
 * Emit actor elements for a test case.
 * Test-case actors are simple GITB role references: <gitb:actor id="..." role="SUT|SIMULATED"/>.
 */
function emitActors(actors: DeclaredActor[]): string {
  return actors.map(a => {
    return `<gitb:actor id="${escapeAttr(a.id)}"${gitbRoleAttr(a.role)}/>`;
  }).join('\n');
}

/**
 * Emit actor elements for a test suite.
 * Testsuite-level <gitb:actor> blocks are RICH (with <gitb:name>, <gitb:desc>) and
 * the GITB XSD does NOT allow a role attribute here — the testcase-level reference
 * carries the role.
 */
function emitSuiteActors(actors: DeclaredActor[]): string {
  return actors.map(a => {
    const name = a.name || a.id;
    const desc = a.endpoint
      ? `Endpoint: ${a.endpoint}${a.canonical ? ' | Definition: ' + a.canonical : ''}`
      : (a.canonical ? `Definition: ${a.canonical}` : '');
    return `<gitb:actor id="${escapeAttr(a.id)}">\n  <gitb:name>${escapeXml(name)}</gitb:name>${desc ? `\n  <gitb:desc>${escapeXml(desc)}</gitb:desc>` : ''}\n</gitb:actor>`;
  }).join('\n');
}

function emitIR(ir: IRAction[]): string {
  // Default 'from' on send steps is the FIRST SUT actor declared.
  // P2P scenarios may declare more than one SUT — that's fine; each step can still
  // set its own `from` explicitly. We just need a sensible default.
  const sutDecl = ir.find(a => a.type === 'declareActor' && a.role === 'SUT') as { type: 'declareActor'; id: string } | undefined;
  const sutActor = sutDecl?.id || 'Client';

  const out: string[] = [];
  for (const a of ir) {
    if (a.type === 'declareActor') {
      // Actor declarations are handled separately in <actors> section
      continue;
    } else if (a.type === 'send') {
      const idAttr = a.id ? ` id="${escapeAttr(a.id)}"` : '';
      const descAttr = a.desc ? ` desc="${escapeAttr(a.desc)}"` : '';
      const from = a.from || sutActor;
      const fromAttr = ` from="${escapeAttr(from)}"`;
      const toAttr = a.to ? ` to="${escapeAttr(a.to)}"` : '';
      out.push(`<send${idAttr}${descAttr} handler="${escapeAttr(a.handler)}"${fromAttr}${toAttr}>`);
      out.push(...emitInputs(a.inputs));
      out.push(`</send>`);
    } else if (a.type === 'log') {
      out.push(`<log>${escapeXml(a.value)}</log>`);
    } else if (a.type === 'wait') {
      // The GITB TDL XSD shipping with this ITB has no <sleep> step, and the
      // available primitives (process/call/verify/etc.) all need a handler we
      // can't assume exists in the deployment. Emit a <log> for visibility —
      // the test runs without an actual delay until a sleep mechanism lands.
      out.push(`<log>"(wait skipped: TDL XSD has no <sleep> step; would have waited ${escapeXml(a.durationMs)} ms)"</log>`);
    } else if (a.type === 'repeat') {
      // GITB TDL XSD doesn't allow <repeat>. Use <while> with a counter.
      // The init value (0) is attached to the <var> in <variables>; the
      // counter-bump is emitted by the parser as the last IR action inside
      // do. Wrap operands in number() so TDL's expression evaluator does
      // numeric comparison and arithmetic.
      out.push(`<while>`);
      out.push(`  <cond>number($i) &lt; number(${escapeXml(a.count)})</cond>`);
      out.push(`  <do>`);
      const innerOut = emitIR(a.do);
      out.push(...innerOut.split('\n').map(l => l ? '    ' + l : l));
      out.push(`  </do>`);
      out.push(`</while>`);
    } else if (a.type === 'call') {
      out.push(`<call path="${escapeAttr(a.path)}"${a.output ? ` output="${escapeAttr(a.output)}"` : ''}>`);
      if (a.from) out.push(`  <input name="from">${escapeXml(a.from)}</input>`);
      if (a.to) out.push(`  <input name="to">${escapeXml(a.to)}</input>`);
      out.push(...emitInputs(a.inputs));
      out.push(`</call>`);
    } else if (a.type === 'verify') {
      out.push(`<verify handler="${escapeAttr(a.handler)}"${a.desc ? ` desc="${escapeAttr(a.desc)}"` : ''}>`);
      out.push(...emitInputs(a.inputs));
      out.push(`</verify>`);
    } else if (a.type === 'process') {
      out.push(
        `<process handler="${escapeAttr(a.handler)}" operation="${escapeAttr(a.operation)}"${a.output ? ` output="${escapeAttr(a.output)}"` : ''}${a.hidden ? ` hidden="true"` : ''}>`
      );
      if (a.from) out.push(`  <input name="from">${escapeXml(a.from)}</input>`);
      if (a.to) out.push(`  <input name="to">${escapeXml(a.to)}</input>`);
      out.push(...emitInputs(a.inputs));
      out.push(`</process>`);
    } else if (a.type === 'assign') {
      // Skip empty-list initializations — TDL creates lists implicitly on first append
      if (a.value === '[]' || a.value === '') continue;
      const appendAttr = a.append ? ' append="true"' : '';
      // ITB's <assign> body is an expression. If the value looks like a JSON
      // object/array literal (e.g. from a `set "x" to:` docstring with a JSON
      // body), wrap it in single quotes so the expression evaluator sees a
      // string literal — otherwise the leading `{` errors as an unexpected
      // token. Escape any embedded single quotes.
      let value = a.value;
      const trimmed = value.trim();
      const isJsonLiteral =
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'));
      if (isJsonLiteral) {
        value = `'${value.replace(/'/g, "\\'")}'`;
      }
      out.push(`<assign to="${escapeAttr(a.to)}"${appendAttr}>${escapeXml(value)}</assign>`);
    } else if (a.type === 'listAppend') {
      // TDL assign values are expressions — use single-quoted string to avoid quote conflicts
      const jsonStr = JSON.stringify(a.item).replace(/'/g, "\\'");
      out.push(
        `<assign to="${escapeAttr(a.list)}" append="true">'${escapeXml(jsonStr)}'</assign>`
      );
    } else if (a.type === 'declareVariable') {
      // Variable declarations are handled in <variables> section, not in <steps>
      continue;
    } else if (a.type === 'interact') {
      const idAttr = a.id ? ` id="${escapeAttr(a.id)}"` : '';
      const descAttr = a.desc ? ` desc="${escapeAttr(a.desc)}"` : '';
      // Two spellings, deliberately both kept. `title` is what gitb_tdl.xsd
      // declares on UserInteraction; `inputTitle` is not in that schema at
      // all — but neither are `inputType` and `required` on <request>, and
      // those demonstrably work in the RACSEL suites. So this XSD lags the
      // running ITB, and "absent from the schema" is not evidence that an
      // attribute is wrong. Existing steps keep emitting inputTitle rather
      // than being silently retargeted on that bad inference.
      const titleAttr = a.title ? ` title="${escapeAttr(a.title)}"` : '';
      const inputTitleAttr = a.inputTitle ? ` inputTitle="${escapeAttr(a.inputTitle)}"` : '';
      // `with` routes the interaction to one actor's tester rather than
      // whoever happens to be driving the session. Actor IDs are literal by
      // nature, which is why this is a compile-time attribute.
      const withAttr = a.with ? ` with="${escapeAttr(a.with)}"` : '';
      out.push(`<interact${idAttr}${descAttr}${titleAttr}${inputTitleAttr}${withAttr}>`);
      // Display-only instructions come first: a tester reads the message,
      // then fills in whatever the requests ask for.
      for (const ins of a.instructions ?? []) {
        const nameAttr = ins.name ? ` name="${escapeAttr(ins.name)}"` : '';
        // The instruction text is `desc`; the body is optional content shown
        // beneath it. A plain message has no content, and emitting an empty
        // string literal there renders as a stray blank block — so close the
        // element instead of giving it an empty value.
        const value = (ins.value ?? '').trim();
        if (value === '' || value === '""') {
          out.push(`  <instruct desc="${escapeAttr(ins.desc)}"${nameAttr}/>`);
        } else {
          out.push(`  <instruct desc="${escapeAttr(ins.desc)}"${nameAttr}>${escapeXml(value)}</instruct>`);
        }
      }
      for (const req of a.requests ?? []) {
        const nameAttr = req.name ? ` name="${escapeAttr(req.name)}"` : '';
        const typeAttr = req.inputType ? ` inputType="${escapeAttr(req.inputType)}"` : '';
        const reqAttr = req.required != null ? ` required="${req.required}"` : '';
        out.push(`  <request desc="${escapeAttr(req.desc)}"${nameAttr}${typeAttr}${reqAttr}>${escapeXml(req.variable)}</request>`);
      }
      out.push(`</interact>`);
    } else if (a.type === 'receive') {
      const idAttr = a.id ? ` id="${escapeAttr(a.id)}"` : '';
      const descAttr = a.desc ? ` desc="${escapeAttr(a.desc)}"` : '';
      const fromAttr = a.from ? ` from="${escapeAttr(a.from)}"` : '';
      const toAttr = a.to ? ` to="${escapeAttr(a.to)}"` : '';
      out.push(`<receive${idAttr}${descAttr} handler="${escapeAttr(a.handler)}"${fromAttr}${toAttr}>`);
      out.push(...emitInputs(a.inputs));
      out.push(`</receive>`);
    }
  }
  return out.join('\n');
}

function emitInputs(inputs?: Record<string, string>): string[] {
  if (!inputs) return [];
  return Object.entries(inputs).map(
    ([k, v]) => `  <input name="${escapeAttr(k)}">${escapeXml(quoteIfLiteral(v))}</input>`
  );
}

/**
 * Wrap a value in double quotes if it looks like a plain-text literal
 * rather than a TDL expression or variable reference.
 * Values starting with $ or " are already expressions/quoted.
 * Pure identifiers (letters, digits, underscores) and numbers are kept bare.
 *
 * Special handling for strings containing embedded double quotes (e.g. JSON):
 * - No $var refs → wrap in single quotes: '{"key":"value"}'
 * - With $var refs → build concat(): concat('{"key":"', $var, '"}')
 */
function quoteIfLiteral(v: string): string {
  if (!v) return v;
  // Already quoted or an expression/variable reference
  if (v.startsWith('"') || v.startsWith("'") || v.startsWith('$')) return v;
  // Function call expression (concat, contains, string-length, starts-with,
  // local-name, xs:integer, etc.) — don't quote. XPath function names may
  // contain hyphens and namespace colons; \w alone misses both.
  if (/^[a-zA-Z_][\w:-]*\s*\(/.test(v)) return v;
  // Pure number
  if (/^[0-9]+(\.[0-9]+)?$/.test(v)) return v;
  // Pure identifier (actor name, variable name, etc.)
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return v;
  // Boolean-like
  if (v === 'true' || v === 'false') return v;

  // If the string contains embedded double quotes (JSON bodies, etc.)
  // we can't wrap in double quotes — use single quotes or concat()
  if (v.includes('"')) {
    const hasVarRefs = /\$[a-zA-Z_]\w*(?:\{[^}]*\})*/.test(v);
    if (!hasVarRefs) {
      // Pure literal with double quotes — single-quote wrap
      // Escape any embedded single quotes to avoid breaking the TDL expression
      const escaped = v.replace(/'/g, "\\'");
      return `'${escaped}'`;
    }
    // Has $variable references — build concat() so TDL resolves them
    return buildConcatExpression(v);
  }

  // Otherwise it's a literal that needs quoting
  return `"${v}"`;
}

/**
 * Build a TDL concat() expression from a string containing $variable references.
 * e.g. {"qr_data":"$rawQRData","include_raw":true}
 *   → concat('{"qr_data":"', $rawQRData, '","include_raw":true}')
 */
function buildConcatExpression(v: string): string {
  const parts: string[] = [];
  // Match $varName or $varName{prop} or $varName{prop}{nested}
  const regex = /(\$[a-zA-Z_]\w*(?:\{[^}]*\})*)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(v)) !== null) {
    if (match.index > lastIndex) {
      const lit = v.substring(lastIndex, match.index).replace(/'/g, "\\'");
      parts.push(`'${lit}'`);
    }
    parts.push(match[1]); // variable reference bare
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < v.length) {
    const lit = v.substring(lastIndex).replace(/'/g, "\\'");
    parts.push(`'${lit}'`);
  }

  if (parts.length === 1) return parts[0];
  return `concat(${parts.join(', ')})`;
}

/** What a feature file asks of one scriptlet path. */
interface ScriptletRef {
  /** Input names, which become the scriptlet's <params>. */
  inputs: Set<string>;
  /** Raw TDL supplied inline via a doc string, if any. */
  body?: string;
}

function mergeRef(calls: Map<string, ScriptletRef>, path: string): ScriptletRef {
  const existing = calls.get(path) ?? { inputs: new Set<string>() };
  calls.set(path, existing);
  return existing;
}

/**
 * Collect all unique scriptlet call paths, their input names, and any inline
 * body, from IR actions.
 */
function collectScriptletCalls(ir: IRAction[]): Map<string, ScriptletRef> {
  const calls = new Map<string, ScriptletRef>();
  for (const a of ir) {
    if (a.type === 'call' && a.path.startsWith('scriptlets/')) {
      const ref = mergeRef(calls, a.path);
      if (a.from) ref.inputs.add('from');
      if (a.to) ref.inputs.add('to');
      if (a.inputs) {
        for (const k of Object.keys(a.inputs)) ref.inputs.add(k);
      }
      if (a.body) ref.body = a.body;
    }
    if ((a.type === 'foreach' || a.type === 'repeat') && a.do) {
      for (const [path, nested] of collectScriptletCalls(a.do)) {
        const ref = mergeRef(calls, path);
        for (const k of nested.inputs) ref.inputs.add(k);
        if (nested.body) ref.body = nested.body;
      }
    }
  }
  return calls;
}

/**
 * Emit a scriptlet file for every referenced path.
 *
 * Resolution order — first hit wins:
 *   1. an inline body from the feature file's doc string
 *   2. an external scriptlet loaded from the file source (`# itb:` header
 *      locations, then `scriptlets/` beside the features)
 *   3. a scriptlet shipped by an enabled component
 *
 * Nothing matches → NO FILE and an issue. There is deliberately no stub
 * fallback: a stub imports and runs green while doing nothing, so a mistyped
 * id used to produce a passing test that asserted nothing.
 */
function generateScriptlets(
  scenarios: { name: string; ir: IRAction[] }[],
  componentScriptlets: ComponentScriptlet[] = [],
  externalScriptlets: Map<string, string> = new Map(),
  issues: ParseIssue[] = [],
): GeneratedFile[] {
  // Merge scriptlet calls across all scenarios
  const allCalls = new Map<string, ScriptletRef>();
  for (const sc of scenarios) {
    for (const [path, ref] of collectScriptletCalls(sc.ir)) {
      const merged = mergeRef(allCalls, path);
      for (const k of ref.inputs) merged.inputs.add(k);
      if (ref.body) merged.body = ref.body;
    }
  }

  // Index real component scriptlets by path
  const realScriptlets = new Map<string, ComponentScriptlet>();
  for (const s of componentScriptlets) {
    realScriptlets.set(s.path, s);
  }

  const files: GeneratedFile[] = [];

  for (const [path, ref] of allCalls) {
    const scriptletId = path.replace(/^scriptlets\//, '').replace(/\.xml$/, '');

    // 1. Inline body from the feature file
    if (ref.body?.trim()) {
      const inputsXml = [...ref.inputs]
        .map(name => `    <var name="${escapeAttr(name)}" type="string"/>`)
        .join('\n');
      // The body is raw TDL by design — emitted verbatim, never escaped.
      // Schema validation of this file is what catches malformed input.
      files.push({
        filename: path,
        xml: `<?xml version="1.0" encoding="UTF-8"?>
<scriptlet id="${escapeAttr(scriptletId)}"
            xmlns="http://www.gitb.com/tdl/v1/"
            xmlns:gitb="http://www.gitb.com/core/v1/">
${inputsXml ? `  <params>\n${inputsXml}\n  </params>\n` : ''}  <steps>
${indent(ref.body.trim(), 4)}
  </steps>
</scriptlet>`,
        type: 'scriptlet',
        id: scriptletId,
        name: scriptletId,
      });
      continue;
    }

    // 2. External scriptlet from the file source
    const external = externalScriptlets.get(path);
    if (external) {
      files.push({ filename: path, xml: external, type: 'scriptlet', id: scriptletId, name: scriptletId });
      continue;
    }

    // 3. Component-shipped scriptlet
    const real = realScriptlets.get(path);
    if (real) {
      files.push({ filename: path, xml: real.xml, type: 'scriptlet', id: scriptletId, name: scriptletId });
      continue;
    }

    issues.push({
      severity: 'error',
      from: 'scriptlet',
      message: `Scriptlet "${scriptletId}" not found — add ${path} beside your feature files, declare its location in the "# itb:" header, or supply the body inline with a doc string`,
    });
  }

  // Also include any component scriptlets that weren't directly referenced
  // (they may be called by other scriptlets or useful for future steps)
  for (const s of componentScriptlets) {
    if (!allCalls.has(s.path)) {
      const scriptletId = s.path.replace(/^scriptlets\//, '').replace(/\.xml$/, '');
      files.push({
        filename: s.path,
        xml: s.xml,
        type: 'scriptlet',
        id: scriptletId,
        name: scriptletId,
      });
    }
  }

  return files;
}

function toId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return base.length ? base : 'tc-1';
}

function escapeXml(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string) {
  return escapeXml(s);
}

function indent(s: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return s
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}
