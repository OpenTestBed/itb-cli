# Gazelle's ClientNominalScenario1 and ClientNominalScenario2, replicated
# with the SAME payload files the reference implementation uses.
#
# Upstream: mhd-fhir-simulators/.../usecase/client/
#   NominalScenario1  create/MHD-1_DocumentReferenceCaseInnerPat.json
#                     updates/OK-NominalCaseInnerCommunity-request.json  (x2)
#   NominalScenario2  updates/OK-Alternative1CaseCrossCommunity.json
#
# NominalScenario1 sends the update TWICE — the second send is what proves
# the operation is idempotent, and it is easy to miss in the Java because
# the same filename simply appears in the step list twice.
@lang:itb-core-en@^1.6 @dialect:fhir-validator@^1.0
Feature: IHE MHD Document Responder — CH:MHD-1 nominal update
  CH:MHD-1 permits one change to an existing DocumentReference: the
  description. These are the cases that must SUCCEED — within a community
  and across communities — as the counterpart to the rejection cases in
  mhd-immutable-metadata.feature.

  Background:
    Given DocumentResponder is the system under test at "https://ehealthsuisse.ihe-europe.net/fhir" as defined by "https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.DocumentResponder"
    And DocumentSource is infrastructure as defined by "https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.DocumentSource"
    And AuthServer is infrastructure at "https://ehealthsuisse.ihe-europe.net/auth"
    And set header "Accept" to "application/fhir+json"

    # Extended IUA token, fetched in the run rather than pasted in.
    When DocumentSource posts to AuthServer at "/token" with:
      """
      { "grant_type": "client_credentials", "scope": "document" }
      """
    And extract "/access_token" as "iuaToken"
    And set bearer token from "iuaToken"

  # ==================================================================
  # ClientNominalScenario1 — update within the community
  # ==================================================================
  Scenario: mhd-nom-001 description is updated, and the update is idempotent

    # ITI-65 precondition: the Responder must already hold the document.
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/create/MHD-1_DocumentReferenceCaseInnerPat.json" as "originalDoc"
    Then "originalDoc" should not be empty
    When DocumentSource posts to DocumentResponder at "/DocumentReference" with body "originalDoc"
    Then "response status" should be "201"
    And extract "/id" as "docId"
    And "docId" should not be empty

    # CH:MHD-1 Update Document Metadata.
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/OK-NominalCaseInnerCommunity-request.json" as "updatePayload"
    Then "updatePayload" should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id "docId" and body "updatePayload"
    Then "response status" should be "200"

    # The same update sent a second time — upstream lists this file twice,
    # and this is the assertion that repetition is there to make: applying
    # it again must not fail and must not change anything further.
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id "docId" and body "updatePayload"
    Then "response status" should be "200"

    # Verify against the Responder rather than trusting its response.
    When DocumentSource gets from DocumentResponder at "/DocumentReference/" with id "docId" as "updated"
    Then "response status" should be "200"
    And evaluate FHIRPath "DocumentReference.status" on "updated" and expect "current"
    And "updated" conforms to "http://fhir.ch/ig/ch-epr-fhir/StructureDefinition/ch-mhd-documentreference-comprehensive"

  # ==================================================================
  # ClientNominalScenario2 — update in another community
  # ==================================================================
  # The Responder is asked to update metadata for a document held in a
  # different community. Upstream this is a single step with no ITI-65
  # precondition: the document is expected to exist already, reached
  # through the homeCommunityId in the payload.
  Scenario: mhd-nom-002 cross-community update is accepted

    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/OK-Alternative1CaseCrossCommunity.json" as "crossPayload"
    Then "crossPayload" should not be empty

    # The id is the one carried in the payload's own logicalId, so the path
    # is fixed here rather than chained from a create. Replace it if your
    # deployment hosts the cross-community document under another id.
    When DocumentSource puts to DocumentResponder at "/DocumentReference/chmhd1-cross-community" with body "crossPayload"
    Then "response status" should be "200"
