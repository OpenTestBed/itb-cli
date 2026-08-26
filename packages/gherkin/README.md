# @opentestbed/otb-gherkin

Compiles a Gherkin feature file into a [GITB TDL](https://www.itb.ec.europa.eu/docs/tdl/latest/)
test suite — the FHIR Gherkin dialect, its parser, and its XML generator.

Used by the OTB authoring workbench (in the browser) and by the `otb` CLI
(on Node). One implementation, so the two cannot drift.

```bash
npm install @opentestbed/otb-gherkin
```

## Compiling a feature

```js
import { GherkinParser, XMLGenerator } from '@opentestbed/otb-gherkin';

const parser = new GherkinParser(undefined, { strictRequirements: false });
await parser.ensureCatalog('en');

const parsed = parser.parse(featureText);
await parser.expandScenarioToIR(parsed);

const gen = new XMLGenerator(parser);
const { files, issues } = gen.generate(parsed);
```

`files` is the suite: one `testsuite` XML, one `testcase` per scenario, plus any
scriptlets referenced. `issues` carries anything the compiler could not resolve —
**check it**: an unresolved scriptlet id is reported here rather than thrown, and
ignoring it produces a suite that references a file it never emitted.

## Where the language comes from

The parser reads `lang/en.yml` (the core dialect, shipped with this package) and
`components/<id>/steps.yml` (plugin dialects, which live in their own repos). It
reaches both through a **`CatalogSource`**:

```ts
interface CatalogSource {
  read(path: string): Promise<string | null>;   // "/lang/en.yml"
  readUrl?(url: string): Promise<string | null>; // remote plugin dialects
  isEnabled?(componentId: string): boolean;
  storedDialectUrls?(): string[];
  saveStoredDialectUrls?(urls: string[]): void;
}
```

**In a browser**, nothing to configure — it falls back to `fetch` and
`localStorage`.

**On Node**, inject the filesystem source:

```js
import { setCatalogSource } from '@opentestbed/otb-gherkin';
import { createNodeSource } from '@opentestbed/otb-gherkin/node';

setCatalogSource(createNodeSource('./public', { components: ['fhir-validator'] }));
```

`createNodeSource` sits behind the `/node` subpath export so `node:fs` never
reaches a browser bundle. It refuses absolute `http(s)` reads unless you pass
`allowRemote: true` — compiling is meant to be local and instant, and a build
that silently reaches the network fails differently on every machine.

## Versioning

Two numbers, doing different jobs:

- **`specVersion`** in `lang/en.yml` describes the *step grammar*. A feature
  file declares what it was written against with `@lang:itb-core-en@^1.3`, and
  drift is reported by name rather than as N anonymous "no mapping for step"
  errors.
- **The package version** covers parser and language together. A `specVersion`
  bump forces at least a minor package bump — they ship as one thing, because
  a step pattern is meaningless without the code that implements it.

## Tests

`npm test` runs the golden corpus: 39 real feature files compiled and compared
byte for byte against snapshots in `test/corpus/expected/`. The fixtures are
frozen copies, so a mismatch always means the compiler changed — never that
someone edited a dialect elsewhere.

```bash
npm test                    # verify
node test/corpus.mjs --update   # re-record (review the diff)
```

## License

BSD-3-Clause
