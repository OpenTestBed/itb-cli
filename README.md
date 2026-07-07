# itb-cli — the `itb` command

One CLI, two command groups. Node/TS (shares @opentestbed/itb-gherkin); shipped via
npm + prebuilt binaries (Win/macOS/Linux).

## itb plugins — install/manage plugins
    itb plugins add fhir-validator            # name[@version] or git+https://…
    itb plugins add smart-helper --provider fhir-transform=matchbox
    itb plugins list [--live]                 # --live: reconcile via getModuleDefinition
    itb plugins remove matchbox [--force]     # refuses while a dependent still requires it
    itb plugins upgrade [name]
    itb plugins expose <name>                 # opt-in host port (range 11000+), for debugging

`add` = resolve manifest → resolve requires (pin → already-satisfied → registry default →
fail with candidates) → regenerate docker-compose.plugins.yml + itb-plugins.lock.yaml →
compose up new services → wait healthy → push `endpoints` as ITB domain parameters →
deploy starter suite → run smoke case → report. Install ends with a green test.

The tool owns docker-compose.plugins.yml and the lockfile; it NEVER edits the user's
compose files. Dedup keys off capability identity (#114 identifier/uri), not image name.

## itb suite — the conformance-authoring loop (replaces itb-test-manager)
    itb suite init                            # idempotent community/domain/spec/system bootstrap
    itb suite compile [--watch]
    itb suite deploy  [--watch]               # replace-in-place via updateSpecification=true
    itb suite run [--case id | --scope uri] [--watch]
    itb suite undeploy <suiteId>
    itb suite status                          # local vs deployed vs instance capabilities

## itb package — produce a preloaded ITB distribution (see ../TEST-MANAGER-PLAN.md)
    itb package --profile profiles/<name>.yaml [--out dist/] [--zip]
    # boots ephemeral ITB -> plugins add -> suite init+deploy -> export data
    # archive -> emits a WHO-ITB-shaped folder (compose + overlay + initconfig/data)

Reads itb-workbench.yaml (see examples/). Installed plugins/handlers are NOT in the
config — read live from the instance (domain parameters + getModuleDefinition) and
reconciled against each suite's compiled #114 dependencies before deploy.

## Layout
    src/commands/{plugins,suite}/   command groups
    src/resolver/                   capability resolution + dep114 string parsing
    src/compose/                    overlay + lockfile generation
    src/itb-client/                 ITB REST (deploy/execute/session) — salvaged from itb-test-manager
