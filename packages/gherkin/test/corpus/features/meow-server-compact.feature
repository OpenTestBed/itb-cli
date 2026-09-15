@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: IHE MEOW Medication Overview Responder — server-side conformance-demo
  Background:
    Given MedicationOverviewResponder is the system under test at "https://hapi.fhir.org/baseR4" as defined by "https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewResponder"
    And MedicationOverviewConsumer is infrastructure as defined by "https://profiles.ihe.net/PHARM/MEOW/CapabilityStatement/MedicationOverviewConsumer"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8080"

  Scenario: tc-meow-server-001 PHARM-11 query by patient returns treatment lines
    When MedicationOverviewConsumer loads IG "https://profiles.ihe.net/PHARM/MEOW/package.tgz" on FHIRValidator
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=137202631" as $lines
    Then $response.status should be 200
    And $lines should not be empty
    And $lines at "Bundle.type" should be "searchset"
    And $lines at "Bundle.entry.exists()" should be true
    And $lines at "Bundle.entry.resource.all($this is MedicationStatement)" should be true
    And $lines at "Bundle.entry.resource.subject.reference.all(endsWith('137202631'))" should be true
    And $lines at "Bundle.entry.resource.meta.profile.where($this.startsWith('https://profiles.ihe.net/PHARM/MEOW/StructureDefinition/MedicationTreatmentLine')).exists()" should be true

  Scenario: tc-meow-server-002 PHARM-11 honours the optional search parameters
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=137202631&status=active" as $activeLines
    Then $response.status should be 200
    And $activeLines at "Bundle.type" should be "searchset"
    And $activeLines at "Bundle.entry.resource.all(status = 'active')" should be true
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=137202631&category=community" as $categoryLines
    Then $response.status should be 200
    And $categoryLines at "Bundle.type" should be "searchset"
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement?patient=137202631&_lastUpdated=gt2999-01-01" as $futureLines
    Then $response.status should be 200
    And $futureLines at "Bundle.type" should be "searchset"
    And $futureLines at "Bundle.entry.exists()" should be false

  Scenario: tc-meow-server-003 PHARM-11 rejects a query without the required patient
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/MedicationStatement" as $unscoped
    Then $response.status should be 400
    And $unscoped at "OperationOutcome.issue.exists()" should be true
    And $unscoped at "OperationOutcome.issue.where(severity in ('error' | 'fatal')).exists()" should be true

  Scenario: tc-meow-server-004 PHARM-12 returns a conformant MedicationOverview
    When MedicationOverviewConsumer loads IG "https://profiles.ihe.net/PHARM/MEOW/package.tgz" on FHIRValidator
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/Bundle?patient=137202631&type=document" as $docSearch
    Then $response.status should be 200
    And $docSearch at "Bundle.type" should be "searchset"
    And $docSearch at "Bundle.entry.exists()" should be true
    And $docSearch at "Bundle.entry.resource.all($this is Bundle)" should be true
    And $docSearch at "Bundle.entry.resource.all(type = 'document')" should be true
    When MedicationOverviewConsumer gets from MedicationOverviewResponder at "/Bundle/meow-test-overview" as $overview
    Then $response.status should be 200
    And $overview at "Bundle.type" should be "document"
    And $overview should conform to "https://profiles.ihe.net/PHARM/MEOW/StructureDefinition/MedicationOverview"
    And $overview at "Bundle.entry.resource.ofType(Composition).count()" should be 1
    And $overview at "Bundle.entry.resource.ofType(Patient).exists()" should be true
    And $overview at "Bundle.entry.resource.ofType(MedicationStatement).exists()" should be true
