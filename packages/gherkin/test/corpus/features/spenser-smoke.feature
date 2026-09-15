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
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And Client is infrastructure

  Scenario: spenser-smoke-001 CapabilityStatement, inventory, and a dark-chocolate order

    # ------------------------------------------------------------------
    # Step 1: Spenser publishes a CapabilityStatement at /metadata
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/metadata" as $metadata
    Then $response.status should be 200
    # Field-by-field assertions. Note: `resourceType` is a JSON-serialization
    # marker, not a FHIR model field — FHIRPath returns empty for it. We
    # assert real model fields instead. The path expressions implicitly type-
    # filter on `CapabilityStatement.*` so if the response wasn't one, the
    # existing assertions would all return empty and the expects would fail.
    And $metadata at "CapabilityStatement.status" should be "active"
    And $metadata at "CapabilityStatement.fhirVersion" should be "5.0.0"
    And $metadata at "CapabilityStatement.publisher" should be "Spenser"
    And $metadata at "CapabilityStatement.rest.resource.where(type='MedicationRequest').exists()" should be true
    And $metadata at "CapabilityStatement.rest.resource.where(type='InventoryReport').exists()" should be true

    # ------------------------------------------------------------------
    # Step 2: Read current inventory and verify shape
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as $inventory
    Then $response.status should be 200
    # InventoryReport is a FHIR R5 resource. Most validators ship with R4
    # loaded by default and reject `InventoryReport` as an unknown resource
    # type. We use JSON Pointer extraction instead (no validator round-trip)
    # so this works regardless of the validator's FHIR version.
    And extract "/status" from $inventory as $invStatus
    And $invStatus should be "current"
    And extract "/countType" from $inventory as $invCountType
    And $invCountType should be "snapshot"
    And extract "/inventoryListing/0/item/0/item/coding/0/code" from $inventory as $firstBinCode
    And $firstBinCode should not be empty

    # ------------------------------------------------------------------
    # Step 3: Place an order for one piece of dark chocolate
    # ------------------------------------------------------------------
    # Built by the validator from the MedicationRequest profile rather than
    # written out by hand. Two reasons beyond brevity:
    #
    #  - whatever the profile makes REQUIRED is filled in automatically, so
    #    the order cannot be missing a mandatory element nobody remembered;
    #  - the shape follows the FHIR version the validator has loaded. The
    #    hand-written body this replaces used `medicationCodeableConcept`,
    #    which is R4 — while step 1 above asserts Spenser is fhirVersion
    #    5.0.0, where medication is a CodeableReference and the path is
    #    `medication.concept.coding`. It was posting an R4 body to an R5
    #    server.
    #
    # The table takes `value` for scalars, or `system`+`code` for a coding;
    # the generator picks per row, so one table covers both. `code` alone
    # (no system) matches the original payload, which carried a bare code.
    Given Spenser generates required test data from "http://hl7.org/fhir/StructureDefinition/MedicationRequest" as $darkChocolateOrder with values:
      | path                                        | value             | system | code           |
      | MedicationRequest.id                        | smoke-001         |        |                |
      | MedicationRequest.status                    | active            |        |                |
      | MedicationRequest.intent                    | instance-order    |        |                |
      | MedicationRequest.subject.reference         | Patient/smoke-001 |        |                |
      | MedicationRequest.medication.concept.coding |                   |        | chocolate-dark |

    # Worth asserting now that the resource is generated: this checks the
    # validator's own output against the base profile, not a literal we
    # typed. Against a hand-written body it would only re-state the payload.
    Then $darkChocolateOrder should be a valid MedicationRequest resource

    When Client posts to Spenser at "/MedicationRequest" with:
      """
      $darkChocolateOrder
      """
    Then $response.status should be 200
