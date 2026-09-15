# Maintaining the language as a community

This is the procedure for changing the OTB Gherkin language: the core
grammar in `lang/`, the compiler in `src/`, and the dialects that plug into
it. It exists so that a change made by one group cannot silently break the
features another group runs.

## What is governed, and by whom

| Artefact | Lives in | Changed by | Gate |
|---|---|---|---|
| Core language (`lang/en.yml`, the six sentence shapes, placeholders, well-known refs) | this package | language maintainers, by proposal | RFC + corpus green + specVersion bump |
| Compiler (`src/`, the parser and generator) | this package | language maintainers | corpus green, no snapshot drift without a language change |
| A dialect (`dialect/steps.yml`, `component.yml`) | its plugin repository | the plugin's maintainers | the dialect linter + that plugin's features green |
| A feature file | the project that owns the test | anyone | `check-features` green against the dialects it declares |

The core is small on purpose. A dialect may add actor kinds, verbs, value
types with a path language, and a conformance handler. It may not add a
sentence shape. If a dialect needs a new shape, that is a core proposal.

## The change procedure

1. **Open an issue** describing the sentence you want to write and why the
   current language cannot say it. Show the feature file lines, not the YAML.
2. **Classify it.** A new verb, kind or type belongs in a dialect: no core
   change, no proposal. A new comparator, sentence shape, placeholder type or
   well-known reference is a core change and needs an RFC (the issue, with a
   "Proposal" section: the text as an author writes it, the `text:` entry,
   the compiled TDL for one example, what existing entries it could shadow).
3. **Implement on a branch** with:
   - the language or dialect change,
   - at least one feature in the corpus that uses it,
   - the re-recorded snapshots (`npm run test:update`), reviewed line by line
     in the PR — a snapshot diff is the change's observable effect,
   - a bump of `specVersion` (core) or `language.version` (dialect): minor for
     an addition, major for a changed or removed pattern.
4. **Review** by one language maintainer and, for a dialect change, one
   maintainer of that plugin. The reviewer checks the sentence against the
   style rules below before the YAML.
5. **Merge and publish.** A core change ships as a package release; a dialect
   change ships when the plugin syncs its `dialect/` folder to the
   workbench (`sync-dialects.mjs`).

Deprecation, not deletion: an entry that must go is kept for one minor
release with `doc: DEPRECATED — use …`, and the converter script gains a rule
that rewrites it. A major bump removes it.

## Style rules a reviewer applies

- One of the six shapes. Action steps start with the actor; assertions start
  with the `$value`; declarations with the actor and `is`.
- Every value a step needs is visible in the sentence. No step reads a
  variable another step happened to set (the v1 `$rawQRData` contract).
- Every step that produces something binds it with `as $x`.
- A dialect verb that calls a service asserts the call succeeded. A raw HTTP
  step (`posts to`) does not: the status is what is being tested.
- Prefer a short qualifier over an option table when one option is the
  common case (`ignoring slicing errors`); use `with:` tables for the rest.
- Names an author types are words, not codes: `is a fhir-validator`, not
  `is kind "FV"`.
- `{string}` for literals, `{ref}` for reads, `{var}` for binds, `{value}`
  when both a literal and a variable make sense.

## Testing contract

- `npm test` — the golden corpus: every fixture compiles with zero parser
  errors and byte-identical TDL. Fixtures freeze their own copies of the
  language and dialects so drift is always a compiler change.
- `node scripts/check-features.mjs <assets> <features>` — the live check a
  project runs in CI over its own feature files.
- `node scripts/convert-v1-to-v2.mjs` — the migration script; every
  deprecation adds a rule here.

## Should the language be its own repository?

Yes, and it already half is: `packages/gherkin` inside `itb-cli`. Move it
out when the first external dialect maintainer appears, for three reasons.

- **Different cadence.** The CLI changes with ITB deployments; the language
  changes with what authors need to say. Coupling their release numbers
  makes every CLI fix look like a language change and vice versa.
- **Different reviewers.** The people who should approve a sentence shape
  are domain authors and dialect maintainers, not the people who maintain
  the deploy commands.
- **Ownership signal.** A dialect repo declares `base: itb-core-en@^2`; that
  reference should point at a thing with its own issues, releases and
  changelog.

Proposed layout after the move:

```
otb-gherkin/                the language: lang/, src/, test/corpus, GOVERNANCE.md
itb-plugin-<x>/dialect/     each dialect, beside the service it drives
itb-cli/                    depends on @opentestbed/otb-gherkin
itb-plugin-authoring/       depends on @opentestbed/otb-gherkin, syncs dialects
```

Until then, treat `packages/gherkin` as if it were separate: its own version
in `package.json`, its own changelog, and PRs that touch it and the CLI
together are split.
