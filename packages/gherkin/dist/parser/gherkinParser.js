/** Parse a Gherkin doc string (triple-quoted block) starting at line index i+1 */
function parseDocString(lines, startIdx) {
    let j = startIdx;
    // skip blank lines
    while (j < lines.length && lines[j].trim() === '')
        j++;
    if (j >= lines.length)
        return null;
    const openMatch = /^(\s*)"""(.*)$/.exec(lines[j]);
    if (!openMatch)
        return null;
    const indent = openMatch[1].length;
    const firstLine = openMatch[2]; // content after opening """
    const contentLines = [];
    if (firstLine.trim())
        contentLines.push(firstLine);
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
import { loadCatalog, loadAllComponents, mergeCatalog } from './languageCatalog.js';
import { parseITBHeader } from './itbHeader.js';
/** Minimal, self-contained parser + catalog expander */
export class GherkinParser {
    catalog;
    model;
    services;
    strictRequirements;
    components = [];
    constructor(model, options) {
        this.model = model;
        this.services = options?.services ?? {};
        this.strictRequirements = options?.strictRequirements ?? false; // warning by default
    }
    /** Loads /lang/en.yml + enabled component extensions, merges them */
    async ensureCatalog(locale = 'en') {
        if (!this.catalog) {
            const core = await loadCatalog(locale);
            this.components = await loadAllComponents(core);
            this.catalog = mergeCatalog(core, this.components);
        }
    }
    /** Get loaded components (available after ensureCatalog) */
    getComponents() {
        return this.components;
    }
    /** Basic Gherkin parser: Feature/Scenarios/Steps (+ DataTables) -> ParsedFeature
     *  Supports multiple scenarios; Background steps are shared across all scenarios. */
    parse(text) {
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const issues = [];
        let inFeaturePreamble = false;
        let featureDescription = '';
        let featureTitle = '';
        const backgroundSteps = [];
        const scenarios = [];
        let currentTarget = null; // null = not collecting steps yet
        let currentScenarioName = '';
        // Gherkin @tags. Collected feature-wide (we don't currently need
        // per-scenario scoping). Recognised control tags:
        //   @continue-on-error / @non-blocking → testcase <steps stopOnError="false">
        //     (checks still report red and still fail the test overall — they just
        //      don't abort the remaining steps; mirrors the hand-written suites).
        const featureTags = new Set();
        const STEP_RE = /^(Given|When|Then|And|But)\s+(.*)$/i;
        let i = 0;
        while (i < lines.length) {
            const raw = lines[i];
            const lineNo = i + 1;
            const line = stripInlineComments(raw).trim();
            if (!line) {
                i++;
                continue;
            }
            // Tag line(s): `@foo @bar` — Gherkin tags precede Feature/Scenario.
            // Collected feature-wide; consumed here so they don't warn as unknown.
            if (/^@/.test(line)) {
                for (const tok of line.split(/\s+/)) {
                    if (tok.startsWith('@'))
                        featureTags.add(tok.slice(1).toLowerCase());
                }
                i++;
                continue;
            }
            if (/^Feature:/i.test(line)) {
                featureTitle = line.replace(/^Feature:\s*/i, '').trim();
                inFeaturePreamble = true;
                i++;
                continue;
            }
            if (/^Background:/i.test(line)) {
                inFeaturePreamble = false;
                currentTarget = backgroundSteps;
                i++;
                continue;
            }
            if (/^Scenario:/i.test(line)) {
                currentScenarioName = line.replace(/^Scenario:\s*/i, '').trim();
                const scenarioSteps = [];
                scenarios.push({ name: currentScenarioName, steps: scenarioSteps });
                currentTarget = scenarioSteps;
                inFeaturePreamble = false;
                i++;
                continue;
            }
            if (inFeaturePreamble) {
                // Collect feature description lines
                if (featureDescription)
                    featureDescription += ' ';
                featureDescription += line;
                i++;
                continue;
            }
            if (!currentTarget) {
                i++;
                continue;
            }
            const m = STEP_RE.exec(line);
            if (m) {
                const type = m[1];
                const text = m[2].trim();
                // optional data table
                const tableRows = [];
                let j = i + 1;
                while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
                    const row = splitRow(stripInlineComments(lines[j]));
                    if (tableRows.length === 0) {
                        tableRows.push(Object.fromEntries(row.map((h) => [h, h])));
                    }
                    else {
                        const header = Object.keys(tableRows[0]);
                        const obj = {};
                        header.forEach((h, idx) => { obj[h] = row[idx] ?? ''; });
                        tableRows.push(obj);
                    }
                    j++;
                }
                let table;
                if (tableRows.length > 1)
                    table = tableRows.slice(1);
                // Optional doc string (triple-quoted block). Allowed *after* a table
                // too: `call scriptlet ... with:` takes a table of inputs and a
                // docstring holding the raw TDL body. A GITB scriptlet only sees what
                // its <params> receive, so an inline body without inputs could not
                // reach the enclosing test case's variables.
                let docString;
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
                });
                i = j;
                continue;
            }
            if (/^\s*#/.test(raw)) {
                i++;
                continue;
            }
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
        const scenario = {
            feature: featureTitle || 'Feature',
            name: firstScenario.name,
            steps: firstScenario.steps
        };
        const parsed = {
            scenario,
            errors: issues
        };
        // Attach all scenarios + feature metadata for test suite generation
        parsed.__scenarios = builtScenarios;
        parsed.__featureTitle = featureTitle || 'Feature';
        parsed.__featureDescription = featureDescription;
        parsed.__featureTags = [...featureTags];
        // `# itb:` header block — carries anything path-shaped (scriptlet
        // locations), which tags cannot hold because they are lowercased and
        // whitespace-split. A malformed block is reported, never fatal.
        const { header, issues: headerIssues } = parseITBHeader(text);
        parsed.__itbHeader = header;
        for (const h of headerIssues) {
            issues.push({ line: h.line, severity: 'warning', message: h.message });
        }
        return parsed;
    }
    /** Classify a step's text against the catalog: which component (plugin
     *  dialect) provides it? Returns null for core-language steps AND for
     *  unmatched text (unmatched is already reported by expandStep as an issue).
     *  Used by the editor to highlight plugin-provided steps distinctly. */
    classifyStepText(text) {
        if (!this.catalog)
            return null;
        const t = normalizeSpaces(text.trim());
        for (const entry of this.catalog.steps) {
            try {
                if (!new RegExp(entry.match, 'i').test(t))
                    continue;
            }
            catch {
                continue;
            }
            return entry._source
                ? { componentId: entry._source.componentId, componentName: entry._source.componentName }
                : null;
        }
        return null;
    }
    /** Expand a single step to IR actions using the language catalog */
    expandStep(step) {
        const issues = [];
        const text = normalizeSpaces(step.text.trim());
        if (!this.catalog) {
            issues.push({ line: step.line, severity: 'error', message: 'Language catalog not loaded' });
            return { actions: [], issues };
        }
        for (const entry of this.catalog.steps) {
            const re = new RegExp(entry.match, 'i');
            const m = re.exec(text);
            if (!m)
                continue;
            // 0) Component availability check — warn if step requires a disabled component
            if (entry._source && !entry._source.enabled) {
                issues.push({
                    line: step.line,
                    severity: 'warning',
                    message: `Step requires component "${entry._source.componentName}" which is not enabled`,
                });
            }
            // 1) Table validation (unchanged)
            if (entry.table?.required?.length) {
                if (!step.table || step.table.length === 0) {
                    issues.push({ line: step.line, severity: 'error', message: 'Step requires a table' });
                    return { actions: [], issues };
                }
                const missing = entry.table.required.filter(k => !Object.keys(step.table[0]).includes(k));
                if (missing.length) {
                    issues.push({ line: step.line, severity: 'error', message: `Missing columns: ${missing.join(', ')}` });
                    return { actions: [], issues };
                }
            }
            // 2) REQUIREMENTS CHECK (NEW)
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
            // 3) Expand actions (unchanged)
            const ctx = { groups: m.slice(1), tableRows: step.table || [], docString: step.docString || '' };
            const actions = materialize(entry.actions, ctx);
            const label = entry.match.replace(/^\^|\$$/g, '');
            return { actions, mappingLabel: label, issues };
        }
        issues.push({ line: step.line, severity: 'error', message: `No mapping for step: "${text}"` });
        return { actions: [], issues };
    }
    getStepMapping(text) {
        if (!this.catalog) {
            // fire & forget; next render will have it
            this.ensureCatalog('en').catch(() => { });
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
    async expandScenarioToIR(parsed) {
        await this.ensureCatalog('en');
        const allIssues = [];
        // Expand all scenarios
        const scenarios = parsed.__scenarios;
        const scenarioIRs = [];
        if (scenarios && scenarios.length > 0) {
            for (const sc of scenarios) {
                const scIr = [];
                for (const s of sc.steps) {
                    const { actions, issues } = this.expandStep(s);
                    allIssues.push(...issues);
                    scIr.push(...actions);
                }
                scenarioIRs.push({ name: sc.name, ir: scIr });
            }
        }
        else {
            // Fallback: single scenario from parsed.scenario.steps
            const ir = [];
            for (const s of parsed.scenario.steps) {
                const { actions, issues } = this.expandStep(s);
                allIssues.push(...issues);
                ir.push(...actions);
            }
            scenarioIRs.push({ name: parsed.scenario.name || 'Test Case', ir });
        }
        parsed.__scenarioIRs = scenarioIRs;
        parsed.__ir = scenarioIRs[0]?.ir ?? []; // backwards compat
        parsed.errors = [...(parsed.errors || []), ...allIssues];
        return parsed;
    }
}
/** Helpers */
function splitRow(line) {
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
function expandDocStringTemplates(ir) {
    const result = [];
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
        const vars = new Set();
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
            tplString = tplString.replace(new RegExp(`\\$${varName}`, 'g'), `\${${varName}?json_string}`);
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
function materialize(actions, ctx) {
    const out = [];
    // For steps with a table but no foreach, make the first row available as $row
    if (!ctx._row && ctx.tableRows?.length > 0) {
        ctx._row = ctx.tableRows[0];
    }
    const subst = (v) => {
        if (typeof v !== 'string')
            return v;
        let result = v
            .replace(/\$docString/g, () => ctx.docString ?? '')
            .replace(/\$([0-9]+)/g, (_, i) => ctx.groups[Number(i) - 1] ?? '')
            .replace(/\$row\.([A-Za-z0-9_.]+)/g, (_, k) => ctx._row?.[k] ?? '');
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
        // Resolve reserved keywords to internal variable references.
        // e.g. $$1 where $1 captured "response status" → $lastRequest{response}{status}
        result = resolveReservedNames(result);
        return result;
    };
    const visit = (a) => {
        const clone = JSON.parse(JSON.stringify(a));
        if (clone.foreach) {
            for (const row of ctx.tableRows) {
                const rctx = { ...ctx, _row: row };
                clone.foreach.do.forEach((child) => {
                    const before = ctx._row;
                    ctx._row = rctx._row;
                    visit(child);
                    ctx._row = before;
                });
            }
            return;
        }
        if (clone.declareActor) {
            out.push({ type: 'declareActor', id: subst(clone.declareActor.id), name: subst(clone.declareActor.name ?? ''), role: subst(clone.declareActor.role ?? ''), endpoint: subst(clone.declareActor.endpoint ?? ''), canonical: subst(clone.declareActor.canonical ?? '') });
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
            const sub = [];
            for (const child of clone.repeat.do) {
                const c2 = JSON.parse(JSON.stringify(child));
                if (c2.send) {
                    for (const k in c2.send.inputs)
                        c2.send.inputs[k] = subst(c2.send.inputs[k]);
                    sub.push({ type: 'send', id: subst(c2.send.id ?? ''), desc: subst(c2.send.desc ?? ''), handler: c2.send.handler, from: subst(c2.send.from ?? ''), to: subst(c2.send.to ?? ''), inputs: c2.send.inputs });
                }
                else if (c2.call) {
                    if (c2.call.inputs)
                        for (const k in c2.call.inputs)
                            c2.call.inputs[k] = subst(c2.call.inputs[k]);
                    sub.push({ type: 'call', path: c2.call.path, output: c2.call.output ? subst(c2.call.output) : undefined, from: subst(c2.call.from ?? ''), to: subst(c2.call.to ?? ''), inputs: c2.call.inputs });
                }
                else if (c2.wait) {
                    sub.push({ type: 'wait', durationMs: subst(c2.wait.durationMs) });
                }
                else if (c2.assign) {
                    sub.push({ type: 'assign', to: subst(c2.assign.to), value: subst(c2.assign.value), append: !!c2.assign.append });
                }
                else if (c2.log) {
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
            for (const k in clone.send.inputs)
                clone.send.inputs[k] = subst(clone.send.inputs[k]);
            out.push({ type: 'send', id: subst(clone.send.id ?? ''), desc: subst(clone.send.desc ?? ''), handler: clone.send.handler, from: subst(clone.send.from ?? ''), to: subst(clone.send.to ?? ''), inputs: clone.send.inputs });
            return;
        }
        if (clone.log) {
            out.push({ type: 'log', value: subst(typeof clone.log === 'string' ? clone.log : clone.log.value) });
            return;
        }
        if (clone.call) {
            if (clone.call.inputs)
                for (const k in clone.call.inputs)
                    clone.call.inputs[k] = subst(clone.call.inputs[k]);
            // `inputsFromTable`: each row of the step's table contributes one input,
            // named by its `name` column. Lets one step pattern accept an arbitrary
            // parameter list instead of a fixed set baked into the YAML.
            if (clone.call.inputsFromTable) {
                const built = { ...(clone.call.inputs ?? {}) };
                for (const row of ctx.tableRows ?? []) {
                    const name = (row.name ?? '').trim();
                    if (name)
                        built[name] = subst(row.value ?? '');
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
            for (const k in clone.verify.inputs)
                clone.verify.inputs[k] = subst(clone.verify.inputs[k]);
            out.push({ type: 'verify', handler: clone.verify.handler, desc: subst(clone.verify.desc ?? ''), inputs: clone.verify.inputs });
            return;
        }
        if (clone.process) {
            for (const k in clone.process.inputs)
                clone.process.inputs[k] = subst(clone.process.inputs[k]);
            out.push({ type: 'process', handler: clone.process.handler, operation: clone.process.operation, output: clone.process.output ? subst(clone.process.output) : undefined, from: clone.process.from ? subst(clone.process.from) : undefined, to: clone.process.to ? subst(clone.process.to) : undefined, inputs: clone.process.inputs, hidden: clone.process.hidden });
            return;
        }
        if (clone.assign) {
            clone.assign.value = subst(clone.assign.value);
            out.push({ type: 'assign', to: subst(clone.assign.to), value: typeof clone.assign.value === 'string' ? clone.assign.value : JSON.stringify(clone.assign.value), append: clone.assign.append });
            return;
        }
        if (clone.listAppend) {
            const item = {};
            for (const k in clone.listAppend.item)
                item[k] = subst(clone.listAppend.item[k]);
            out.push({ type: 'listAppend', list: subst(clone.listAppend.list), item });
            return;
        }
        if (clone.declareVariable) {
            out.push({ type: 'declareVariable', name: subst(clone.declareVariable.name), varType: subst(clone.declareVariable.varType ?? 'string'), value: clone.declareVariable.value != null ? subst(clone.declareVariable.value) : undefined });
            return;
        }
        if (clone.interact) {
            const requests = (clone.interact.requests || []).map((r) => ({
                desc: subst(r.desc ?? ''),
                name: subst(r.name ?? ''),
                inputType: r.inputType,
                required: r.required,
                variable: subst(r.variable ?? '')
            }));
            const instructions = (clone.interact.instructions || []).map((i) => ({
                desc: subst(i.desc ?? ''),
                name: subst(i.name ?? ''),
                value: subst(i.value ?? ''),
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
        if (clone.receive) {
            if (clone.receive.inputs)
                for (const k in clone.receive.inputs)
                    clone.receive.inputs[k] = subst(clone.receive.inputs[k]);
            out.push({ type: 'receive', id: subst(clone.receive.id ?? ''), desc: subst(clone.receive.desc ?? ''), handler: clone.receive.handler, from: subst(clone.receive.from ?? ''), to: subst(clone.receive.to ?? ''), inputs: clone.receive.inputs });
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
const RESERVED_NAMES = {
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
function resolveReservedNames(s) {
    for (const [name, path] of Object.entries(RESERVED_NAMES)) {
        // $$1 substitution produces $<captured-text> — if that text is a reserved name
        // e.g. $$1 with $1="response status" → $response status → replace with path
        s = s.replace(new RegExp(`\\$${name.replace(/\s/g, '\\s')}(?![a-zA-Z0-9_])`, 'g'), path);
    }
    return s;
}
/** Normalize multiple spaces to single, but preserve whitespace inside quotes */
function normalizeSpaces(s) {
    const parts = [];
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
        while (j < s.length && s[j] !== '"')
            j++;
        parts.push(s.slice(i, j).replace(/\s+/g, ' '));
        i = j;
    }
    return parts.join('');
}
function satisfies(actual, requirement) {
    // requirement examples: ">=1.0", ">2.0.1", "1.3.0", "<=2.1"
    const m = requirement.match(/^\s*(>=|<=|>|<|=)?\s*([0-9]+(?:\.[0-9]+){0,2})\s*$/);
    if (!m)
        return false;
    const op = (m[1] || '>=').trim();
    const req = m[2];
    const cmp = compareVersions(normalize(actual), normalize(req));
    switch (op) {
        case '>': return cmp > 0;
        case '>=': return cmp >= 0;
        case '<': return cmp < 0;
        case '<=': return cmp <= 0;
        case '=': return cmp === 0;
        default: return cmp >= 0;
    }
}
function normalize(v) {
    const parts = v.split('.').map(n => parseInt(n, 10));
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}
function compareVersions(a, b) {
    if (a[0] !== b[0])
        return a[0] - b[0];
    if (a[1] !== b[1])
        return a[1] - b[1];
    return a[2] - b[2];
}
function stripInlineComments(raw) {
    // removes '#' and everything after, unless inside quotes
    let inDouble = false;
    let inSingle = false;
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
            continue;
        }
        if (ch === '#' && !inDouble && !inSingle) {
            return raw.slice(0, i);
        }
    }
    return raw;
}
