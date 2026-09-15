# What this file was written against. Drift between these and the loaded
# catalog is reported once, by name, instead of as N anonymous
# "no mapping for step" errors.
#   @lang:    the core dialect (en.yml `id` / `specVersion`)
#   @dialect: each plugin dialect whose steps this file uses
# Only ONE comparator per tag — a Gherkin tag cannot contain a space, so
# two-sided ranges are not expressible; ^ and ~ cover the real cases.
#
# fhir-validator supplies the four `evaluate FHIRPath ... on ...` steps.
# Everything else here — including `conforms to` and `loads IG` — is core,
# even though those two call the FHIRValidator actor at run time. These
# tags declare STEP GRAMMAR, not services: the FHIR validator, the package
# server and the MEOW package version are runtime dependencies that tags
# do not cover, which is why the MEOW version is pinned inline in the IG
# URL below rather than floated as `latest`.
@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: IHE MEOW Medication Overview Consumer — client-side conformance
  Tests a MEOW *client* (the Medication Overview Consumer actor), not a QR
  pipeline. The SUT initiates every exchange; ITB plays the Responder and
  judges what arrives.

    tc-meow-client-001  QUERY  — the Consumer must be able to query by
                                 patient (required) and by the optional
                                 search parameters it declares support for.
    tc-meow-client-002  SUBMIT — whatever Medication Overview the Consumer
                                 submits must conform to the MEOW
                                 MedicationOverview profile.

  Actors are named after the real CapabilityStatements in ihe.pharm.meow:
    https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewConsumer
    https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewResponder

  Consumer search parameters per that CapabilityStatement (mode: client),
  on MedicationStatement / PHARM-11, profiled as MedicationTreatmentLine:
    patient        reference  REQUIRED — the patient whose overview is wanted
    status         token      filter by treatment line status
    effective      date       filter by effective period of the treatment line
    category       token      filter by medication list category / list type
    _lastUpdated   date       incremental sync

  # ==================================================================
  # READ THIS BEFORE THE FIRST RUN — one thing to calibrate
  # ==================================================================
  # Both scenarios read the request the SUT sent, via $lastReceived{...}.
  # No generated suite anywhere in this ecosystem has used a <receive>
  # step before, so the FIELD NAMES below are the expected HttpMessagingV2
  # receive outputs — not names observed on a running ITB.
  #
  # If an assertion fails with an EMPTY actual value, the field name is
  # wrong, not the SUT. Every request-shape assertion in this file reads
  # `lastReceived{path}`, `lastReceived{method}`, `lastReceived{body}` or
  # `lastReceived{headers}{...}` — deliberately one small set, so a
  # rename is a find-and-replace. Likely alternatives to try:
  #   {path}    -> {uri} | {requestURI} | {target}
  #   {headers} -> {header}
  # This works because the generic assertion interpolates whatever sits
  # inside the quotes as a TDL variable path: "lastReceived{method}"
  # compiles to $lastReceived{method}. No en.yml change is needed to
  # retarget it.
  #
  # Also note: ITB does NOT reply. The compiler emits no <btxn>/<etxn>,
  # so nothing can be sent back on the same exchange — the Consumer sees
  # a timeout after ITB has inspected its request. The request assertions
  # are unaffected; the Consumer just gets no data.

  Background:
    Given MedicationOverviewConsumer is the system under test as defined by "https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewConsumer"
    # ITB simulates the Responder. Point the Consumer's FHIR base URL at
    # the endpoint ITB advertises for this actor.
    And MedicationOverviewResponder is infrastructure as defined by "https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewResponder"
    # GITB-compatible FHIR validator (validator_cli.jar) — exposes
    # /itb/{igManager,transform,loadResource,fhir,fhirPath}/process.
    # Same actor the RACSEL track features use.
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8080"

  # ==================================================================
  # 1. QUERY — by patient, then by the optional parameters
  # ==================================================================
  # Three rounds. Each is a separate exchange the operator triggers on
  # the SUT, so the test proves the Consumer can actually *build* each
  # query — not merely that it can build one and repeat it.
  Scenario: tc-meow-client-001 PHARM-11 query by patient and by optional parameters

    # ------------------------------------------------------------------
    # ROUND 1 — the mandatory baseline: query by patient alone.
    # A PHARM-11 query without `patient` is non-conformant no matter what
    # else it carries, so this round is the one that must never be
    # relaxed.
    # ------------------------------------------------------------------
    Given MedicationOverviewConsumer is informed "ROUND 1 of 3 — query the Responder for the test patient's medication overview using ONLY the patient parameter, then wait."
    When MedicationOverviewResponder waits for MedicationOverviewConsumer within 300 seconds

    # PHARM-11 is a FHIR search — GET, never POST.
    Then $received.method should be "GET"
    # Query Medication Resources targets MedicationStatement, profiled as
    # MedicationTreatmentLine.
    And $received.path should contain "/MedicationStatement"
    And $received.path should contain "patient="
    # The Consumer must ask for FHIR JSON. Some clients use the _format
    # query parameter instead of the Accept header — both are allowed by
    # the Consumer's OpenAPI. Swap this line for a {path} contains
    # "_format=" check if that is what your SUT does.
    And $received.headers.Accept should contain "fhir+json"

    # ------------------------------------------------------------------
    # ROUND 2 — patient + status. Proves the Consumer can narrow a query
    # by treatment line status rather than filtering client-side after
    # pulling everything.
    # ------------------------------------------------------------------
    Given MedicationOverviewConsumer is informed "ROUND 2 of 3 — query the same patient again, this time ALSO filtering by status (for example status=active), then wait."
    When MedicationOverviewResponder waits for MedicationOverviewConsumer within 300 seconds

    Then $received.method should be "GET"
    And $received.path should contain "/MedicationStatement"
    # patient stays mandatory — a status filter never replaces it.
    And $received.path should contain "patient="
    And $received.path should contain "status="

    # ------------------------------------------------------------------
    # ROUND 3 — patient + _lastUpdated, the incremental-sync parameter.
    # Swap `_lastUpdated=` below for `category=` or `effective=` to
    # exercise a different optional parameter instead; the shape of the
    # round is identical.
    # ------------------------------------------------------------------
    Given MedicationOverviewConsumer is informed "ROUND 3 of 3 — query the same patient again, this time ALSO filtering by _lastUpdated (an incremental sync since a given instant), then wait."
    When MedicationOverviewResponder waits for MedicationOverviewConsumer within 300 seconds

    Then $received.method should be "GET"
    And $received.path should contain "/MedicationStatement"
    And $received.path should contain "patient="
    And $received.path should contain "_lastUpdated="

    And MedicationOverviewConsumer is informed "PHARM-11 query conformance passed: the Consumer builds well-formed queries by patient, by status, and by _lastUpdated."

  # ==================================================================
  # 2. SUBMIT — the overview the Consumer sends must conform
  # ==================================================================
  # NOTE ON SCOPE: MEOW itself defines no submit transaction — both the
  # Consumer and the Responder CapabilityStatements are read/search only.
  # So the ENDPOINT the SUT posts to is deployment-specific and this test
  # asserts only that it is a POST carrying FHIR JSON. What the profile
  # does govern, and what this scenario really tests, is the PAYLOAD.
  Scenario: tc-meow-client-002 Submitted overview conforms to MedicationOverview

    # ------------------------------------------------------------------
    # 1) Load IHE MEOW 1.0.0-preview, the official IHE publication — the
    #    only version published. No local package server involved. The URL
    #    must end in .tgz: the validator sniffs format from the extension,
    #    and the extensionless packages.fhir.org form makes it parse gzip
    #    bytes as XML ("Invalid byte 1 of 1-byte UTF-8 sequence").
    #
    #    KNOWN: this build mis-slices every Bundle.entry into the Patient
    #    slice, which is why RACSEL-track3 carries a 10-clause exact-error
    #    mask. The `conforms to` below is expected to report errors against
    #    it, and is deliberately left unmasked — the errors come from the
    #    real published profile, and masking them would hide genuine
    #    findings alongside the known ones.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer loads IG "https://profiles.ihe.net/PHARM/MEOW/package.tgz" on FHIRValidator

    # ------------------------------------------------------------------
    # 2) Wait for the SUT to submit its Medication Overview.
    # ------------------------------------------------------------------
    Given MedicationOverviewConsumer is informed "Submit the Medication Overview for the test patient to the endpoint configured for this test session, then wait."
    When MedicationOverviewResponder waits for MedicationOverviewConsumer within 300 seconds

    # ------------------------------------------------------------------
    # 3) Transport-level shape. A submit is a POST carrying FHIR JSON.
    # ------------------------------------------------------------------
    Then $received.method should be "POST"
    And $received.headers.Content-Type should contain "fhir+json"
    And $received.body should not be empty

    # ------------------------------------------------------------------
    # 4) Cheap structural gate before the expensive profile validation,
    #    so a wrong payload fails with a clear message instead of a wall
    #    of validator output. A non-Bundle payload fails right here.
    #
    #    DO NOT reach for `extract "/resourceType" from "lastReceived{body}"`
    #    instead: that step's `from` capture only accepts a plain
    #    identifier ([A-Za-z_][A-Za-z0-9_]*), so it will not take a map
    #    path like lastReceived{body} — and an unmatched step is SILENTLY
    #    DROPPED by the compiler rather than failing the build, which
    #    leaves an assertion reading an unassigned variable. FHIRPath's
    #    `on "<var>"` capture is unrestricted, so it does the gating.
    # ------------------------------------------------------------------
    And $received.body at "Bundle.type" should be "document"

    # ------------------------------------------------------------------
    # 5) The conformance assertion proper. Fails if the validator reports
    #    any error-level issue against the profile.
    # ------------------------------------------------------------------
    And $received.body should conform to "https://profiles.ihe.net/PHARM/MEOW/StructureDefinition/MedicationOverview"

    # ------------------------------------------------------------------
    # 6) Content checks the profile alone will not catch — a Bundle can
    #    be structurally valid and still be an empty overview.
    # ------------------------------------------------------------------
    And $received.body at "Bundle.entry.resource.ofType(Composition).count()" should be 1
    And $received.body at "Bundle.entry.resource.ofType(Patient).exists()" should be true
    And $received.body at "Bundle.entry.resource.ofType(MedicationStatement).exists()" should be true

    And MedicationOverviewConsumer is informed "Submitted Medication Overview conforms to IHE MEOW MedicationOverview and carries at least one treatment line."
