import {
  GherkinScenario,
  GherkinStep,
  ParsedScenario,
  ParseIssue,
  Step,
  DataModel
} from '../types.js';

/** Parse a Gherkin doc string (triple-quoted block) starting at line index i+1 */
function parseDocString(lines: string[], startIdx: number): { text: string; endIdx: number } | null {
  let j = startIdx;
  // skip blank lines
  while (j < lines.length && lines[j].trim() === '') j++;
  if (j >= lines.length) return null;
  const openMatch = /^(\s*)"""(.*)$/.exec(lines[j]);
  if (!openMatch) return null;
  const indent = openMatch[1].length;
  const firstLine = openMatch[2]; // content after opening """
  const contentLines: string[] = [];
  if (firstLine.trim()) contentLines.push(firstLine);
  j++;
  while (j < lines.length) {
    const line = lines[j];
    if (/^\s*"""/.test(line)) {
      j++; // consume closing """
      return { text: contentLines.join('\n'), endIdx: j };
    }
    // strip leading indent (up to the indent of the opening """)
    const stripped = line.length >= indent ? line.slice(indent) : line.trimStart();
    contentLines.push(stripped);
    j++;
  }
  // unterminated doc string — return what we have
  return { text: contentLines.join('\n'), endIdx: j };
}

import { loadCatalog, Catalog, CatalogAction, CatalogStep, loadAllComponents, mergeCatalog, ComponentInfo, LoadOptions } from './languageCatalog.js';
import { parseITBHeader } from './itbHeader.js';
import { parseRequirements } from './languageRequirements.js';
import { SlotValue, slotValue } from './stepText.js';

/**
 * What the parser knows about a scenario while expanding it, step by step.
 * Reset per scenario; Background steps are prepended to every scenario so
 * they are re-read each time and the state is always complete.
 */
export interface ScenarioState {
  /** Declared actors: id -> role and kind (`is a <kind>`). */
  actors: Map<string, { role?: string; kind?: string }>;
  /** Value types of bound variables ($x -> 'fhir:Resource'). */
  varTypes: Map<string, string>;
}

export function newScenarioState(): ScenarioState {
  return { actors: new Map(), varTypes: new Map() };
}

/** Does the `@lang:` range ask for the 1.x core language? */
export function wantsLegacyCore(featureTags: string[]): boolean {
  const req = parseRequirements(featureTags);
  const range = req.base?.range;
  if (!range) return false;
  const m = /^(?:\^|~|=)?\s*v?(\d+)/.exec(range);
  return !!m && m[1] === '1';
}


export type IRAction =
  | { type: 'call', path: string, output?: string, from?: string, to?: string, inputs?: Record<string,string>,
      /** Raw TDL supplied inline in the feature file; becomes the scriptlet's <steps> body. */
      body?: string }
  | { type: 'send', id?: string, desc?: string, handler: string, from?: string, to?: string, txnId?: string, inputs: Record<string,string> }
  /** btxn/etxn — a GITB messaging TRANSACTION. Every send and receive inside
   *  one carries the same txnId, which is what ties a reply to the request it
   *  answers. Without it a `send` is a new outbound message, not a response on
   *  the open exchange, so a SUT waiting for its HTTP response times out. */
  | { type: 'btxn', txnId: string, from: string, to: string, handler: string }
  | { type: 'etxn', txnId: string }
  | { type: 'verify', handler: string, desc?: string, inputs: Record<string,string> }
  | { type: 'process', handler: string, operation: string, output?: string, from?: string, to?: string, inputs: Record<string,string>, hidden?: boolean }
  | { type: 'assign', to: string, value: string, append?: boolean, varType?: string }
  | { type: 'log', value: string }
  | { type: 'listAppend', list: string, item: Record<string,string> }
  | { type: 'foreach', from: string, do: IRAction[] }
  | { type: 'repeat', count: string, do: IRAction[] }
  | { type: 'wait', durationMs: string }
  | { type: 'declareActor', id: string, name?: string, role?: string, endpoint?: string, canonical?: string, kind?: string }
  | { type: 'declareVariable', name: string, varType: string, value?: string }
  /** `with` targets the interaction at one actor (gitb_tdl.xsd: UserInteraction
   *  allows `with` and `title`). It is an actor ID, not a variable, so it can
   *  only be set at compile time — which is fine, because the step names the
   *  actor. `instructions` emit <instruct> (display-only) alongside <request>
   *  (input); the schema allows either, in any mix. */
  | { type: 'interact', id?: string, desc?: string, title?: string, inputTitle?: string, with?: string, instructions?: { desc: string, name?: string, value?: string, forceDisplay?: boolean, level?: string, mimeType?: string }[], requests: { desc: string, name?: string, inputType?: string, required?: boolean, variable: string, options?: string, optionLabels?: string }[] }
  | { type: 'receive', id?: string, desc?: string, handler: string, from?: string, to?: string, txnId?: string, inputs?: Record<string,string> };


type ServicesMap = Record<string, string>; // { "FHIR-validator": "1.2.0", "Monitor": "2.1.0" }

/** Minimal, self-contained parser + catalog expander */
export class GherkinParser {
  private catalog?: Catalog;
  private model?: DataModel;
  private services: ServicesMap;
  private strictRequirements: boolean;
  private components: ComponentInfo[] = [];
  /** Both generations of the language, loaded on demand. A feature picks
   *  one with its `@lang:` tag; the current one is the default. */
  private loaded = new Map<string, { catalog: Catalog; components: ComponentInfo[] }>();

  constructor(model?: DataModel, options?: { services?: ServicesMap; strictRequirements?: boolean }) {
    this.model = model;
    this.services = options?.services ?? {};
    this.strictRequirements = options?.strictRequirements ?? false; // warning by default
  }

  /** Loads lang/en.yml (or en-1.yml) + enabled component extensions, merges
   *  them, and makes that generation the active catalog. */
  async ensureCatalog(locale='en', opts: LoadOptions = {}) {
    const key = `${locale}:${opts.legacy ? 1 : 2}`;
    let entry = this.loaded.get(key);
    if (!entry) {
      const core = await loadCatalog(locale, opts);
      const components = await loadAllComponents(core, opts);
      entry = { catalog: mergeCatalog(core, components), components };
      this.loaded.set(key, entry);
    }
    this.catalog = entry.catalog;
    this.components = entry.components;
  }

  /** Get loaded components (available after ensureCatalog) */
  getComponents(): ComponentInfo[] {
    return this.components;
  }

  /** The merged catalog in use (available after ensureCatalog). */
  getCatalog(): Catalog | undefined {
    return this.catalog;
  }

