Feature: FHIR server smoke test
  A simple smoke test against a FHIR R4 server, exercising three core capabilities:
    1. CapabilityStatement — server publishes /metadata
    2. Create — POST /Patient returns 201 with a server-assigned id
    3. Read   — GET /Patient/{id} round-trips the resource

  Reference profile: base FHIR R4 Patient
    http://hl7.org/fhir/StructureDefinition/Patient

  Background:
    Given FHIRServer is the system under test at "http://localhost:8080/fhir"
    And FHIRValidator is infrastructure at "http://fhir-validator:8081"
    And Client is infrastructure

  Scenario: server-smoke-001 CapabilityStatement, create, and read round-trip

    # ------------------------------------------------------------------
    # Step 1: Server publishes a CapabilityStatement at /metadata
    # ------------------------------------------------------------------
    When Client gets "$FHIRServerBase/metadata" as "metadata"
    Then "response status" should be "200"
    And "metadata" matches pattern:
      """
      {"resourceType": "CapabilityStatement"}
      """

    # ------------------------------------------------------------------
    # Step 2: Generate a minimal Patient (FHIRValidator builds it)
    # ------------------------------------------------------------------
    Given generate required test data as "patient" from profile "http://hl7.org/fhir/StructureDefinition/Patient" with values:
      | path       | value         |
      | Patient.id | smoke-pat-001 |

    # ------------------------------------------------------------------
    # Step 3: Validate the resource locally before sending it to the SUT
    # ------------------------------------------------------------------
    Then "patient" should be a valid Patient resource

    # ------------------------------------------------------------------
    # Step 4: Create the Patient on the server
    # ------------------------------------------------------------------
    When Client posts to FHIRServer at "/Patient" with:
      """
      $patient
      """
    Then "response status" should be "201"

    # ------------------------------------------------------------------
    # Step 5: Read the Patient back and verify the shape
    # ------------------------------------------------------------------
    When Client gets "$FHIRServerBase/Patient/smoke-pat-001" as "fetched"
    Then "response status" should be "200"
    And "fetched" matches pattern:
      """
      {"resourceType": "Patient", "id": "smoke-pat-001"}
      """
    And assert FHIRPath "Patient.id = 'smoke-pat-001'" on "fetched"
