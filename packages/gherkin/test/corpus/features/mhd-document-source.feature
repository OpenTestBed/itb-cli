# Gazelle's ServerNominalScenario1 — the mirror test, where the SUT is the
# Document SOURCE and ITB plays the Responder.
#
# Upstream: mhd-fhir-simulators/.../usecase/server/NominalScenario1.java
#   "the SUT acting as a MHD Document Source sends a MHD-1 update request to
#    the Simulator to update an existing DocumentReference. The Extended IUA
#    token (or mTLS/XUA Assertion) is embedded in the request as defined in
#    the MHD-1 Security Consideration section."
#
# This is the case that needs ITB to ANSWER, not just listen. `waits for`
# catches a request but a bare send afterwards is a new outbound message, so
# the SUT would sit waiting for an HTTP response that never comes. Answering
# needs a transaction — <btxn>/<etxn> with a txnId that the receive and the
# reply both carry, which is what lands the reply on the SUT's own
# connection.
@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: IHE MHD Document Source — CH:MHD-1 update is well formed
  The SUT is a Document Source. ITB plays the Responder: it accepts the
  update the SUT sends, checks the request against CH:MHD-1, and answers.

  Background:
    Given DocumentSource is the system under test as defined by "https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.DocumentSource"
    And DocumentResponder is infrastructure as defined by "https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.DocumentResponder"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"

  Scenario: mhd-src-001 the SUT sends a conformant CH:MHD-1 update

    # ------------------------------------------------------------------
    # Open the exchange BEFORE telling the operator to act, so ITB is
    # already listening when the request arrives.
    # ------------------------------------------------------------------
    Given DocumentResponder is listening for DocumentSource
    And DocumentSource is informed "Send a CH:MHD-1 Update Document Metadata request to the Responder endpoint configured for this session, changing only the document description."

    When DocumentResponder receives a request from DocumentSource within 300 seconds

    # ------------------------------------------------------------------
    # CH:MHD-1 is an update of an existing DocumentReference: a PUT, not a
    # POST, addressed to the resource.
    # ------------------------------------------------------------------
    Then $received.method should be "PUT"
    And $received.path should contain "/DocumentReference/"

    # The Security Considerations section requires the token in the request.
    And $received.headers.Authorization should contain "Bearer"

    # The body must be a DocumentReference that conforms to the Swiss
    # profile — this is the assertion the whole test exists for.
    And $received.body should not be empty
    And $received.body at "DocumentReference.status" should be "current"
    And $received.body should conform to "http://fhir.ch/ig/ch-epr-fhir/StructureDefinition/ch-mhd-documentreference-comprehensive"

    # ------------------------------------------------------------------
    # Answer it. Without this the SUT times out and cannot tell a passing
    # test from an unreachable Responder.
    # ------------------------------------------------------------------
    And DocumentResponder replies to DocumentSource with status 200 and:
      """
      {
        "resourceType": "OperationOutcome",
        "issue": [{
          "severity": "information",
          "code": "informational",
          "details": { "text": "Update accepted" }
        }]
      }
      """

    And DocumentResponder stops listening for DocumentSource