  /** Basic Gherkin parser: Feature/Scenarios/Steps (+ DataTables) -> ParsedFeature
   *  Supports multiple scenarios; Background steps are shared across all scenarios. */
  parse(text: string): ParsedScenario {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const issues: ParseIssue[] = [];
    let inFeaturePreamble = false;
    let featureDescription = '';

    let featureTitle = '';
    const backgroundSteps: Step[] = [];
    const scenarios: { name: string; steps: Step[] }[] = [];
    let currentTarget: Step[] | null = null; // null = not collecting steps yet
    let currentScenarioName = '';
    // Gherkin @tags. Collected feature-wide (we don't currently need
    // per-scenario scoping). Recognised control tags:
    //   @continue-on-error / @non-blocking → testcase <steps stopOnError="false">
    //     (checks still report red and still fail the test overall — they just
    //      don't abort the remaining steps; mirrors the hand-written suites).
    const featureTags = new Set<string>();

    const STEP_RE = /^(Given|When|Then|And|But)\s+(.*)$/i;
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const lineNo = i + 1;
      const line = stripInlineComments(raw).trim();

      if (!line) { i++; continue; }

      // Tag line(s): `@foo @bar` — Gherkin tags precede Feature/Scenario.
      // Collected feature-wide; consumed here so they don't warn as unknown.
      if (/^@/.test(line)) {
        for (const tok of line.split(/\s+/)) {
          if (tok.startsWith('@')) featureTags.add(tok.slice(1).toLowerCase());
        }
        i++; continue;
      }

      if (/^Feature:/i.test(line)) {
        featureTitle = line.replace(/^Feature:\s*/i, '').trim();
        inFeaturePreamble = true;
        i++; continue;
      }

      if (/^Background:/i.test(line)) {
        inFeaturePreamble = false;
        currentTarget = backgroundSteps;
        i++; continue;
      }

      // `Rule:` groups scenarios under a business rule (Gherkin 6). It carries
      // no steps of its own here; the grouping is documentation, and the
      // scenarios beneath it compile as they would anywhere else.
      if (/^Rule:/i.test(line)) {
        inFeaturePreamble = false;
        currentTarget = null;
        i++; continue;
      }

      if (/^Scenario:/i.test(line)) {
        currentScenarioName = line.replace(/^Scenario:\s*/i, '').trim();
        const scenarioSteps: Step[] = [];
        scenarios.push({ name: currentScenarioName, steps: scenarioSteps });
        currentTarget = scenarioSteps;
        inFeaturePreamble = false;
        i++; continue;
      }

      if (inFeaturePreamble) {
        // Collect feature description lines
        if (featureDescription) featureDescription += ' ';
        featureDescription += line;
        i++; continue;
      }

      if (!currentTarget) { i++; continue; }

      const m = STEP_RE.exec(line);
      if (m) {
        const type = m[1] as Step['type'];
        const text = m[2].trim();

        // optional data table
        const tableRows: Record<string,string>[] = [];
        let j = i + 1;
        while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
          const row = splitRow(stripInlineComments(lines[j]));
          if (tableRows.length === 0) {
            tableRows.push(Object.fromEntries(row.map((h) => [h, h])));
          } else {
            const header = Object.keys(tableRows[0]);
            const obj: Record<string,string> = {};
            header.forEach((h, idx) => { obj[h] = row[idx] ?? ''; });
            tableRows.push(obj);
          }
          j++;
        }
        let table: Record<string,string>[] | undefined;
        if (tableRows.length > 1) table = tableRows.slice(1);

        // Optional doc string (triple-quoted block). Allowed *after* a table
        // too: `call scriptlet ... with:` takes a table of inputs and a
        // docstring holding the raw TDL body. A GITB scriptlet only sees what
        // its <params> receive, so an inline body without inputs could not
        // reach the enclosing test case's variables.
        let docString: string | undefined;
        const ds = parseDocString(lines, j);
        if (ds) {
          docString = ds.text;
          j = ds.endIdx;
        }

        currentTarget.push({
          type,
          text,
          line: lineNo,
          table,
          docString
        } as Step);

        i = j;
        continue;
      }

      if (/^\s*#/.test(raw)) { i++; continue; }

      // Unknown line -> warning
      issues.push({ line: lineNo, severity: 'warning', message: `Unrecognized line: "${line}"` });
      i++;
    }

    if (scenarios.length === 0) {
      issues.push({ line: 1, severity: 'error', message: 'Missing "Scenario:" line' });
    }

    // Build scenarios with background steps prepended
    const builtScenarios = scenarios.map(s => ({
      name: s.name,
      steps: [...backgroundSteps, ...s.steps]
    }));

    // For backwards compat, the first scenario is the "main" scenario
    const firstScenario = builtScenarios[0] || { name: 'Scenario', steps: [] };

    const scenario: GherkinScenario = {
      feature: featureTitle || 'Feature',
      name: firstScenario.name,
      steps: firstScenario.steps
    } as unknown as GherkinScenario;

    const parsed: ParsedScenario = {
      scenario,
      errors: issues
    } as ParsedScenario;

    // Attach all scenarios + feature metadata for test suite generation
    (parsed as any).__scenarios = builtScenarios;
    (parsed as any).__featureTitle = featureTitle || 'Feature';
    (parsed as any).__featureDescription = featureDescription;
    (parsed as any).__featureTags = [...featureTags];

    // `# itb:` header block — carries anything path-shaped (scriptlet
    // locations), which tags cannot hold because they are lowercased and
    // whitespace-split. A malformed block is reported, never fatal.
    const { header, issues: headerIssues } = parseITBHeader(text);
    (parsed as any).__itbHeader = header;
    for (const h of headerIssues) {
      issues.push({ line: h.line, severity: 'warning', message: h.message });
    }

