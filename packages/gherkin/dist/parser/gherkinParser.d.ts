import { ParsedScenario, ParseIssue, Step, DataModel } from '../types.js';
import { ComponentInfo } from './languageCatalog.js';
export type IRAction = {
    type: 'call';
    path: string;
    output?: string;
    from?: string;
    to?: string;
    inputs?: Record<string, string>;
    /** Raw TDL supplied inline in the feature file; becomes the scriptlet's <steps> body. */
    body?: string;
} | {
    type: 'send';
    id?: string;
    desc?: string;
    handler: string;
    from?: string;
    to?: string;
    inputs: Record<string, string>;
} | {
    type: 'verify';
    handler: string;
    desc?: string;
    inputs: Record<string, string>;
} | {
    type: 'process';
    handler: string;
    operation: string;
    output?: string;
    from?: string;
    to?: string;
    inputs: Record<string, string>;
    hidden?: boolean;
} | {
    type: 'assign';
    to: string;
    value: string;
    append?: boolean;
} | {
    type: 'log';
    value: string;
} | {
    type: 'listAppend';
    list: string;
    item: Record<string, string>;
} | {
    type: 'foreach';
    from: string;
    do: IRAction[];
} | {
    type: 'repeat';
    count: string;
    do: IRAction[];
} | {
    type: 'wait';
    durationMs: string;
} | {
    type: 'declareActor';
    id: string;
    name?: string;
    role?: string;
    endpoint?: string;
    canonical?: string;
} | {
    type: 'declareVariable';
    name: string;
    varType: string;
    value?: string;
}
/** `with` targets the interaction at one actor (gitb_tdl.xsd: UserInteraction
 *  allows `with` and `title`). It is an actor ID, not a variable, so it can
 *  only be set at compile time — which is fine, because the step names the
 *  actor. `instructions` emit <instruct> (display-only) alongside <request>
 *  (input); the schema allows either, in any mix. */
 | {
    type: 'interact';
    id?: string;
    desc?: string;
    title?: string;
    inputTitle?: string;
    with?: string;
    instructions?: {
        desc: string;
        name?: string;
        value?: string;
    }[];
    requests: {
        desc: string;
        name?: string;
        inputType?: string;
        required?: boolean;
        variable: string;
    }[];
} | {
    type: 'receive';
    id?: string;
    desc?: string;
    handler: string;
    from?: string;
    to?: string;
    inputs?: Record<string, string>;
};
type ServicesMap = Record<string, string>;
/** Minimal, self-contained parser + catalog expander */
export declare class GherkinParser {
    private catalog?;
    private model?;
    private services;
    private strictRequirements;
    private components;
    constructor(model?: DataModel, options?: {
        services?: ServicesMap;
        strictRequirements?: boolean;
    });
    /** Loads /lang/en.yml + enabled component extensions, merges them */
    ensureCatalog(locale?: string): Promise<void>;
    /** Get loaded components (available after ensureCatalog) */
    getComponents(): ComponentInfo[];
    /** Basic Gherkin parser: Feature/Scenarios/Steps (+ DataTables) -> ParsedFeature
     *  Supports multiple scenarios; Background steps are shared across all scenarios. */
    parse(text: string): ParsedScenario;
    /** Classify a step's text against the catalog: which component (plugin
     *  dialect) provides it? Returns null for core-language steps AND for
     *  unmatched text (unmatched is already reported by expandStep as an issue).
     *  Used by the editor to highlight plugin-provided steps distinctly. */
    classifyStepText(text: string): {
        componentId: string;
        componentName: string;
    } | null;
    /** Expand a single step to IR actions using the language catalog */
    expandStep(step: Step): {
        actions: IRAction[];
        mappingLabel?: string;
        issues: ParseIssue[];
    };
    getStepMapping(text: string): string | null;
    /** Parse (if needed), load catalog, expand steps → IR; append issues to parsed.errors */
    expandScenarioToIR(parsed: ParsedScenario): Promise<ParsedScenario>;
}
export {};
