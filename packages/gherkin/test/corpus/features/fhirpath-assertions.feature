Feature: FHIRPath expression evaluation and assertions
  A generated resource is a FHIR resource, so FHIRPath can be evaluated on
  it directly with `at "…"`; the same expressions bind values with `extract`.

  Background:
    Given Client is the system under test
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"

  Scenario: FHIRPath checks on generated data
    Given Client generates test data from "http://hl7.org/fhir/StructureDefinition/Patient" as $patient
    Then $patient at "Patient.name.exists()" should be true
    And $patient at "Patient.name.count()" should be 1
    And extract "Patient.name.family" from $patient as $familyName
    And $familyName should not be empty
    And $patient should satisfy "Patient.name.family.exists()"
