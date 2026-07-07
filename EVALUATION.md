# Evaluating the itb-suite MVP

The MVP implements the authoring loop end to end: **ph4h Gherkin → compile →
deploy to your running ITB → start a test session → poll**. The compile half is
already verified (`test/compile.test.mjs` passes against the real
`ph4h-qr-integration.feature`: 6 files, guard step present, correct handler URIs,
deployable zip). The live half needs your instance keys — 10 minutes, below.

## One-time setup

```powershell
cd E:\work\itb-ecosystem\itb-cli
node src\build-compiler.mjs        # transpiles the workbench parser for Node (re-run after parser changes)
node test\compile.test.mjs         # should print PASS
copy itb-suite.config.example.yaml itb-suite.config.yaml
```

Collect five keys from the ITB UI (http://localhost:10003, admin login) and set
them as env vars (or paste into the yaml — env keeps them out of git):

| Env var | Where in the UI |
|---|---|
| `ITB_COMMUNITY_KEY` | Community → your community → **API keys** panel |
| `ITB_ORG_KEY` | same panel, organisation entry |
| `ITB_SPEC_KEY` | Domain → your specification (the one at `/admin/domains/1/specifications/5`) → **API key** |
| `ITB_SYSTEM_KEY` | Organisation → Systems → your system → API key info |
| `ITB_ACTOR_KEY` | Specification → Actors → the **SUT actor** (`User`) → API key |

## The loop

```powershell
node bin\itb-suite.mjs compile     # Gherkin -> XML + zip (out\ph4h\), no network
node bin\itb-suite.mjs deploy     # compile + replace-in-place into the spec
node bin\itb-suite.mjs run        # deploy + start the test case + poll
node bin\itb-suite.mjs status --session <id>
```

or the whole chain with assertions in one go:

```powershell
node test\e2e.mjs
```

Expected `e2e` output: `1/4 compile OK`, `2/4 deploy OK`, `3/4 start OK
session: <uuid>`, `4/4 status OK result: UNDEFINED` — **UNDEFINED is the correct
verdict here**: the ph4h suite begins with an interactive QR upload (kept
interactive by design), so the session is alive and waiting for a human.
Completing it: open http://localhost:10003 as an organisation user → Test
Sessions → the session → upload the QR → watch the rest run to the MEOW verdict.
A non-interactive suite would reach SUCCESS/FAILURE inside the poll window.

What to check in the UI after `deploy`: your specification page — the suite
`hcert-ph4h-qr-to-meow-medicationoverview-bundle` replaced in place, version
bumped, one test case. Re-run `deploy` after editing the feature file: no manual
zip, no upload dialog, same suite updated.

## Where each persona lives

| Persona | Application | What they do |
|---|---|---|
| **Test author** | this CLI + the test-workbench SPA (visual editing/preview) | edit `.feature` → `itb-suite run` → fix → repeat. The ITB UI is only for watching sessions |
| **Test event manager** | **ITB UI** (community admin) | creates communities/organisations, approves registrations, assigns specs, monitors dashboards — unchanged, ITB's native strength |
| **Software vendor (SUT)** | **ITB UI** (organisation user) | self-registers into the community, creates their system, gets conformance statements, executes tests, sees reports — never touches the CLI |

The CLI deliberately serves only the author; managers and vendors get the ITB UI,
which is already built for them. The packaged-instance work (TEST-MANAGER-PLAN.md
§2/§3) is what puts a ready-made community/registration experience in front of
vendors.

## Known MVP limits

- Deps resolved from the sibling `test-workbench/node_modules` (no separate npm
  install; registry was unreachable from the build sandbox). `npm install` in
  itb-cli also works when online.
- One suite per config (first `suites[]` entry); no watch mode yet (next
  iteration: chokidar on the feature file → `run`).
- `run` needs the system↔actor conformance statement to exist (create once in
  the UI, or via `PUT /api/rest/conformance/{system}/{actor}` — the planned
  `itb suite init` automates this).
- Component dialects: all enabled by default; narrow with
  `ITB_COMPONENTS=fhir-validator,smart-helper`.