    return parsed;
  }

  /** Classify a step's text against the catalog: which component (plugin
   *  dialect) provides it? Returns null for core-language steps AND for
   *  unmatched text (unmatched is already reported by expandStep as an issue).
   *  Used by the editor to highlight plugin-provided steps distinctly. */
  classifyStepText(text: string): { componentId: string; componentName: string } | null {
    if (!this.catalog) return null;
    const t = normalizeSpaces(text.trim());
    for (const entry of this.catalog.steps) {
      try {
        if (!new RegExp(entry.match, 'i').test(t)) continue;
      } catch { continue; }
      return entry._source
        ? { componentId: entry._source.componentId, componentName: entry._source.componentName }
        : null;
    }
    return null;
  }

  /** Expand a single step to IR actions using the language catalog.
   *  `state` carries the scenario's declared actors and variable types; pass
   *  one per scenario so kind checks and type dispatch can work. */
  expandStep(step: Step, state: ScenarioState = newScenarioState()): { actions: IRAction[]; mappingLabel?: string; issues: ParseIssue[] } {
    const issues: ParseIssue[] = [];
    const text = normalizeSpaces(step.text.trim());

    if (!this.catalog) {
      issues.push({ line: step.line, severity: 'error', message: 'Language catalog not loaded' });
      return { actions: [], issues };
    }

    let skipped: string | undefined;
    for (const entry of this.catalog.steps) {
      if (!entry.match) continue;
      const re = new RegExp(entry.match, 'i');
      const m = re.exec(text);
      if (!m) continue;

      // 0) Component availability check — warn if step requires a disabled component
      if (entry._source && !entry._source.enabled) {
        issues.push({
          line: step.line,
          severity: 'warning',
          message: `Step requires component "${entry._source.componentName}" which is not enabled`,
        });
      }

      // 1) Table validation
      if (entry.table?.required?.length) {
        if (!step.table || step.table.length === 0) {
          issues.push({ line: step.line, severity: 'error', message: 'Step requires a table' });
          return { actions: [], issues };
        }
        const missing = entry.table.required.filter(k => !Object.keys(step.table![0]).includes(k));
        if (missing.length) {
          issues.push({ line: step.line, severity: 'error', message: `Missing columns: ${missing.join(', ')}` });
          return { actions: [], issues };
        }
      }

      // 2) Requirements check
      const reqs = Array.isArray(entry.requires) ? entry.requires : (entry.requires ? [entry.requires] : []);
      for (const req of reqs) {
        const available = this.services[req.service];
        const ok = !!available && (!req.version || satisfies(available, req.version));
        if (!ok) {
          issues.push({
            line: step.line,
            severity: this.strictRequirements ? 'error' : 'warning',
            message: !available
              ? `Missing required service "${req.service}" for step "${text}"`
              : `Service "${req.service}" version ${available} does not satisfy requirement ${req.version}`
          });
        }
      }

      const label = (entry.text ?? entry.match).replace(/^\^|\$$/g, '');

      // 3) v1 entry: raw regex groups, as always.
      if (!entry.params) {
        const ctx: MaterializeCtx = { groups: m.slice(1), tableRows: step.table || [], docString: step.docString || '' };
        const actions = materialize(entry.actions, ctx);
        this.noteDeclarations(actions, state);
        this.checkInteractions(actions, state, step, issues);
        return { actions, mappingLabel: label, issues };
      }

      // 4) v2 entry: typed slots. A kind mismatch is not yet an error: the
      // same text may be served by another dialect's entry further down
      // (`validates … on SmartHelper` vs `… on FHIRValidator`).
      const result = this.expandTyped(entry, m, step, state, issues);
      if (result === null) return { actions: [], issues };
      if (!Array.isArray(result)) { skipped = skipped ?? result.skip; continue; }
      this.noteDeclarations(result, state);
      this.checkInteractions(result, state, step, issues);
      return { actions: result, mappingLabel: label, issues };
    }

    issues.push({ line: step.line, severity: 'error', message: skipped ?? `No mapping for step: "${text}"` });
    return { actions: [], issues };
  }

  /** Record actor declarations from the IR into the scenario state. */
  private noteDeclarations(actions: IRAction[], state: ScenarioState): void {
    for (const a of actions) {
      if (a.type === 'declareActor') {
        const prev = state.actors.get(a.id) ?? {};
        state.actors.set(a.id, { role: a.role || prev.role, kind: a.kind || prev.kind });
      }
    }
  }

  /**
   * An <interact with="X"> may only name a SUT actor (ITB TDL-034). When a
   * step addresses a simulated actor ("Client is informed …" while Client is
   * infrastructure), say so and route the interaction to whoever runs the
   * session instead of shipping a suite ITB will refuse.
   */
  private checkInteractions(actions: IRAction[], state: ScenarioState, step: Step, issues: ParseIssue[]): void {
    for (const a of actions) {
      if (a.type !== 'interact' || !a.with) continue;
      // No declarations at all: the generator's default makes Client the SUT.
      const role = state.actors.size === 0 && a.with === 'Client' ? 'SUT' : state.actors.get(a.with)?.role;
      if (role === 'SUT') continue;
      issues.push({
        line: step.line, severity: 'warning',
        message: `${a.with} is not the system under test, so this interaction is shown to whoever runs the session. ITB only routes an interaction to a SUT actor — address the SUT, or accept the default`,
      });
      a.with = '';
    }
  }

  /** Expand a v2 (typed) entry. Returns null when an issue stops expansion,
   *  or { skip } when the entry does not apply to the declared actors. */
  private expandTyped(entry: CatalogStep, m: RegExpExecArray, step: Step, state: ScenarioState, issues: ParseIssue[]): IRAction[] | { skip: string } | null {
    const catalog = this.catalog!;
    const params = entry.params!;
    const refs = catalog.refs ?? {};
    const slots: SlotValue[] = params.map((p, i) => slotValue(p, m[i + 1], refs));
    const err = (message: string) => { issues.push({ line: step.line, severity: 'error', message }); };
    const warn = (message: string) => { issues.push({ line: step.line, severity: 'warning', message }); };

    // Actors that must be of a kind: check, or fill in when omitted.
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p.type !== 'actor' || !p.kind) continue;
      const wantedComponent = catalog.kinds?.[p.kind];
      const sameDialect = (k?: string) => !!k && !!wantedComponent && catalog.kinds?.[k] === wantedComponent;
      if (m[i + 1]) {
        const id = m[i + 1];
        const a = state.actors.get(id);
        if (!a) {
          warn(`${id} is not declared in this scenario — declare it with "${id} is a ${p.kind} at \"http://…\""`);
        } else if (a.kind && a.kind !== p.kind && !sameDialect(a.kind)) {
          return { skip: `${id} is declared as a ${a.kind}, but this step needs a ${p.kind}` };
        }
        continue;
      }
      const candidates = [...state.actors.entries()].filter(([, a]) => a.kind === p.kind || sameDialect(a.kind)).map(([id]) => id);
      if (candidates.length === 1) {
        slots[i] = { expr: candidates[0], raw: candidates[0] };
      } else if (candidates.length === 0) {
        return { skip: `This step needs an actor declared as "is a ${p.kind}" — none is declared in this scenario` };
      } else {
        err(`Several actors are a ${p.kind} (${candidates.join(', ')}) — say which one with "on <Actor>"`);
        return null;
      }
    }

    // Options table: | option | value | rows -> $opt.<name>
    const options: Record<string, string> = {};
    for (const row of step.table ?? []) {
      if (row.option !== undefined) options[row.option.trim()] = (row.value ?? '').trim();
    }

    const ctx: MaterializeCtx = {
      groups: slots.map(s => s.raw),
      slots,
      tableRows: step.table || [],
      docString: step.docString || '',
      options,
      extra: {},
    };

    // `bind:` — named values for the templates, computed from the captures.
    for (const [k, v] of Object.entries(entry.bind ?? {})) ctx.extra![k] = substitute(v, ctx);

    const subjectIdx = params.findIndex(p => p.type === 'ref');
    const subject = subjectIdx >= 0 ? slots[subjectIdx] : undefined;
    const subjectVar = subject?.name?.split('.')[0];
    const subjectType = subjectVar ? state.varTypes.get(subjectVar) : undefined;

    // $target / $targetBase for the templates: the first kind-qualified actor
    // slot when the step has one, else (for a dialect verb that mentions
    // $target) the one declared actor of the dialect's kind.
    const kindSlot = params.findIndex(p => p.type === 'actor' && !!p.kind);
    if (kindSlot >= 0 && slots[kindSlot].raw) {
      ctx.extra!.target = slots[kindSlot].raw;
      ctx.extra!.targetBase = `$${slots[kindSlot].raw}Base`;
    } else if (entry._source && !entry.dispatch && JSON.stringify(entry.actions).includes('$target')) {
      if (!this.bindTarget(entry._source.componentId, state, ctx, err)) return null;
    }

    if (entry.dispatch === 'type') {
      // `$x is a <type>` — compile-time typing, nothing to run.
      const typeIdx = params.findIndex(p => p.type === 'type');
      const typeName = slots[typeIdx]?.raw ?? '';
      const key = Object.entries(catalog.types ?? {}).find(([k, t]) => (t.name ?? k).toLowerCase() === typeName.toLowerCase())?.[0];
      if (!key || !subjectVar) { err(`Unknown value type "${typeName}"`); return null; }
      state.varTypes.set(subjectVar, key);
      ctx.extra!.subject = subject!.expr;
      ctx.extra!.type = key;
      return materialize(entry.actions, ctx);
    }

    if (entry.dispatch === 'path') {
      const pathIdx = params.findIndex(p => p.type === 'path' || p.type === 'string');
      if (!subject || pathIdx < 0) { err(`Step "${entry.text}" dispatches on a path but has no {ref} and {path} slots`); return null; }
      const pathText = slots[pathIdx].raw;
      const outVar = entry.pathOutput ? slots[entry.pathOutput - 1].raw : 'pathValue';
      ctx.extra!.subject = subject.expr;
      ctx.extra!.path = pathText;
      ctx.extra!.pathVar = outVar;
      ctx.extra!.pathValue = '$' + outVar;
      let evaluator: { actions: CatalogAction[]; outputType?: string } | undefined;
      if (pathText.startsWith('/')) {
        evaluator = catalog.pathEvaluators?.['json-pointer'];
        if (!evaluator) { err('The core language has no JSON pointer evaluator'); return null; }
      } else {
        let decl = subjectType ? catalog.types?.[subjectType] : undefined;
        if (!decl && !subjectType) {
          // Untyped value: when exactly one path-capable dialect has an actor
          // declared in this scenario, its path language is the only thing
          // "Bundle.type" can mean — use it, so a raw response body can take
          // a FHIRPath without ceremony. Two candidates need a declaration.
          const declaredKinds = new Set([...state.actors.values()].map(a => a.kind).filter(Boolean) as string[]);
          const usable = Object.values(catalog.types ?? {}).filter(t => t.path && t.componentId
            && [...declaredKinds].some(k => catalog.kinds?.[k] === t.componentId));
          const byComponent = new Map(usable.map(t => [t.componentId!, t]));
          if (byComponent.size === 1) decl = [...byComponent.values()][0];
        }
        if (!decl?.path) {
          err(subjectType
            ? `Values of type ${subjectType} have no path language, so "${pathText}" cannot be evaluated on $${subject.raw}`
            : `$${subject.raw} has no known type, so "${pathText}" cannot be evaluated on it — bind it with a typed step, declare it ("$${subjectVar} is a FHIR resource"), or use a JSON pointer ("/…")`);
          return null;
        }
        evaluator = decl.path;
        if (!this.bindTarget(decl.componentId, state, ctx, err, decl.path.kind)) return null;
      }
      const actions = [...materialize(evaluator.actions, ctx), ...materialize(entry.actions, ctx)];
      if (entry.pathOutput) {
        if (evaluator.outputType) state.varTypes.set(outVar, evaluator.outputType);
        else state.varTypes.delete(outVar);
      }
      return actions;
    }

    if (entry.dispatch === 'conforms') {
      const profileIdx = params.findIndex(p => p.type === 'canonical' || p.type === 'string' || p.type === 'value');
      const targetIdx = params.findIndex(p => p.type === 'actor');
      if (!subject) { err(`Step "${entry.text}" dispatches on conformance but has no {ref} slot`); return null; }
      ctx.extra!.subject = subject.expr;
      ctx.extra!.profile = profileIdx >= 0 ? slots[profileIdx].raw : '';
      // Which dialect checks conformance: the named target's, the subject
      // type's, or the only one whose actor is declared.
      let componentId: string | undefined;
      const targetId = targetIdx >= 0 ? slots[targetIdx].raw : '';
      if (targetId) {
        const kind = state.actors.get(targetId)?.kind;
        componentId = kind ? catalog.kinds?.[kind] : undefined;
        if (!componentId || !catalog.conforms?.[componentId]) {
          err(`${targetId} is ${kind ? `a ${kind}, which` : 'not declared with a kind, so it'} cannot check conformance — declare it as a validator ("${targetId} is a fhir-validator at …")`);
          return null;
        }
        ctx.extra!.target = targetId;
        ctx.extra!.targetBase = `$${targetId}Base`;
      } else {
        componentId = subjectType ? catalog.types?.[subjectType]?.componentId : undefined;
        if (!componentId || !catalog.conforms?.[componentId]) {
          const declaredKinds = new Set([...state.actors.values()].map(a => a.kind).filter(Boolean) as string[]);
          const usable = [...declaredKinds].map(k => catalog.kinds?.[k]).filter((c): c is string => !!c && !!catalog.conforms?.[c]);
          const unique = [...new Set(usable)];
          if (unique.length === 1) componentId = unique[0];
          else if (unique.length === 0) { err(`No declared actor can check conformance — declare a validator ("FHIRValidator is a fhir-validator at …")`); return null; }
          else { err(`Several declared validators could check this (${unique.join(', ')}) — say which with "on <Actor>"`); return null; }
        }
        if (!this.bindTarget(componentId, state, ctx, err, catalog.conforms![componentId].kind)) return null;
      }
      const handler = catalog.conforms![componentId];
      return [...materialize(handler.actions, ctx), ...materialize(entry.actions, ctx)];
    }

    // Plain verb.
    const actions = materialize(entry.actions, ctx);
    if (entry.output?.type) {
      const lastVar = [...params.keys()].reverse().find(i => params[i].type === 'var' && slots[i].raw);
      if (lastVar !== undefined) state.varTypes.set(slots[lastVar].raw, entry.output.type);
    }
    return actions;
  }

  /** Resolve the one declared actor a dialect's handler should talk to, and
   *  expose it as $target / $targetBase. */
  private bindTarget(componentId: string | undefined, state: ScenarioState, ctx: MaterializeCtx, err: (m: string) => void, onlyKind?: string): boolean {
    const catalog = this.catalog!;
    if (!componentId) return true;
    if (ctx.extra?.target) return true;
    const kindsOf = Object.entries(catalog.kinds ?? {})
      .filter(([k, c]) => c === componentId && (!onlyKind || k === onlyKind))
      .map(([k]) => k);
    const candidates = [...state.actors.entries()].filter(([, a]) => a.kind && kindsOf.includes(a.kind)).map(([id]) => id);
    if (candidates.length === 1) {
      ctx.extra!.target = candidates[0];
      ctx.extra!.targetBase = `$${candidates[0]}Base`;
      return true;
    }
    if (candidates.length === 0) {
      err(`This step needs an actor of kind ${kindsOf.join(' or ') || componentId} — declare one ("Validator is a ${kindsOf[0] ?? componentId} at \"http://…\"")`);
      return false;
    }
    err(`Several actors could serve this step (${candidates.join(', ')}) — say which one with "on <Actor>"`);
    return false;
  }

  getStepMapping(text: string): string | null {
    if (!this.catalog) {
      // fire & forget; next render will have it
      this.ensureCatalog('en').catch(() => {});
      return null;
    }
    for (const entry of this.catalog.steps) {
      if (new RegExp(entry.match, 'i').test(normalizeSpaces(text.trim()))) {
        return entry.match.replace(/^\^|\$$/g, '');
      }
    }
    return null;
  }

  /** Parse (if needed), load catalog, expand steps → IR; append issues to parsed.errors */
  async expandScenarioToIR(parsed: ParsedScenario) {
    const tags: string[] = (parsed as any).__featureTags ?? [];
    await this.ensureCatalog('en', { legacy: wantsLegacyCore(tags) });
    const allIssues: ParseIssue[] = [];

    // Expand all scenarios
    const scenarios = (parsed as any).__scenarios as { name: string; steps: Step[] }[] | undefined;
    const scenarioIRs: { name: string; ir: IRAction[] }[] = [];

    if (scenarios && scenarios.length > 0) {
      for (const sc of scenarios) {
        const scIr: IRAction[] = [];
        const state = newScenarioState();
        for (const s of sc.steps) {
          const { actions, issues } = this.expandStep(s, state);
          allIssues.push(...issues);
          scIr.push(...actions);
        }
        allIssues.push(...checkActors(sc.steps, state));
        scenarioIRs.push({ name: sc.name, ir: scIr });
      }
    } else {
      // Fallback: single scenario from parsed.scenario.steps
      const ir: IRAction[] = [];
      const state = newScenarioState();
      for (const s of parsed.scenario.steps) {
        const { actions, issues } = this.expandStep(s, state);
        allIssues.push(...issues);
        ir.push(...actions);
      }
      allIssues.push(...checkActors(parsed.scenario.steps, state));
      scenarioIRs.push({ name: parsed.scenario.name || 'Test Case', ir });
    }

    (parsed as any).__scenarioIRs = scenarioIRs;
    (parsed as any).__ir = scenarioIRs[0]?.ir ?? []; // backwards compat
    // Background steps are expanded once per scenario, so an issue on a
    // Background line would repeat once per scenario. Report each once.
    const seen = new Set<string>();
    const unique = [...(parsed.errors || []), ...allIssues].filter(i => {
      const key = `${i.line ?? ''}|${i.severity}|${i.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    parsed.errors = unique;
    return parsed;
  }
}

/** Helpers */

/**
 * Rules about actors that ITB enforces on deploy and the generator cannot
 * bend: a test case needs a system under test (a suite without one cannot be
 * bound to a conformance statement, and TDL-034 rejects any <interact> that
 * names something else). Said here, at compile time and with a line.
 */
function checkActors(steps: Step[], state: ScenarioState): ParseIssue[] {
  const issues: ParseIssue[] = [];
  const line = steps[0]?.line ?? 1;
  if (state.actors.size === 0) {
    issues.push({
      line, severity: 'warning',
      message: 'No actors declared — "Client" is assumed to be the system under test. Declare one: <Actor> is the system under test',
    });
  } else if (![...state.actors.values()].some(a => a.role === 'SUT')) {
    const ids = [...state.actors.keys()].join(', ');
    issues.push({
      line, severity: 'error',
      message: `No system under test among the declared actors (${ids}) — one of them must be declared with "<Actor> is the system under test"`,
    });
  }
  return issues;
}

function splitRow(line: string): string[] {
  // split | a | b | c |  -> ["a","b","c"] (trimmed)
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map(c => c.trim());
}

/**
 * Post-process IR actions: when a send action's body input contains a JSON string
 * with embedded $varName references (from a Gherkin docstring), expand it into
 * TemplateProcessor + assign actions. This produces proper JSON escaping via freemarker.
 *
 * Before:
 *   send { body: '{"qr_data":"$rawQRData","include_raw":true}' }
 *
 * After:
 *   assign to="docTplParams{rawQRData}" value="$rawQRData"
 *   assign to="docTpl" value='{"qr_data":"${rawQRData?json_string}","include_raw":true}'
 *   process handler="TemplateProcessor" operation="process" output="docBody" ...
 *   send { body: '$docBody' }
 */
function expandDocStringTemplates(ir: IRAction[]): IRAction[] {
  const result: IRAction[] = [];
  let tplCounter = 0;

  for (const action of ir) {
    if (action.type !== 'send' || !action.inputs?.body) {
      result.push(action);
      continue;
    }

    const body = action.inputs.body;
    // Detect: body contains JSON with $varName references (not already a $variable or expression)
    const varRefRegex = /\$([a-zA-Z_]\w*)/g;
    // Only expand if body looks like a JSON literal with embedded $var refs
    // (starts with { and contains $varName that isn't $docString or $$actorBase patterns)
    const trimmed = body.trim();
    if (!trimmed.startsWith('{') || !varRefRegex.test(trimmed)) {
      result.push(action);
      continue;
    }

    // Collect unique variable references
    const vars = new Set<string>();
    let m;
    const re = /\$([a-zA-Z_]\w*)/g;
    while ((m = re.exec(trimmed)) !== null) {
      vars.add(m[1]);
    }

    if (vars.size === 0) {
      result.push(action);
      continue;
    }

    tplCounter++;
    const paramsVar = `docTplParams${tplCounter > 1 ? tplCounter : ''}`;
    const tplVar = `docTpl${tplCounter > 1 ? tplCounter : ''}`;
    const bodyVar = `docBody${tplCounter > 1 ? tplCounter : ''}`;

    // Generate assign actions for template parameters
    for (const varName of vars) {
      result.push({
        type: 'assign',
        to: `${paramsVar}{${varName}}`,
        value: `$${varName}`,
      });
    }

    // Build freemarker template: replace $varName with ${varName?json_string}
    // But if the $var is already inside quotes (JSON value), use ?json_string
    // If not inside quotes (raw JSON fragment), just use ${varName}
    let tplString = trimmed;
    for (const varName of vars) {
      // Check if $varName appears inside double-quoted JSON values: "...$varName..."
      // If so, use ?json_string for safe escaping
      // Simple heuristic: if preceded by " (possibly with other chars), it's a quoted value
      tplString = tplString.replace(
        new RegExp(`\\$${varName}`, 'g'),
        `\${${varName}?json_string}`
      );
    }

    // Assign the template string (single-quoted for TDL)
    result.push({
      type: 'assign',
      to: tplVar,
      value: `'${tplString}'`,
    });

    // Process via TemplateProcessor
    result.push({
      type: 'process',
      handler: 'TemplateProcessor',
      operation: 'process',
      output: bodyVar,
      inputs: {
        syntax: '"freemarker"',
        template: `$${tplVar}`,
        parameters: `$${paramsVar}`,
      },
    });

    // Replace body in the send action
    const newInputs = { ...action.inputs, body: `$${bodyVar}` };
    result.push({ ...action, inputs: newInputs });
  }

  return result;
}

/** What the action templates can refer to while a step is materialised. */
export interface MaterializeCtx {
  /** Raw capture text per group (v1: exactly the regex groups). */
  groups: string[];
  /** v2 only: typed slot values per group. */
  slots?: SlotValue[];
  tableRows: Record<string, string>[];
  docString: string;
  /** v2: `| option | value |` rows -> $opt.<name>. */
  options?: Record<string, string>;
  /** v2: named values ($subject, $path, $target, $targetBase, bind: ...). */
  extra?: Record<string, string>;
  _row?: Record<string, string>;
}

/**
 * Substitute `$...` references in one template string.
 *
 * v1 entries see `$N` = raw group text, `$$N` = "$" + text.
 * v2 entries see `$N` = the slot's TDL expression, `$N.raw` = its text,
 * `$$N` = "$" + text, `$opt.x` = an option-table value, and any name the
 * parser bound for the step ($subject, $path, $pathValue, $target ...).
 */
/** Stand-in for an omitted optional slot while a template is substituted. */
const OMITTED = '__OMITTED_SLOT__';

function substitute(v: string, ctx: MaterializeCtx): string {
  let result = v.replace(/\$docString/g, () => ctx.docString ?? '');
  if (ctx.slots) {
    const slots = ctx.slots;
    result = result
      .replace(/\$\$([0-9]+)/g, (_: any, i: string) => '$' + (slots[Number(i) - 1]?.raw ?? ''))
      .replace(/\$([0-9]+)\.raw\b/g, (_: any, i: string) => slots[Number(i) - 1]?.raw ?? '')
      .replace(/\$([0-9]+)/g, (_: any, i: string) => {
        const slot = slots[Number(i) - 1];
        // An omitted {value}/{ref} slot (stand-in "") is marked so that ONLY it can be dropped
        // below — a literal "" written in a template (translate(x, " ", ""))
        // is a real argument and must survive.
        return slot?.omitted && slot.expr === '""' ? OMITTED : (slot?.expr ?? '');
      })
      .replace(/\$opt\.([A-Za-z0-9_-]+)/g, (_: any, k: string) => ctx.options?.[k] ?? '');
    const extra = ctx.extra ?? {};
    // Longest names first so $pathValue is not eaten by $path.
    for (const k of Object.keys(extra).sort((a, b) => b.length - a.length)) {
      result = result.replace(new RegExp(`\\$${k}(?![A-Za-z0-9_])`, 'g'), () => extra[k]);
    }
    // An omitted optional slot substitutes to "" — drop it as a trailing
    // concat() argument so `concat($Base, "/path", "")` reads as it should.
    // Any other omitted slot becomes the empty string literal it stood for.
    result = result.replace(new RegExp('(,\\s*' + OMITTED + ')+\\)', 'g'), ')');
    result = result.split(OMITTED).join('""');
  } else {
    result = result.replace(/\$([0-9]+)/g, (_: any, i: string) => ctx.groups[Number(i) - 1] ?? '');
  }
  return result.replace(/\$row\.([A-Za-z0-9_.-]+)/g, (_: any, k: string) => ctx._row?.[k] ?? '');
}

function materialize(actions: CatalogAction[], ctx: MaterializeCtx): IRAction[] {
  const out: IRAction[] = [];
  // For steps with a table but no foreach, make the first row available as $row
  if (!ctx._row && ctx.tableRows?.length > 0) {
    ctx._row = ctx.tableRows[0];
  }
  const subst = (v: any): any => {
    if (typeof v !== 'string') return v;
    let result = substitute(v, ctx);

    // Build dynamic OR expression for status code checks
    // $statusOrExpr → parses status codes from $1 (which contains "422" or "400" or "500" or "422", "400")
    if (result.includes('$statusOrExpr')) {
      const raw = ctx.groups[0] ?? '';
      // Extract all 3-digit codes from patterns like: "422" or "400" or "500"  OR  "422", "400"
      const codes = [...raw.matchAll(/"(\d{3})"/g)].map(m => m[1]);
      const expr = codes
        .map(c => `($lastRequest{response}{status} = "${c}")`)
        .join(' or ');
      result = result.replace(/\$statusOrExpr/g, expr || '"false"');
    }

    // If a pattern like "$N" resolved to "$varName" (quoted variable ref), unwrap
    // the quotes so TDL treats it as a variable reference, not a literal string.
    // e.g. '"$1"' with $1=$expectedSnomed → "$expectedSnomed" → unwrap to $expectedSnomed
    if (/^"\$[a-zA-Z_]\w*(?:\{[^}]*\})*"$/.test(result)) {
      result = result.slice(1, -1);
    }

    // v1 only: resolve reserved keywords to internal variable references.
    // e.g. $$1 where $1 captured "response status" -> $lastRequest{response}{status}
    if (!ctx.slots) result = resolveReservedNames(result);

    return result;
  };

  const visit = (a: any) => {
    const clone = JSON.parse(JSON.stringify(a));

    // `when: '$3'` — skip the action when the guard substitutes to nothing.
    // This is how one typed entry with an optional slot (`( at {url})?`)
    // declares an actor with or without an endpoint assignment.
    if (clone.when !== undefined) {
      if (subst(String(clone.when)).trim() === '') return;
      delete clone.when;
    }

    // `unless: '$3'` — the inverse: skip the action when the guard DOES
    // substitute to something. The pair lets one entry branch on an optional
    // slot, as the core's file-upload verb and the FHIR validator's
    // conformance handler both do.
    //
    // This was documented in GRAMMAR.md and TUTORIAL.md and implemented
    // nowhere, so an action carrying it always ran. The visible symptom was
    // `uploads a file as $x with "prompt"` emitting two <interact> blocks and
    // asking the operator for the same file twice, with no diagnostic.
    if (clone.unless !== undefined) {
      if (subst(String(clone.unless)).trim() !== '') return;
      delete clone.unless;
    }

    if (clone.foreach) {
      for (const [i, row] of ctx.tableRows.entries()) {
        const rctx: MaterializeCtx = { ...ctx, _row: { ...row, __index: String(i + 1) } };
        clone.foreach.do.forEach((child: any) => {
          const before = ctx._row;
          ctx._row = rctx._row;
          visit(child);
          ctx._row = before;
        });
      }
      return;
    }
    if (clone.declareActor) {
      out.push({ type: 'declareActor', id: subst(clone.declareActor.id), name: subst(clone.declareActor.name ?? ''), role: subst(clone.declareActor.role ?? ''), endpoint: subst(clone.declareActor.endpoint ?? ''), canonical: subst(clone.declareActor.canonical ?? ''), kind: subst(clone.declareActor.kind ?? '') || undefined });
      return;
    }
    if (clone.wait) {
      out.push({ type: 'wait', durationMs: subst(clone.wait.durationMs) });
      return;
    }
    if (clone.repeat) {
      // Build the loop body's IR directly. Only a small set of action types
      // make sense inside a `repeat` (send / call / wait / assign / log) —
      // extend if we need richer loop bodies later.
      const sub: IRAction[] = [];
      for (const child of clone.repeat.do) {
        const c2 = JSON.parse(JSON.stringify(child));
        if (c2.send) {
          for (const k in c2.send.inputs) c2.send.inputs[k] = subst(c2.send.inputs[k]);
          sub.push({ type: 'send', id: subst(c2.send.id ?? ''), desc: subst(c2.send.desc ?? ''), handler: c2.send.handler, from: subst(c2.send.from ?? ''), to: subst(c2.send.to ?? ''), inputs: c2.send.inputs });
        } else if (c2.call) {
          if (c2.call.inputs) for (const k in c2.call.inputs) c2.call.inputs[k] = subst(c2.call.inputs[k]);
          sub.push({ type: 'call', path: c2.call.path, output: c2.call.output ? subst(c2.call.output) : undefined, from: subst(c2.call.from ?? ''), to: subst(c2.call.to ?? ''), inputs: c2.call.inputs });
        } else if (c2.wait) {
          sub.push({ type: 'wait', durationMs: subst(c2.wait.durationMs) });
        } else if (c2.assign) {
          sub.push({ type: 'assign', to: subst(c2.assign.to), value: subst(c2.assign.value), append: !!c2.assign.append });
        } else if (c2.log) {
          sub.push({ type: 'log', value: subst(typeof c2.log === 'string' ? c2.log : c2.log.value) });
        }
      }
      // Loop counter handling — three layers, all redundant on purpose so
      // that whichever mechanism this ITB recognises will initialise the
      // variable before the <while>'s cond reads it:
      //   (a) <var> declaration with <value>0</value>          (collectVariables)
      //   (b) top-level <assign to="i">0</assign>        (this push, before repeat)
      //   (c) bump-assign inside the loop body                 (this push, last in `sub`)
      // If (a) is honoured, (b) is harmless; if (a) isn't, (b) saves us.
      out.push({ type: 'assign', to: 'i', value: '0' });
      sub.push({ type: 'assign', to: 'i', value: 'number($i) + 1' });
      out.push({ type: 'repeat', count: subst(clone.repeat.count), do: sub });
      return;
    }
    if (clone.send) {
      for (const k in clone.send.inputs) clone.send.inputs[k] = subst(clone.send.inputs[k]);
      out.push({ type: 'send', id: subst(clone.send.id ?? ''), desc: subst(clone.send.desc ?? ''), handler: clone.send.handler, from: subst(clone.send.from ?? ''), to: subst(clone.send.to ?? ''), txnId: subst(clone.send.txnId ?? ''), inputs: clone.send.inputs });
      return;
    }
    if (clone.log) {
      out.push({ type: 'log', value: subst(typeof clone.log === 'string' ? clone.log : clone.log.value) });
      return;
    }
    if (clone.call) {
      if (clone.call.inputs) for (const k in clone.call.inputs) clone.call.inputs[k] = subst(clone.call.inputs[k]);
      // `inputsFromTable`: each row of the step's table contributes one input,
      // named by its `name` column. Lets one step pattern accept an arbitrary
      // parameter list instead of a fixed set baked into the YAML.
      if (clone.call.inputsFromTable) {
        const built: Record<string, string> = { ...(clone.call.inputs ?? {}) };
        for (const row of ctx.tableRows ?? []) {
          const name = (row.name ?? '').trim();
          if (name) built[name] = subst(row.value ?? '');
        }
        clone.call.inputs = built;
      }
      out.push({
        type: 'call',
        path: subst(clone.call.path),
        output: clone.call.output ? subst(clone.call.output) : undefined,
        from: subst(clone.call.from ?? ''),
        to: subst(clone.call.to ?? ''),
        inputs: clone.call.inputs,
        // Emitted verbatim into the scriptlet — this is the raw-ITB escape
        // hatch, so it is deliberately NOT escaped. Schema validation of the
        // generated file is the safety net.
        body: clone.call.body ? String(clone.call.body).replace(/\$docString/g, ctx.docString ?? '') : undefined,
      });
      return;
    }
    if (clone.verify) {
      for (const k in clone.verify.inputs) clone.verify.inputs[k] = subst(clone.verify.inputs[k]);
      out.push({ type: 'verify', handler: clone.verify.handler, desc: subst(clone.verify.desc ?? ''), inputs: clone.verify.inputs });
      return;
    }
    if (clone.process) {
      for (const k in clone.process.inputs) clone.process.inputs[k] = subst(clone.process.inputs[k]);
      out.push({ type: 'process', handler: clone.process.handler, operation: clone.process.operation, output: clone.process.output ? subst(clone.process.output) : undefined, from: clone.process.from ? subst(clone.process.from) : undefined, to: clone.process.to ? subst(clone.process.to) : undefined, inputs: clone.process.inputs, hidden: clone.process.hidden });
      return;
    }
    if (clone.assign) {
      clone.assign.value = subst(clone.assign.value);
      out.push({ type: 'assign', to: subst(clone.assign.to), value: typeof clone.assign.value === 'string' ? clone.assign.value : JSON.stringify(clone.assign.value), append: clone.assign.append, varType: clone.assign.type });
      return;
    }
    if (clone.listAppend) {
      const item: Record<string,string> = {};
      for (const k in clone.listAppend.item) item[k] = subst(clone.listAppend.item[k]);
      out.push({ type: 'listAppend', list: subst(clone.listAppend.list), item });
      return;
    }
    if (clone.declareVariable) {
      out.push({ type: 'declareVariable', name: subst(clone.declareVariable.name), varType: subst(clone.declareVariable.varType ?? 'string'), value: clone.declareVariable.value != null ? subst(clone.declareVariable.value) : undefined });
      return;
    }
    if (clone.interact) {
      const mkRequest = (r: any, row?: Record<string, string>) => {
        const before = ctx._row;
        if (row) ctx._row = row;
        const out = {
          desc: subst(r.desc ?? ''),
          name: subst(r.name ?? ''),
          inputType: r.inputType,
          required: r.required,
          variable: subst(r.variable ?? ''),
          options: r.options !== undefined ? subst(r.options) : undefined,
          optionLabels: r.optionLabels !== undefined ? subst(r.optionLabels) : undefined,
        };
        ctx._row = before;
        return out;
      };
      // `requestsFromTable`: one request per table row, from the template
      // request, with $row.<col> and $row.__index available — how a single
      // dialog asks the operator to confirm each item of a list.
      const requests = clone.interact.requestsFromTable
        ? (ctx.tableRows ?? []).map((row, i) => mkRequest(clone.interact.requestsFromTable, { ...row, __index: String(i + 1) }))
        : (clone.interact.requests || []).map((r: any) => mkRequest(r));
      const instructions = (clone.interact.instructions || []).map((i: any) => ({
        desc: subst(i.desc ?? ''),
        name: subst(i.name ?? ''),
        value: subst(i.value ?? ''),
        // Display hints (gitb_tdl: forceDisplay shows the value inline rather
        // than in an editor; level stylises it; mimeType highlights it).
        forceDisplay: i.forceDisplay,
        level: i.level,
        mimeType: i.mimeType,
      }));
      // Both title spellings are carried through unchanged — see the note in
      // xmlGenerator: this XSD lags the running ITB, so `inputTitle` being
      // absent from it does not mean ITB ignores it.
      out.push({
        type: 'interact',
        id: subst(clone.interact.id ?? ''),
        desc: subst(clone.interact.desc ?? ''),
        title: subst(clone.interact.title ?? ''),
        inputTitle: subst(clone.interact.inputTitle ?? ''),
        with: subst(clone.interact.with ?? ''),
        instructions,
        requests,
      });
      return;
    }
    if (clone.btxn) {
      out.push({ type: 'btxn', txnId: subst(clone.btxn.txnId), from: subst(clone.btxn.from), to: subst(clone.btxn.to), handler: clone.btxn.handler });
      return;
    }
    if (clone.etxn) {
      out.push({ type: 'etxn', txnId: subst(clone.etxn.txnId) });
      return;
    }
    if (clone.receive) {
      if (clone.receive.inputs) for (const k in clone.receive.inputs) clone.receive.inputs[k] = subst(clone.receive.inputs[k]);
      out.push({ type: 'receive', id: subst(clone.receive.id ?? ''), desc: subst(clone.receive.desc ?? ''), handler: clone.receive.handler, from: subst(clone.receive.from ?? ''), to: subst(clone.receive.to ?? ''), txnId: subst(clone.receive.txnId ?? ''), inputs: clone.receive.inputs });
      return;
    }
  };

  actions.forEach(visit);

  // Post-processing: when a send action's body contains JSON with $var references
  // (from a docstring), expand it into TemplateProcessor + assign chain.
  // This ensures proper JSON escaping via freemarker ?json_string.
  return expandDocStringTemplates(out);
}

/** Semver helpers (very small, supports >=, >, =, <=, < with x.y[.z]) */
/** Reserved keywords that resolve to internal TDL variable paths */
const RESERVED_NAMES: Record<string, string> = {
  'response status': '$lastRequest{response}{status}',
  'response body': '$lastRequest{response}{body}',
  'response': '$lastRequest{response}{body}',
  'validation errors': '$validationErrors',
  'validation warnings': '$validationWarnings',
  'validation outcome': '$validationOutcome',
  'validation severity': '$validationSeverity',
};

/** Replace reserved name references with their TDL variable paths.
 *  Handles both bare `$reservedName` (from $$1 substitution) and
 *  quoted `"reservedName"` contexts. */
function resolveReservedNames(s: string): string {
  for (const [name, path] of Object.entries(RESERVED_NAMES)) {
    // $$1 substitution produces $<captured-text> — if that text is a reserved name
    // e.g. $$1 with $1="response status" → $response status → replace with path
    s = s.replace(new RegExp(`\\$${name.replace(/\s/g, '\\s')}(?![a-zA-Z0-9_])`, 'g'), path);
  }
  return s;
}

/** Normalize multiple spaces to single, but preserve whitespace inside quotes */
function normalizeSpaces(s: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      // Find closing quote
      const end = s.indexOf('"', i + 1);
      if (end > i) {
        parts.push(s.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    // Outside quotes — collapse whitespace
    let j = i;
    while (j < s.length && s[j] !== '"') j++;
    parts.push(s.slice(i, j).replace(/\s+/g, ' '));
    i = j;
  }
  return parts.join('');
}

function satisfies(actual: string, requirement: string): boolean {
  // requirement examples: ">=1.0", ">2.0.1", "1.3.0", "<=2.1"
  const m = requirement.match(/^\s*(>=|<=|>|<|=)?\s*([0-9]+(?:\.[0-9]+){0,2})\s*$/);
  if (!m) return false;
  const op = (m[1] || '>=').trim();
  const req = m[2];
  const cmp = compareVersions(normalize(actual), normalize(req));
  switch (op) {
    case '>':  return cmp > 0;
    case '>=': return cmp >= 0;
    case '<':  return cmp < 0;
    case '<=': return cmp <= 0;
    case '=':  return cmp === 0;
    default:   return cmp >= 0;
  }
}

function normalize(v: string): [number, number, number] {
  const parts = v.split('.').map(n => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareVersions(a: [number,number,number], b: [number,number,number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function stripInlineComments(raw: string): string {
  // removes '#' and everything after, unless inside quotes
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '#' && !inDouble && !inSingle) {
      return raw.slice(0, i);
    }
  }
  return raw;
}