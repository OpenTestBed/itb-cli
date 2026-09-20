// Typed step text — the v2 way to write a step pattern.
//
// A v1 entry is a hand-written regex:
//
//   match: '^([A-Za-z][A-Za-z0-9_]*) loads IG "([^"]+)" on ([A-Za-z][A-Za-z0-9_]*)$'
//
// A v2 entry names what each slot IS:
//
//   text: '{actor} loads IG {value} on {actor:fhir-validator}'
//
// The text compiles to the same kind of regex the parser has always run, so
// the matching engine is unchanged. What the placeholders add is a TYPE per
// capture: the parser can then hand a dialect's action templates a TDL
// expression ($x, "literal", $lastRequest{response}{status}) instead of raw
// text, check that an actor has the kind a step needs, fill in an omitted
// target from the declared actors, and tell the workbench what to offer at
// each slot.
//
//   {actor}            bare PascalCase identifier          → its id
//   {actor:kind}       …declared as `is a <kind>`          → its id
//   {var}              $name, a binding target             → bare name
//   {ref}              $name or $a.b.c, a value read       → TDL reference
//   {value}            "literal" | $ref | 42 | true|false  → TDL expression
//   {string} {path} {url} {canonical}
//                      "literal"                           → inner text
//   {int}              digits                              → digits
//   {word}             one bare word                       → the word
//   {kind}             a component id (lower-kebab)        → the id
//   {type}             a registered value type's name      → the type key
//
//   ( optional text )?   optional part; may hold placeholders
//   a/b/c                one of several words
//
// Everything else is literal text. Whitespace is collapsed to single spaces
// before matching, as it always was.

export type ParamType =
  | 'actor' | 'var' | 'ref' | 'value'
  | 'string' | 'path' | 'url' | 'canonical'
  | 'int' | 'word' | 'kind' | 'type';

export interface ParamSpec {
  type: ParamType;
  /** For {actor:kind} — the component kind the actor must be declared as. */
  kind?: string;
  /** Inside a `( … )?` group: the capture may be absent. */
  optional: boolean;
}

export interface CompiledText {
  /** Anchored regex source, the same shape v1 `match:` entries use. */
  match: string;
  params: ParamSpec[];
}

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const SEGMENT = '[A-Za-z0-9_-]+';
/** $name, $name.child.grand-child */
const REF_BODY = `${IDENT}(?:\\.${SEGMENT})*`;

const PARAM_RE: Record<Exclude<ParamType, 'type'>, string> = {
  actor: '([A-Za-z][A-Za-z0-9_]*)',
  var: `\\$(${IDENT})`,
  ref: `\\$(${REF_BODY})`,
  value: `("[^"]*"|\\$${REF_BODY}|-?[0-9]+(?:\\.[0-9]+)?|true|false)`,
  string: '"([^"]*)"',
  path: '"([^"]*)"',
  url: '"([^"]*)"',
  canonical: '"([^"]*)"',
  int: '([0-9]+)',
  word: '([A-Za-z][A-Za-z0-9_-]*)',
  kind: '([a-z][a-z0-9-]*)',
};

const KNOWN_TYPES = new Set<string>([...Object.keys(PARAM_RE), 'type']);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `a/b/c` → `(?:a|b|c)`; a single word passes through escaped. */
function literalToken(tok: string): string {
  if (/^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z][A-Za-z0-9_-]*)+$/.test(tok)) {
    return '(?:' + tok.split('/').map(escapeRegex).join('|') + ')';
  }
  return escapeRegex(tok);
}

/**
 * Compile a typed step text to a regex plus the type of every capture.
 *
 * `typeNames` supplies the alternation for `{type}` — the registered value
 * types' display names — because that placeholder cannot be compiled without
 * knowing which dialects are loaded.
 */
export function compileStepText(text: string, typeNames: string[] = []): CompiledText {
  return compileInner(text.trim().replace(/\s+/g, ' '), typeNames);
}

/** The body of compileStepText; keeps leading/trailing spaces, which matter
 *  inside an optional group (`( at {url})?`). */
