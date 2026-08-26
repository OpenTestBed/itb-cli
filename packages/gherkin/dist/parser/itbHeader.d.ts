export interface ITBHeader {
    /** Extra locations to resolve `call scriptlet` ids against, in order. */
    scriptlets?: string[];
}
/**
 * Read the block from the top of a feature file. Only leading comment lines are
 * considered — a `# itb:` further down is an ordinary comment.
 *
 * Never throws: a malformed block yields `{}` plus an issue, because a broken
 * comment must not stop the feature parsing.
 */
export declare function parseITBHeader(source: string): {
    header: ITBHeader;
    issues: {
        line: number;
        message: string;
    }[];
};
/**
 * Locations to search for `scriptlets/<id>.xml`, most specific first.
 * The convention default comes last so a declared location can override it.
 */
export declare function scriptletSearchPaths(header: ITBHeader): string[];
