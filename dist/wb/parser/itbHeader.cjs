"use strict";
// The `# itb:` header block.
//
// Gherkin @tags carry the version declarations (@lang:, @dialect:) because they
// are short and shaped like identifiers. They cannot carry paths: the parser
// lowercases every tag, and a tag may not contain whitespace. A path that
// silently lowercases works on Windows and breaks in the Linux container that
// runs the suite — the worst kind of bug.
//
// So anything path- or URL-shaped goes in a YAML block written as leading
// comments, which Gherkin ignores and every other tool skips:
//
//   # itb:
//   #   scriptlets:
//   #     - ./shared-scriptlets
//   #     - https://raw.githubusercontent.com/OpenTestBed/itb-scriptlets/main
//   Feature: ...
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseITBHeader = parseITBHeader;
exports.scriptletSearchPaths = scriptletSearchPaths;
const js_yaml_1 = __importDefault(require("js-yaml"));
/**
 * Read the block from the top of a feature file. Only leading comment lines are
 * considered — a `# itb:` further down is an ordinary comment.
 *
 * Never throws: a malformed block yields `{}` plus an issue, because a broken
 * comment must not stop the feature parsing.
 */
function parseITBHeader(source) {
    const lines = source.split(/\r?\n/);
    const issues = [];
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '')
            continue;
        if (!line.startsWith('#'))
            break; // reached real content
        if (/^#\s*itb:\s*$/i.test(line)) {
            start = i;
            break;
        }
    }
    if (start === -1)
        return { header: {}, issues };
    // Take the contiguous run of comment lines from the marker on, strip one
    // leading "# " from each, and hand the rest to YAML.
    const body = [];
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim().startsWith('#'))
            break;
        body.push(line.replace(/^\s*#\s?/, ''));
    }
    try {
        const parsed = js_yaml_1.default.load(body.join('\n'));
        const block = parsed?.itb;
        if (!block || typeof block !== 'object') {
            issues.push({ line: start + 1, message: 'itb header block is empty or not a mapping' });
            return { header: {}, issues };
        }
        const header = {};
        if (block.scriptlets !== undefined) {
            const raw = Array.isArray(block.scriptlets) ? block.scriptlets : [block.scriptlets];
            const paths = raw.filter((s) => typeof s === 'string' && s.trim() !== '');
            if (paths.length !== raw.length) {
                issues.push({ line: start + 1, message: 'itb header: every "scriptlets" entry must be a string path or URL' });
            }
            header.scriptlets = paths.map((p) => p.trim().replace(/\/+$/, ''));
        }
        return { header, issues };
    }
    catch (e) {
        issues.push({ line: start + 1, message: `itb header block is not valid YAML — ${e?.reason ?? e?.message ?? e}` });
        return { header: {}, issues };
    }
}
/**
 * Locations to search for `scriptlets/<id>.xml`, most specific first.
 * The convention default comes last so a declared location can override it.
 */
function scriptletSearchPaths(header) {
    return [...(header.scriptlets ?? []), 'scriptlets'];
}