function compileInner(src: string, typeNames: string[]): CompiledText {
  const params: ParamSpec[] = [];
  let out = '';
  let i = 0;
  let depth = 0; // inside `( … )?`

  while (i < src.length) {
    const ch = src[i];

    // Placeholder
    if (ch === '{') {
      const close = src.indexOf('}', i);
      if (close < 0) throw new Error(`unterminated placeholder in step text: ${src}`);
      const body = src.slice(i + 1, close);
      const [rawType, qualifier] = body.split(':');
      const type = rawType.trim() as ParamType;
      if (!KNOWN_TYPES.has(type)) throw new Error(`unknown placeholder {${body}} in step text: ${src}`);
      if (type === 'type') {
        const alts = typeNames.length ? typeNames.map(escapeRegex).join('|') : '[A-Za-z][A-Za-z0-9 :_-]*';
        out += `(${alts})`;
      } else {
        out += PARAM_RE[type];
      }
      params.push({ type, kind: qualifier?.trim() || undefined, optional: depth > 0 });
      i = close + 1;
      continue;
    }

    // Optional group: `( … )?` — only when the closing paren is followed by `?`.
    if (ch === '(' && src[i - 1] !== '\\') {
      const close = findGroupEnd(src, i);
      if (close > 0 && src[close + 1] === '?') {
        depth++;
        const inner = compileInner(src.slice(i + 1, close), typeNames);
        // Optional captures inherit the flag; re-tag them.
        for (const p of inner.params) params.push({ ...p, optional: true });
        out += `(?:${inner.match.replace(/^\^|\$$/g, '')})?`;
        depth--;
        i = close + 2;
        continue;
      }
    }

    // Escaped literal paren
    if (ch === '\\' && (src[i + 1] === '(' || src[i + 1] === ')')) {
      out += '\\' + src[i + 1];
      i += 2;
      continue;
    }

    // Literal run up to the next special character
    let j = i;
    while (j < src.length && src[j] !== '{' && src[j] !== '(' && src[j] !== '\\') j++;
    const run = src.slice(i, j);
    // Tokenise on spaces so `a/b` alternations are recognised per word.
    out += run.split(' ').map(literalToken).join(' ');
    i = j;
  }

  return { match: `^${out}$`, params };
}

function findGroupEnd(src: string, open: number): number {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '\\') { k++; continue; }
    if (src[k] === '(') depth++;
    else if (src[k] === ')') { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/**
 * Well-known dotted references. Anything not listed resolves generically:
 * `$a.b.c` → `$a{b}{c}`.
 */
export type RefTable = Record<string, string>;

export function resolveRef(dotted: string, refs: RefTable): string {
  if (refs[dotted]) return refs[dotted];
  // Longest well-known prefix, then generic segments for the rest.
  const segs = dotted.split('.');
  for (let n = segs.length - 1; n > 0; n--) {
    const head = segs.slice(0, n).join('.');
    if (refs[head]) return refs[head] + segs.slice(n).map(s => `{${s}}`).join('');
  }
  return '$' + segs[0] + segs.slice(1).map(s => `{${s}}`).join('');
}

/** What a captured slot yields in an action template. */
export interface SlotValue {
  /** TDL expression form (`$N`). */
  expr: string;
  /** Text as captured, without quotes or `$` (`$N.raw`). */
  raw: string;
  /** For {ref}/{value}-as-ref: the dotted name; for {var}: the name. */
  name?: string;
  /** True when the optional group was absent and `expr` is the stand-in `""`. */
  omitted?: boolean;
}

/** Turn one regex capture into its typed slot value. */
export function slotValue(spec: ParamSpec, captured: string | undefined, refs: RefTable): SlotValue {
  if (captured === undefined || captured === '') {
    // Absent optional group. Expression contexts get an empty string
    // literal so a concat() or comparison still parses.
    const empty = spec.type === 'value' || spec.type === 'ref' ? '""' : '';
    return { expr: empty, raw: '', omitted: true };
  }
  switch (spec.type) {
    case 'actor': case 'int': case 'word': case 'kind': case 'type':
    case 'string': case 'path': case 'url': case 'canonical':
      return { expr: captured, raw: captured };
    case 'var':
      return { expr: captured, raw: captured, name: captured };
    case 'ref':
      return { expr: resolveRef(captured, refs), raw: captured, name: captured };
    case 'value': {
      if (captured.startsWith('"')) {
        return { expr: captured, raw: captured.slice(1, -1) };
      }
      if (captured.startsWith('$')) {
        const name = captured.slice(1);
        return { expr: resolveRef(name, refs), raw: name, name };
      }
      // Numbers and booleans are TDL strings too: every value a step reads
      // back (a status, a count, a flag) arrives as text, and quoting keeps
      // `should be 200` and `should be "200"` the same assertion.
      return { expr: `"${captured}"`, raw: captured };
    }
  }
}

/** Human-readable form of a typed text for catalogs and completions. */
export function describeText(text: string): string {
  return text
    .replace(/\{actor:([^}]+)\}/g, '<$1>')
    .replace(/\{actor\}/g, '<Actor>')
    .replace(/\{var\}/g, '$name')
    .replace(/\{ref\}/g, '$value')
    .replace(/\{value\}/g, '"value"|$ref')
    .replace(/\{(string|path|url|canonical)\}/g, '"$1"')
    .replace(/\{int\}/g, 'N')
    .replace(/\{(word|kind|type)\}/g, '<$1>')
    .replace(/\(([^()]*)\)\?/g, '[$1]');
}
