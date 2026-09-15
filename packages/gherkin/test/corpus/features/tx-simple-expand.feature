# Worked example: one suite from the HL7 FHIR terminology-ecosystem test set,
# expressed in the ITB Gherkin dialect.
#
# Upstream: https://github.com/HL7/fhir-tx-ecosystem-ig/tree/main/tests
#   38 suites, 1183 tests, defined in test-cases.json. Each test is:
#     setup     — CodeSystem/ValueSet resources the suite depends on
#     operation — $expand or $validate-code
#     request   — a Parameters resource (the operation input)
#     response  — the expected ValueSet / Parameters / OperationOutcome
#
# WHY THIS MAPS WELL: the upstream expected-response files are matchetypes.
# They already use $id$, $uuid$, $instant$ and $optional-properties$ — the
# same placeholder convention the dialect's `matches pattern:` step feeds to
# the validator's /itb/matchetype service. So the comparison does not have to
# be re-invented; the expected file can be used verbatim as the pattern.
#
# See ../README.md for what a full mechanical conversion would need.
@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: FHIR terminology server — simple expansion
  One test from the upstream `simple-cases` suite: expand a ValueSet that
  includes an entire CodeSystem, with excludeNested, and compare the result
  against the expected expansion.

  Background:
    Given TxServer is the system under test at "https://tx.fhir.org/r5" as defined by "http://hl7.org/fhir/CapabilityStatement/terminology-server"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And Client is infrastructure

  Scenario: tx-simple-001 simple-expand-all

    # ------------------------------------------------------------------
    # Setup. The upstream suite lists 14 resources; this test needs two of
    # them. They are fetched from the source repo rather than embedded, so
    # the test cannot drift from upstream — and so a converted suite stays
    # readable instead of carrying kilobytes of inlined JSON.
    # ------------------------------------------------------------------
    When Client gets "https://raw.githubusercontent.com/HL7/fhir-tx-ecosystem-ig/main/tests/simple/codesystem-simple.json" as $csSimple
    Then $csSimple should not be empty
    When Client posts to TxServer at "/CodeSystem" with:
      """
      $csSimple
      """

    When Client gets "https://raw.githubusercontent.com/HL7/fhir-tx-ecosystem-ig/main/tests/simple/valueset-all.json" as $vsAll
    Then $vsAll should not be empty
    When Client posts to TxServer at "/ValueSet" with:
      """
      $vsAll
      """

    # ------------------------------------------------------------------
    # The operation under test. Upstream this is:
    #   operation: expand
    #   request:   simple/simple-expand-all-request-parameters.json
    # ------------------------------------------------------------------
    When Client posts to TxServer at "/ValueSet/$expand" with:
      """
      {
        "resourceType": "Parameters",
        "parameter": [
          { "name": "url", "valueUri": "http://hl7.org/fhir/test/ValueSet/simple-all" },
          { "name": "excludeNested", "valueBoolean": true }
        ]
      }
      """
    Then $response.status should be 200

    # ------------------------------------------------------------------
    # The comparison. Upstream this is the whole
    # simple-expand-all-response-valueSet.json, used as a matchetype —
    # $id$, $uuid$ and $instant$ match by type rather than by value, and
    # $optional-properties$ names the elements a server may omit.
    #
    # Abridged here to the parts that carry the meaning; a mechanical
    # conversion would embed the upstream file unchanged.
    # ------------------------------------------------------------------
    And $response should match pattern:
      """
      {
        "$optional-properties$": ["id", "date", "publisher", "compose"],
        "resourceType": "ValueSet",
        "id": "$id$",
        "url": "http://hl7.org/fhir/test/ValueSet/simple-all",
        "version": "5.0.0",
        "name": "SimpleValueSetAll",
        "status": "active",
        "expansion": {
          "$optional-properties$": ["id", "offset"],
          "id": "$id$",
          "identifier": "$uuid$",
          "timestamp": "$instant$",
          "total": 7
        }
      }
      """

    # A couple of FHIRPath assertions on top, for the parts worth stating
    # in the report rather than leaving inside a pattern match.
    And $response at "ValueSet.expansion.total" should be 7
    And $response at "ValueSet.expansion.contains.exists()" should be true
