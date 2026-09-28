# @opentestbed/otb-gherkin

Compiles a Gherkin feature file into a [GITB TDL](https://www.itb.ec.europa.eu/docs/tdl/latest/)
test suite — the OTB Gherkin language, its parser, and its XML generator.

Used by the OTB authoring workbench (in the browser) and by the `otb` CLI
(on Node). One implementation, so the two cannot drift.

## Getting started

Install the compiler and whichever dialects your tests need. A dialect is a
package of vocabulary for one domain — FHIR validation, health certificates —
and carries no code:

```bash
npm install @opentestbed/otb-gherkin
npm install @opentestbed/dialect-fhir-validator @opentestbed/dialect-hcert-decoder
```

The compiler reads dialects from a `components/` directory, so the installed
packages have to be assembled into one. The `spec-to-tests` skill ships a
script that does it, and it works from installed packages, a checkout, or a URL:

```bash
node get-dialects.mjs --installed --out assets
ITB_ASSET_ROOT=./assets node compile.mjs my.feature --out build --zip suite.zip
```

Both scripts, and the procedure for turning a specification into a test suite,
are at
[itb-plugin-authoring/.claude/skills/spec-to-tests](https://github.com/OpenTestBed/itb-plugin-authoring/tree/main/.claude/skills/spec-to-tests).
They depend only on this package and on the Test Bed's documented REST API, so
they run without the OpenTestBed CLI and without containers.

A **Test Bed is optional**. Everything above — authoring, compiling, packaging
a deployable suite — needs nothing but Node. Connect one when you want to
execute the tests rather than build them.

Every sentence the language accepts, with an example of each, is in
[EXPRESSIONS.md](https://github.com/OpenTestBed/itb-plugin-authoring/blob/main/app/public/lang/EXPRESSIONS.md),
generated from the language itself.

## The language

Generation 2 (`lang/en.yml`, spec 2.x): one small core with six sentence
shapes, and dialects that add verbs, actor kinds, value types and conformance
handlers for a domain. A feature reads like this:

```gherkin
@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: Patient summary conformance
  Background:
    Given Client is the system under test
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8080"
  Scenario: tc-001 the bundle conforms
    When Client gets "https://example.org/ips.json" as $bundle
    Then $bundle should conform to "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips" ignoring slicing errors
    And $bundle at "Bundle.type" should be "document"
```

The grammar and the dialect contract are in the workbench's `public/lang/GRAMMAR.md`;
`GOVERNANCE.md` here says how the community changes the language.

Generation 1 files keep compiling: tag them `@lang:itb-core-en@^1` and the
compiler loads `lang/en-1.yml` plus each dialect's `steps-v1.yml`.
`scripts/convert-v1-to-v2.mjs` rewrites a file into the current syntax.

## Compiling a feature

```js
import { GherkinParser, XMLGenerator } from '@opentestbed/otb-gherkin';

const parser = new GherkinParser(undefined, { strictRequirements: false });
const parsed = parser.parse(featureText);
await parser.expandScenarioToIR(parsed);   // picks the language generation from the file's @lang tag

const gen = new XMLGenerator(parser);
const { files, issues } = gen.generate(parsed);
```

`files` is the suite: one `testsuite` XML, one `testcase` per scenario, plus any
scriptlets referenced. Check both `parsed.errors` (unmapped steps, undeclared
actors, kind mismatches) and `issues` (unresolved scriptlets).

## Where the language comes from

The parser reads `lang/en.yml` / `lang/en-1.yml` (shipped with this package)
and `components/<id>/steps.yml` (dialects, published as
`@opentestbed/dialect-*` packages and developed in their own repos). It reaches
both through a **`CatalogSource`**:

`lang/scriptlets/` travels with the language too. Two core steps call a
scriptlet — `is informed` and `posts … N times, paced manually` — and those
scriptlets ship here rather than in a dialect, so the core never depends on an
optional one. Anything you inject a `lang/en.yml` for should inject these the
same way.

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
`allowRemote: true`.

## Writing a dialect

A dialect is a `steps.yml` beside a `component.yml`:

```yaml
id: my-validator
language: 2
kinds: [my-validator]                     # "V is a my-validator at …"
types:
  my:Document:
    name: my document                     # "$x is a my document"
    path: { actions: [...] }              # $subject at $path → $pathVar
conforms:
  actions: [...]                          # $subject, $profile, $ignore → $conformanceErrors
verbs:
  - text: '{actor} checks {ref}( on {actor:my-validator})? as {var}'
    doc: One line for the catalog.
    output: { type: 'my:Document' }
    actions: [...]                        # GITB actions; $1… are typed slots, $target the resolved actor
```

Placeholders: `{actor}` `{actor:kind}` `{var}` `{ref}` `{value}` `{string}`
`{path}` `{url}` `{canonical}` `{int}` `{word}` `{kind}` `{type}`; `( … )?` for
optional parts; `a/b` for alternatives. A dialect adds verbs, never sentence
shapes.

## Scripts

| Script | Purpose |
|---|---|
| `npm test` | golden corpus: every fixture compiles clean and byte-identical to its snapshot |
| `npm run test:update` | re-record snapshots (review the diff) |
| `node scripts/check-features.mjs <assets> <features>` | compile a project's features and list errors; CI gate |
| `node scripts/convert-v1-to-v2.mjs <files…>` | migrate generation-1 feature files |

## Versioning

- **`specVersion`** in `lang/en.yml` describes the step grammar. A feature
  file declares what it was written against with `@lang:itb-core-en@^2`;
  drift is reported by name rather than as N anonymous "no mapping" errors.
- **The package version** covers parser and language together. A
  `specVersion` bump forces at least a minor package bump.

## License

BSD-3-Clause
