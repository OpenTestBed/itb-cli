Feature: Spenser dispenses N dark chocolates and inventory drops by N
  The tester enters a number N. The test reads the current dark-chocolate
  count (X), POSTs N orders for "chocolate-dark" with a 2-second delay
  between each, then re-reads the inventory and asserts the count is X - N.

  Reference profile: http://costateixeira.github.io/spenser
  Default endpoint:  http://spenser.local

  Background:
    Given Spenser is the system under test at "http://spenser.local" as defined by "http://costateixeira.github.io/spenser"
    And FHIRValidator is infrastructure at "http://fhir-validator:8081"
    And Client is infrastructure

  Scenario: dispense-N-001 inventory delta matches dispense count

    # ------------------------------------------------------------------
    # Step 1: Ask the operator how many to dispense
    # ------------------------------------------------------------------
    Given Client is asked for "N" with "How many dark chocolates to dispense?"

    # ------------------------------------------------------------------
    # Step 2: Snapshot the dark-chocolate count BEFORE
    #   InventoryReport is a FHIR R5 resource and most validators are R4 —
    #   FHIRPath fails with "unknown resource type". Use JSON Pointer.
    #   The dark-chocolate bin is index 0 in the device's response shape:
    #     inventoryListing[0].item[0] = dark, inventoryListing[1].item[0] = milk
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as "before"
    Then "response status" should be "200"
    And extract "/inventoryListing/0/item/0/quantity/value" from "before" as "X"

    # ------------------------------------------------------------------
    # Step 3: Build a single dark-chocolate MedicationRequest body
    # ------------------------------------------------------------------
    # The Spenser firmware requires `id` to be non-empty (see main.cpp). We
    # use a fixed id for all N requests in this run; the device doesn't
    # enforce id-uniqueness at the MedicationRequest endpoint.
    Given set "darkOrder" to:
      """
      {
        "resourceType": "MedicationRequest",
        "id": "dispense-test",
        "status": "active",
        "intent": "instance-order",
        "medicationCodeableConcept": {
          "coding": [{"code": "chocolate-dark"}]
        },
        "subject": {"reference": "Patient/dispense-test"}
      }
      """

    # ------------------------------------------------------------------
    # Step 4: POST the order N times. After each request the operator gets a
    # "Click Continue" prompt — pace the dispenses by hand to give Spenser
    # time to physically dispense before the next order. (TDL has no sleep
    # step in this ITB, so manual pacing is the deterministic option.)
    # ------------------------------------------------------------------
    When Client posts "darkOrder" to Spenser at "/MedicationRequest" $N times, paced manually

    # ------------------------------------------------------------------
    # Step 5: Snapshot the dark-chocolate count AFTER and assert delta
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as "after"
    Then "response status" should be "200"
    And extract "/inventoryListing/0/item/0/quantity/value" from "after" as "Y"
    And "Y" should equal "X" minus "$N"
