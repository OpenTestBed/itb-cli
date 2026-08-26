# The other side of the MEOW transaction from meow-client.feature: here the
# SUT is the Medication Overview Responder (a server), and ITB drives the
# exchange as the Consumer. That reverses the hard part — ITB sends and the
# SUT answers, so nothing depends on <receive> or on ITB replying, and every
# assertion is on a response ITB fetched itself.
@lang:itb-core-en@^1.2 @dialect:fhir-validator@^1.0
Feature: IHE MEOW Medication Overview Responder — server-side conformance
  Exercises the Responder actor of the IHE PHARM MEOW profile:

    tc-meow-server-001  PHARM-11 query by patient (the required baseline)
    tc-meow-server-002  PHARM-11 optional search parameters are honoured
    tc-meow-server-003  PHARM-11 rejects a query missing the required patient
    tc-meow-server-004  PHARM-12 Document Option — retrieve a MedicationOverview

  Scenario ids are kept one-transaction-per-scenario on purpose, so a
  TestPlan can later scope each to the PHARM-11 / PHARM-12 transaction it
  covers without having to split anything up.

  Responder capabilities per the CapabilityStatement in ihe.pharm.meow
  (https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewResponder,
  mode: server):
    MedicationStatement  search-type, read  — PHARM-11, profiled as
                         MedicationTreatmentLine. `patient` REQUIRED;
                         `status`, `effective`, `category`, `_lastUpdated`
                         optional.
    Bundle               search-type, read  — PHARM-12 Document Option,
                         profiled as MedicationOverview. `patient` required
                         for patient-scoped document search; `type`, `date`
                         optional.
    CarePlan / Medication / MedicationRequest / MedicationDispense /
    MedicationAdministration — read.

  # ==================================================================
  # BEFORE THE FIRST RUN — two values to set
  # ==================================================================
  # 1. The Responder base URL in the Background below.
  # 2. The test patient id, which appears inline in every request path as
  #    `patient=meow-test-patient`.
  #
  # The patient id CANNOT be lifted into a variable: `gets from <Actor> at
  # "<path>"` compiles the path to a TDL string literal inside concat(),
  # and TDL string literals do not interpolate $variables (the same caveat
  # en.yml documents on the absolute `gets "<url>"` form). So it is a
  # find-and-replace on `meow-test-patient`, or reach for `call scriptlet`
  # with an inline body if you need a genuinely dynamic path.

  Background:
    Given MedicationOverviewResponder is the system under test at "http://meow-responder:8080/fhir" as defined by "https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewResponder"
    # ITB plays the Consumer — it originates every request below.
    And MedicationOverviewConsumer is infrastructure as defined by "https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewConsumer"
    # GITB-compatible FHIR validator (validator_cli.jar). Same actor the
    # RACSEL track features and meow-client.feature use.
    And FHIRValidator is infrastructure at "http://fhir-validator:8080"

  # ==================================================================
  # 1. PHARM-11 — query by patient
  # ==================================================================
  Scenario: tc-meow-server-001 PHARM-11 query by patient returns treatment lines

    # IHE MEOW 1.0.0-preview2 — the FIXED Bundle.entry slicing. The official
    # 1.0.0-preview mis-slices every entry into the Patient slice, which is
    # why RACSEL-track3 carries a 10-clause exact-error mask. Served by the
    # local package server; the trailing /package.tgz is required because
    # format-sniffing loaders need the .tgz extension.
    When MedicationOverviewConsumer loads IG "http://package-server:8000/ihe.pharm.meow/1.0.0-preview2/package.tgz" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # The one mandatory PHARM-11 query: patient and nothing else.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=meow-test-patient" as "lines"
    Then "response status" should be "200"
    And "lines" should not be empty

    # A FHIR search always answers with a searchset Bundle, never a bare
    # resource and never an OperationOutcome on success.
    And evaluate FHIRPath "Bundle.type" on "lines" and expect "searchset"

    # The server must actually hold data for the test patient — an empty
    # searchset is a valid Bundle but tells us nothing about conformance,
    # so fail loudly rather than pass vacuously.
    And evaluate FHIRPath "Bundle.entry.exists()" on "lines" and expect "true"

    # Every entry must be a MedicationStatement. `.all()` is empty-true in
    # FHIRPath, which is why the existence check above has to come first.
    And evaluate FHIRPath "Bundle.entry.resource.all($this is MedicationStatement)" on "lines" and expect "true"

    # Every returned line must be for the patient that was asked for —
    # catches a server that ignores the search parameter and returns
    # everything it has.
    And evaluate FHIRPath "Bundle.entry.resource.subject.reference.all(endsWith('meow-test-patient'))" on "lines" and expect "true"

    # PHARM-11 profiles the response as MedicationTreatmentLine. A server
    # that claims the profile must say so in meta.profile.
    And evaluate FHIRPath "Bundle.entry.resource.meta.profile.where($this.startsWith('https://profiles.ihe.net/PHARM/MEOW/StructureDefinition/MedicationTreatmentLine')).exists()" on "lines" and expect "true"

  # ==================================================================
  # 2. PHARM-11 — optional search parameters
  # ==================================================================
  # Each optional parameter is checked by its EFFECT, not merely by the
  # server returning 200: a server that accepts `status=active` and then
  # ignores it is not conformant, and a status-code check would miss that.
  Scenario: tc-meow-server-002 PHARM-11 honours the optional search parameters

    # ------------------------------------------------------------------
    # status — narrow to active treatment lines.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=meow-test-patient&status=active" as "activeLines"
    Then "response status" should be "200"
    And evaluate FHIRPath "Bundle.type" on "activeLines" and expect "searchset"
    # The filter must have been applied — no non-active line may come back.
    And evaluate FHIRPath "Bundle.entry.resource.all(status = 'active')" on "activeLines" and expect "true"

    # ------------------------------------------------------------------
    # category — the medication list category / list type.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=meow-test-patient&category=community" as "categoryLines"
    Then "response status" should be "200"
    And evaluate FHIRPath "Bundle.type" on "categoryLines" and expect "searchset"

    # ------------------------------------------------------------------
    # _lastUpdated — the incremental-sync parameter. A far-future instant
    # must return an EMPTY searchset: nothing can have been updated after
    # it. This proves the parameter is applied without depending on any
    # particular test data.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=meow-test-patient&_lastUpdated=gt2999-01-01" as "futureLines"
    Then "response status" should be "200"
    And evaluate FHIRPath "Bundle.type" on "futureLines" and expect "searchset"
    And evaluate FHIRPath "Bundle.entry.exists()" on "futureLines" and expect "false"

  # ==================================================================
  # 3. PHARM-11 — the required parameter is enforced
  # ==================================================================
  # `patient` is the one REQUIRED search parameter. A Responder that
  # answers 200 with everything it holds for a query with no patient is
  # leaking across patients, so this is a security-relevant check, not a
  # pedantic one.
  Scenario: tc-meow-server-003 PHARM-11 rejects a query without the required patient

    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement" as "unscoped"

    # Expect a client error. 400 is the usual answer; a server that uses
    # 422 instead is still refusing the query — change the expected code
    # here if that is your server's documented behaviour.
    Then "response status" should be "400"

    # FHIR requires an OperationOutcome to carry the refusal, and it must
    # be error-or-worse, not a warning the client could ignore.
    And evaluate FHIRPath "OperationOutcome.issue.exists()" on "unscoped" and expect "true"
    And evaluate FHIRPath "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" on "unscoped" and expect "true"

  # ==================================================================
  # 4. PHARM-12 — Document Option
  # ==================================================================
  # Only applies to a Responder that declares the Document Option. Skip
  # this scenario for a Responder that supports PHARM-11 alone.
  Scenario: tc-meow-server-004 PHARM-12 returns a conformant MedicationOverview

    When MedicationOverviewConsumer loads IG "http://package-server:8000/ihe.pharm.meow/1.0.0-preview2/package.tgz" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # Patient-scoped document search. `patient` is required here too.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/Bundle?patient=meow-test-patient&type=document" as "docSearch"
    Then "response status" should be "200"
    And evaluate FHIRPath "Bundle.type" on "docSearch" and expect "searchset"
    And evaluate FHIRPath "Bundle.entry.exists()" on "docSearch" and expect "true"

    # The search wraps the overview: outer Bundle is the searchset, the
    # entry resource is the MedicationOverview document itself.
    And evaluate FHIRPath "Bundle.entry.resource.all($this is Bundle)" on "docSearch" and expect "true"
    And evaluate FHIRPath "Bundle.entry.resource.all(type = 'document')" on "docSearch" and expect "true"

    # ------------------------------------------------------------------
    # Read the overview directly and hold the server to the profile.
    #
    # NOTE ON THE ID: like the patient id, this is a literal — the id
    # cannot be carried over from the search above, because a TDL string
    # literal will not interpolate a $variable into the path. Replace
    # `meow-test-overview` with a real Bundle id from your server.
    # ------------------------------------------------------------------
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/Bundle/meow-test-overview" as "overview"
    Then "response status" should be "200"

    # Cheap structural gate before the expensive profile validation, so a
    # wrong payload fails clearly instead of as a wall of validator output.
    And evaluate FHIRPath "Bundle.type" on "overview" and expect "document"

    # The conformance assertion proper — fails on any error-level issue.
    And "overview" conforms to "https://profiles.ihe.net/PHARM/MEOW/StructureDefinition/MedicationOverview"

    # Content checks the profile alone will not catch: a Bundle can be
    # structurally valid and still be an empty overview.
    And evaluate FHIRPath "Bundle.entry.resource.ofType(Composition).count()" on "overview" and expect "1"
    And evaluate FHIRPath "Bundle.entry.resource.ofType(Patient).exists()" on "overview" and expect "true"
    And evaluate FHIRPath "Bundle.entry.resource.ofType(MedicationStatement).exists()" on "overview" and expect "true"
