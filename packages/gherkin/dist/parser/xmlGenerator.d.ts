import type { ParsedScenario, ParseIssue } from '../types.js';
export interface GeneratedFile {
    filename: string;
    xml: string;
    type: 'testsuite' | 'testcase' | 'scriptlet';
    id: string;
    name: string;
}
export interface XMLOutput {
    testcaseName: string;
    xml: string;
    files: GeneratedFile[];
    scriptletCount?: number;
    /** Problems raised while generating — currently unresolved scriptlet ids. */
    issues?: ParseIssue[];
}
export declare class XMLGenerator {
    private parser;
    constructor(parser: any);
    /**
     * Scriptlets read from the active file source, keyed by their suite-relative
     * path (`scriptlets/<id>.xml`). Loaded asynchronously by the app, so they are
     * pushed in rather than fetched here — generate() stays synchronous.
     */
    private externalScriptlets;
    setExternalScriptlets(scriptlets: Map<string, string>): void;
    /** Collect all scriptlets from enabled components loaded by the parser */
    private getComponentScriptlets;
    generate(parsed: ParsedScenario): XMLOutput;
}
