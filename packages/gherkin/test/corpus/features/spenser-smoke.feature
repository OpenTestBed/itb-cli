Feature: FHIR Spenser dispenser smoke test
  A simple smoke test against the Spenser chocolate dispenser, exercising
  three core capabilities:
    1. CapabilityStatement — server publishes /metadata
    2. Inventory      — GET /InventoryReport returns current bin contents
    3. Order          — POST /MedicationRequest with a chocolate code is accepted

  Reference profile: http://costateixeira.github.io/spenser
  Default endpoint:  http://spenser.local  (override per device)

  Background:
    Given Spenser is the system under test at "http://spenser.local" as defined by "http://costateixeira.github.io/spenser"
    And FHIRValidator is infrastructure at "http://fhir-validator:8081"
    And Client is infrastructure

  Scenario: spenser-smoke-001 CapabilityStatement, inventory, and a dark-chocolate order

    # ------------------------------------------------------------------
    # Step 1: Spenser publishes a CapabilityStatement at /metadata
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/metadata" as "metadata"
    Then "response status" should be "200"
    # Field-by-field assertions. Note: `resourceType` is a JSON-serialization
    # marker, not a FHIR model field — FHIRPath returns empty for it. We
    # assert real model fields instead. The path expressions implicitly type-
    # filter on `CapabilityStatement.*` so if the response wasn't one, the
    # existing assertions would all return empty and the expects would fail.
    And evaluate FHIRPath "CapabilityStatement.status" on "metadata" and expect "active"
    And evaluate FHIRPath "CapabilityStatement.fhirVersion" on "metadata" and expect "5.0.0"
    And evaluate FHIRPath "CapabilityStatement.publisher" on "metadata" and expect "Spenser"
    And evaluate FHIRPath "CapabilityStatement.rest.resource.where(type='MedicationRequest').exists()" on "metadata" and expect "true"
    And evaluate FHIRPath "CapabilityStatement.rest.resource.where(type='InventoryReport').exists()" on "metadata" and expect "true"

    # ------------------------------------------------------------------
    # Step 2: Read current inventory and verify shape
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as "inventory"
    Then "response status" should be "200"
    # InventoryReport is a FHIR R5 resource. Most validators ship with R4
    # loaded by default and reject `InventoryReport` as an unknown resource
    # type. We use JSON Pointer extraction instead (no validator round-trip)
    # so this works regardless of the validator's FHIR version.
    And extract "/status" from "inventory" as "invStatus"
    And "invStatus" should be "current"
    And extract "/countType" from "inventory" as "invCountType"
    And "invCountType" should be "snapshot"
    And extract "/inventoryListing/0/item/0/item/coding/0/code" from "inventory" as "firstBinCode"
    And "firstBinCode" should not be empty

    # ------------------------------------------------------------------
    # Step 3: Place an order for one piece of dark chocolate
    # ------------------------------------------------------------------
    Given set "darkChocolateOrder" to:
      """
      {
        "resourceType": "MedicationRequest",
        "id": "smoke-001",
        "status": "active",
        "intent": "instance-order",
        "medicationCodeableConcept": {
          "coding": [
            { "code": "chocolate-dark" }
          ]
        },
        "subject": { "reference": "Patient/smoke-001" }
      }
      """
    When Client posts to Spenser at "/MedicationRequest" with:
      """
      $darkChocolateOrder
      """
    Then "response status" should be "200"
