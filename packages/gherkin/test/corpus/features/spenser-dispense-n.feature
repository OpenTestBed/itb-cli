@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: Spenser dispenses N dark chocolates and inventory drops by N
  The tester enters a number N. The test reads the current dark-chocolate
  count (X), POSTs N orders for "chocolate-dark" with a pause between each,
  then re-reads the inventory and asserts the count is X - N.

  This exercises Spenser's server role only: POST /MedicationRequest means
  "dispense now", and the unit answers with the MedicationDispense. The
  client role, where Spenser polls an order server and acts only on orders
  made actionable by a tag or a Task, is not exercised here.

  Reference profile: http://costateixeira.github.io/spenser
  Default endpoint:  http://spenser.local

  Background:
    Given Spenser is the system under test at "http://spenser.local" as defined by "http://costateixeira.github.io/spenser"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And FHIRValidator is loaded with package "jct.fhir.spenser#1.0.0"
    And Client is infrastructure

  Scenario: dispense-N-001 inventory delta matches dispense count

    # ------------------------------------------------------------------
    # Step 1: Ask the operator how many to dispense
    # ------------------------------------------------------------------
    Given Client is asked for $N with "How many dark chocolates to dispense?"

    # ------------------------------------------------------------------
    # Step 2: Snapshot the dark-chocolate count BEFORE
    #   Read with JSON Pointer rather than FHIRPath. InventoryReport is an R5
    #   resource, and a validator started on the R4 model rejects it as an
    #   unknown resource type; a pointer never reaches the validator, so this
    #   holds whichever model the validator was started on.
    #   The dark-chocolate lane is index 0 in the device's response shape:
    #     inventoryListing[0].item[0] = dark, inventoryListing[1].item[0] = milk
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as $before
    Then $response.status should be 200
    And extract "/inventoryListing/0/item/0/quantity/value" from $before as $X

    # ------------------------------------------------------------------
    # Step 3: Build a single dark-chocolate order
    # ------------------------------------------------------------------
    # Generated from the IG's SpenserRequest profile rather than from base
    # MedicationRequest. The profile fixes status and intent, binds the
    # medication to the SpenserMeds value set and requires exactly one
    # coding, so generating from it produces the order Spenser accepts
    # rather than any MedicationRequest at all. It is also FHIR 5.0.0, where
    # medication is a CodeableReference reached at `medication.concept.coding`.
    #
    # The Spenser firmware requires `id` to be non-empty (see main.cpp). We
    # use a fixed id for all N requests in this run; the device doesn't
    # enforce id-uniqueness at the MedicationRequest endpoint.
    Given Spenser generates required test data from "http://costateixeira.github.io/spenser/StructureDefinition/SpenserRequest" as $darkOrder with values:
      | path                                        | value                 | system                                                        | code           |
      | MedicationRequest.id                        | dispense-test         |                                                               |                |
      | MedicationRequest.subject.reference         | Patient/dispense-test |                                                               |                |
      | MedicationRequest.medication.concept.coding |                       | http://costateixeira.github.io/spenser/CodeSystem/SpenserMeds | chocolate-dark |

    # The same body goes out N times below, so check it once here — a
    # malformed order would otherwise fail N times with the device's error
    # rather than the validator's.
    Then $darkOrder should conform to "http://costateixeira.github.io/spenser/StructureDefinition/SpenserRequest"

    # ------------------------------------------------------------------
    # Step 4: POST the order N times. After each request the operator gets a
    # "Click Continue" prompt — pace the dispenses by hand to give Spenser
    # time to physically dispense before the next order. (TDL has no sleep
    # step in this ITB, so manual pacing is the deterministic option.)
    #
    # Each POST answers with a MedicationDispense: 200 with a completed one
    # when a piece came out, 201 with a declined one when the lane is empty.
    # The per-request answers are not asserted individually here; the
    # inventory delta in step 5 is the claim this scenario makes, and it
    # fails if any of the N did not dispense.
    # ------------------------------------------------------------------
    When Client posts $darkOrder to Spenser at "/MedicationRequest" $N times, paced manually

    # ------------------------------------------------------------------
    # Step 5: Snapshot the dark-chocolate count AFTER and assert delta
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as $after
    Then $response.status should be 200
    And extract "/inventoryListing/0/item/0/quantity/value" from $after as $Y
    And $Y should equal $X minus $N
