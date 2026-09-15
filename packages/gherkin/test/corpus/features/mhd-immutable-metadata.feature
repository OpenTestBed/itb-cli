# Gazelle's ClientErrorScenario1, replicated step for step — using the SAME
# payload files the reference implementation uses.
#
# Upstream: mhd-fhir-simulators/.../usecase/client/ErrorScenario1.java
#   81 lines of Java naming 13 JSON fixtures (1,729 lines), plus a 34 kB
#   HTML description, plus a step vocabulary that lives in another repo.
#
# The fixtures are fetched from the source repository rather than copied,
# so this test cannot drift from upstream and does not restate 1,729 lines
# of near-identical JSON. Each scenario names the file it sends.
#
# CH:MHD-1 permits exactly one change to an existing DocumentReference: the
# description. A Responder that accepts any of the modifications below is
# silently rewriting metadata it is required to preserve.
@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: IHE MHD Document Responder — immutable metadata is rejected

  Background:
    Given DocumentResponder is the system under test at "https://ehealthsuisse.ihe-europe.net/fhir" as defined by "https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.DocumentResponder"
    And DocumentSource is infrastructure as defined by "https://profiles.ihe.net/ITI/MHD/StructureDefinition/IHE.MHD.DocumentSource"
    And AuthServer is infrastructure at "https://ehealthsuisse.ihe-europe.net/auth"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And set header "Accept" to "application/fhir+json"

    # The Extended IUA token, fetched as part of the run rather than pasted
    # in beforehand — Gazelle's scenarios do the same before every case.
    When DocumentSource posts to AuthServer at "/token" with:
      """
      { "grant_type": "client_credentials", "scope": "document" }
      """
    And extract "/access_token" as $iuaToken
    And set bearer token from $iuaToken

    # The document every case below tries to modify.
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/create/MHD-1_DocumentReferenceCaseHCPERR.json" as $originalDoc
    And $originalDoc should not be empty
    And DocumentSource posts to DocumentResponder at "/DocumentReference" with body $originalDoc
    And extract "/id" as $docId

  # upstream fixture: updates/KO-ErrorCase1WithoutIUAToken.json.json
  Scenario: mhd-imm-001 update changing no IUA token on the request is rejected
    Given set header "Authorization" to ""
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase1WithoutIUAToken.json.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase2ForOtherPatientId.json
  Scenario: mhd-imm-002 update changing a different patient id is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase2ForOtherPatientId.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-1creationTimeModified.json
  Scenario: mhd-imm-003 update changing creationTime is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-1creationTimeModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-2-documentAvailabilityModified.json
  Scenario: mhd-imm-004 update changing documentAvailability is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-2-documentAvailabilityModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-3-entryUUIDModified.json
  Scenario: mhd-imm-005 update changing entryUUID is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-3-entryUUIDModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-4-hashModified.json
  Scenario: mhd-imm-006 update changing hash is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-4-hashModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-5-homeCommunityIdModified.json
  Scenario: mhd-imm-007 update changing homeCommunityId is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-5-homeCommunityIdModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-6-limitedMetadataModified.json
  Scenario: mhd-imm-008 update changing limitedMetadata is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-6-limitedMetadataModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-7-logicalIdModified.json
  Scenario: mhd-imm-009 update changing logicalId is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-7-logicalIdModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-8-objectTypeModified.json
  Scenario: mhd-imm-010 update changing objectType is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-8-objectTypeModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-9-repositoryUniqueIdModified.json
  Scenario: mhd-imm-011 update changing repositoryUniqueId is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-9-repositoryUniqueIdModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-10-sizeModified.json
  Scenario: mhd-imm-012 update changing size is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-10-sizeModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  # upstream fixture: updates/KO-ErrorCase3-14-originalProviderRoleModified.json
  Scenario: mhd-imm-013 update changing originalProviderRole is rejected
    When DocumentSource gets "https://gitlab.inria.fr/gazelle/public/simulation/mhd-fhir-simulators/-/raw/master/mhd-fhir-simulators-domain/src/main/resources/updates/KO-ErrorCase3-14-originalProviderRoleModified.json" as $payload
    Then $payload should not be empty
    When DocumentSource puts to DocumentResponder at "/DocumentReference/" with id $docId with body $payload
    Then $response.status should be 400
    And $response at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true
