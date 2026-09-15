Feature: FHIR Validator ITB REST API smoke test
  Exercises all GITB-aligned endpoints under /itb/* end to end:
    - igManager: load an IG
    - testdata: generate resources (required elements only)
    - fhir: validate against base spec and against an IG profile
    - matchetype: pattern-match a resource against an expected shape
    - fhirPath: evaluate (extract a value)
    - fhirPathAssertion: assert a boolean expression on a resource
    - validationResults: summarize an OperationOutcome

  Background:
    Given Client is the system under test
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"

  Scenario: itb-smoke-001 Generate, validate, load IG, validate against IG, FHIRPath extract and assert

    # ------------------------------------------------------------------
    # Step 1: Load the Belgian Allergy IG (pulls in be.core as a dependency)
    # ------------------------------------------------------------------
    Given FHIRValidator is loaded with package "hl7.fhir.be.allergy#1.2.0"

    # ------------------------------------------------------------------
    # Step 2: Generate resources with required elements only
    # ------------------------------------------------------------------
    Given Client generates required test data from "http://hl7.org/fhir/StructureDefinition/Patient" as $patient with values:
      | path       | value          |
      | Patient.id | smoke-test-001 |
    Given Client generates required test data from "https://www.ehealth.fgov.be/standards/fhir/allergy/StructureDefinition/be-allergyintolerance" as $allergy with values:
      | path                                     | system                                                            | code    |
      | AllergyIntolerance.code.coding           | http://snomed.info/sct                                            | 1232123 |
      | AllergyIntolerance.clinicalStatus.coding | http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical | active  |

    # ------------------------------------------------------------------
    # Step 3: Validate Patient against base spec, allergy against Belgian profile
    # ------------------------------------------------------------------
    Then $patient should be a valid Patient resource
    And Client validates $allergy against "https://www.ehealth.fgov.be/standards/fhir/allergy/StructureDefinition/be-allergyintolerance"
    And $validation.errors should be 0

    # ------------------------------------------------------------------
    # Step 4: Extract a value with FHIRPath (evaluate)
    # ------------------------------------------------------------------
    And extract "Patient.id" from $patient as $patientId

    # ------------------------------------------------------------------
    # Step 5: Assert a FHIRPath expression (evaluate-and-expect)
    # ------------------------------------------------------------------
    And $patient at "Patient.id.exists()" should be true

    # ------------------------------------------------------------------
    # Step 6: Pattern-match the patient against an expected shape (matchetype)
    # ------------------------------------------------------------------
    And $patient should match pattern:
      """
      {"resourceType": "Patient", "id": "$string$"}
      """

    # ------------------------------------------------------------------
    # Step 7: Boolean assertion via FHIRPathAssertion (TAR pass/fail)
    # ------------------------------------------------------------------
    And $patient should satisfy "Patient.id.exists()"

    # ------------------------------------------------------------------
    # Step 8: Summarize the validation outcome (validationResults)
    # ------------------------------------------------------------------
    And Client summarizes $validationOutcome as $summary
