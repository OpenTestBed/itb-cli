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
    And FHIRValidator is infrastructure at "http://fhir-validator:8081"

  Scenario: itb-smoke-001 Generate, validate, load IG, validate against IG, FHIRPath extract and assert

    # ------------------------------------------------------------------
    # Step 1: Load the Belgian Allergy IG (pulls in be.core as a dependency)
    # ------------------------------------------------------------------
    Given FHIRValidator is loaded with package "hl7.fhir.be.allergy#1.2.0"

    # ------------------------------------------------------------------
    # Step 2: Generate resources with required elements only
    # ------------------------------------------------------------------
    Given generate required test data as "patient" from profile "http://hl7.org/fhir/StructureDefinition/Patient" with values:
      | path       | value          |
      | Patient.id | smoke-test-001 |
    Given generate required test data as "allergy" from profile "https://www.ehealth.fgov.be/standards/fhir/allergy/StructureDefinition/be-allergyintolerance" with values:
      | path                                     | system                                                            | code    |
      | AllergyIntolerance.code.coding           | http://snomed.info/sct                                            | 1232123 |
      | AllergyIntolerance.clinicalStatus.coding | http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical | active  |

    # ------------------------------------------------------------------
    # Step 3: Validate Patient against base spec, allergy against Belgian profile
    # ------------------------------------------------------------------
    Then "patient" should be a valid Patient resource
    And validate "allergy" against "https://www.ehealth.fgov.be/standards/fhir/allergy/StructureDefinition/be-allergyintolerance"
    And the validation should pass

    # ------------------------------------------------------------------
    # Step 4: Extract a value with FHIRPath (evaluate)
    # ------------------------------------------------------------------
    And evaluate FHIRPath "Patient.id" on "patient" as "patientId"

    # ------------------------------------------------------------------
    # Step 5: Assert a FHIRPath expression (evaluate-and-expect)
    # ------------------------------------------------------------------
    And evaluate FHIRPath "Patient.id.exists()" on "patient" and expect "true"

    # ------------------------------------------------------------------
    # Step 6: Pattern-match the patient against an expected shape (matchetype)
    # ------------------------------------------------------------------
    And "patient" matches pattern:
      """
      {"resourceType": "Patient", "id": "$string$"}
      """

    # ------------------------------------------------------------------
    # Step 7: Boolean assertion via FHIRPathAssertion (TAR pass/fail)
    # ------------------------------------------------------------------
    And assert FHIRPath "Patient.id.exists()" on "patient"

    # ------------------------------------------------------------------
    # Step 8: Summarize the validation outcome (validationResults)
    # ------------------------------------------------------------------
    And summarize "validationOutcome" as "errCount" "warnCount" "infoCount"
