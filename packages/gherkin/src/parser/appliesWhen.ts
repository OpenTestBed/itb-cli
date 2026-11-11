// When does a dialect apply? component.yml `appliesWhen:` — a condition a
// machine can evaluate over facts about what is being tested, so a workbench
// or a skill can propose the dialects for a specification instead of an author
// having to know them.
//
//   appliesWhen:
//     any:
//       - { mediaType: [application/fhir+json, application/fhir+xml] }
//       - { specification: '^http://hl7\.org/fhir/' }
//       - { document: { pointer: /resourceType, exists: true } }
//
// Conditions:
//   { specification: <regex> }        a specification under test matches (case-insensitive)
//   { mediaType: <type> | [<type>…] } a document has one of these media types
//   { document: { pointer, exists | equals | matches } }
//                                     a JSON document has that value at the pointer
//   { all: […] } { any: […] } { not: {…} }
//
// Facts are what the caller knows: the specification identifiers (a canonical
// URL, an IG package id, a CELEX number) and sample documents. Nothing here
// reads files or the network; describeDocument() turns a file's name and text
// into the facts for one document.
//
// Every result says why, in both directions. An unrecognised condition is an
// error in the manifest, reported as one — never silently "does not apply".

export interface DocumentFacts {
  name?: string;
  mediaType?: string;
  /** Parsed JSON, when the document is JSON. */
  json?: unknown;
}

export interface ApplicabilityFacts {
  specifications?: string[];
  documents?: DocumentFacts[];
}

export interface Applicability {
  applies: boolean;
  why: string;
}

/** Media type from a file name and its text. JSON with a `resourceType` is
 *  FHIR JSON; a root element in the FHIR namespace is FHIR XML. */
export function describeDocument(name: string, text: string): DocumentFacts {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const json = JSON.parse(t);
      const fhir = json && typeof json === 'object' && !Array.isArray(json) && typeof (json as any).resourceType === 'string';
      return { name, mediaType: fhir ? 'application/fhir+json' : 'application/json', json };
    } catch { /* not JSON after all */ }
  }
  if (t.startsWith('<')) {
    return { name, mediaType: /xmlns\s*=\s*["']http:\/\/hl7\.org\/fhir["']/.test(t) ? 'application/fhir+xml' : 'application/xml' };
  }
  return { name, mediaType: /\.ya?ml$/i.test(name) ? 'application/yaml' : 'text/plain' };
}

function pointerGet(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '' || pointer === '/') return { found: true, value: doc };
  let cur: any = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const k = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return { found: false };
    cur = cur[k];
  }
  return { found: true, value: cur };
}

const docLabel = (d: DocumentFacts, i: number) => d.name ?? `document ${i + 1}`;

/** Evaluate one condition. Throws on a malformed condition. */
export function evaluateAppliesWhen(cond: unknown, facts: ApplicabilityFacts): Applicability {
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
    throw new Error(`appliesWhen: a condition must be a mapping, got ${JSON.stringify(cond)}`);
  }
  const c = cond as Record<string, any>;
  const keys = Object.keys(c);
  if (keys.length !== 1) throw new Error(`appliesWhen: one key per condition, got ${keys.join(', ') || 'none'}`);
  const specs = facts.specifications ?? [];
  const docs = facts.documents ?? [];

  if (Array.isArray(c.all)) {
    const whys: string[] = [];
    for (const x of c.all) {
      const r = evaluateAppliesWhen(x, facts);
      if (!r.applies) return r;
      whys.push(r.why);
    }
    return { applies: true, why: whys.join('; and ') };
  }
  if (Array.isArray(c.any)) {
    const whys: string[] = [];
    for (const x of c.any) {
      const r = evaluateAppliesWhen(x, facts);
      if (r.applies) return r;
      whys.push(r.why);
    }
    return { applies: false, why: whys.join('; and ') || 'empty any' };
  }
  if ('not' in c) {
    const r = evaluateAppliesWhen(c.not, facts);
    return { applies: !r.applies, why: `not (${r.why})` };
  }
  if ('specification' in c) {
    const re = new RegExp(String(c.specification), 'i');
    const hit = specs.find(s => re.test(s));
    return hit ? { applies: true, why: `specification ${hit} matches ${c.specification}` }
      : { applies: false, why: specs.length ? `no specification matches ${c.specification} (given: ${specs.join(', ')})` : 'no specification given' };
  }
  if ('mediaType' in c) {
    const wanted = (Array.isArray(c.mediaType) ? c.mediaType : [c.mediaType]).map((s: unknown) => String(s).toLowerCase());
    const i = docs.findIndex(d => d.mediaType && wanted.includes(d.mediaType.toLowerCase()));
    return i >= 0 ? { applies: true, why: `${docLabel(docs[i], i)} is ${docs[i].mediaType}` }
      : { applies: false, why: docs.length ? `no document is ${wanted.join(' or ')}` : 'no documents given' };
  }
  if ('document' in c) {
    const d = c.document ?? {};
    if (typeof d.pointer !== 'string') throw new Error('appliesWhen: document needs a pointer');
    const test = (v: { found: boolean; value?: unknown }): boolean => {
      if ('exists' in d) return v.found === !!d.exists;
      if (!v.found) return false;
      if ('equals' in d) return JSON.stringify(v.value) === JSON.stringify(d.equals);
      if ('matches' in d) return new RegExp(String(d.matches)).test(String(v.value));
      return v.found;
    };
    const what = 'equals' in d ? `= ${JSON.stringify(d.equals)}` : 'matches' in d ? `matches ${d.matches}` : d.exists === false ? 'absent' : 'present';
    const i = docs.findIndex(doc => doc.json !== undefined && test(pointerGet(doc.json, d.pointer)));
    return i >= 0 ? { applies: true, why: `${docLabel(docs[i], i)}: ${d.pointer} ${what}` }
      : { applies: false, why: docs.some(x => x.json !== undefined) ? `no JSON document has ${d.pointer} ${what}` : 'no JSON documents given' };
  }
  throw new Error(`appliesWhen: unrecognised condition "${keys[0]}"`);
}

/** Does a dialect apply? `undefined` when its manifest declares nothing. */
export function dialectApplies(manifest: { appliesWhen?: unknown }, facts: ApplicabilityFacts): Applicability | undefined {
  if (manifest?.appliesWhen === undefined || manifest.appliesWhen === null) return undefined;
  return evaluateAppliesWhen(manifest.appliesWhen, facts);
}
