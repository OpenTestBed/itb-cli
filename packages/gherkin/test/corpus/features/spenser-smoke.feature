@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: FHIR Spenser dispenser smoke test
  A smoke test against the Spenser chocolate dispenser, exercising the
  server-mode interactions the IG declares:
    1. CapabilityStatement — /metadata, declaring BOTH of Spenser's roles
    2. Inventory           — GET /InventoryReport returns current lane contents
    3. Order               — POST /MedicationRequest answers with a MedicationDispense
    4. History             — GET /MedicationDispense returns what it has been doing

  Reference profile: http://costateixeira.github.io/spenser
  Default endpoint:  http://spenser.local  (override per device)

  Spenser has two roles, and this file covers only the first. As a server it
  dispenses on demand, which is everything below. As a client it polls an
  order server and acts on orders that have been made actionable, either by a
  tag or by a Task. Nothing here exercises that; see the note at the foot of
  this file.

  Background:
    Given Spenser is the system under test at "http://spenser.local" as defined by "http://costateixeira.github.io/spenser"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And FHIRValidator is loaded with package "jct.fhir.spenser#1.0.0"
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

    # Both roles are declared. The IG's CapabilityStatement carries two `rest`
    # entries: a server that dispenses on demand, and a client that polls an
    # order server. Every resource assertion below is scoped to one of them,
    # because `rest.resource` alone now spans both and would pass on the
    # strength of the wrong role.
    And $metadata at "CapabilityStatement.rest.where(mode='server').exists()" should be true
    And $metadata at "CapabilityStatement.rest.where(mode='client').exists()" should be true
    And $metadata at "CapabilityStatement.rest.where(mode='server').resource.where(type='MedicationRequest').exists()" should be true
    And $metadata at "CapabilityStatement.rest.where(mode='server').resource.where(type='MedicationDispense').exists()" should be true
    And $metadata at "CapabilityStatement.rest.where(mode='server').resource.where(type='InventoryReport').exists()" should be true
    # The client role is what makes an order actionable meaningful: Spenser
    # searches for orders carrying the `actionable` tag, and for Tasks asking
    # for one to be fulfilled.
    And $metadata at "CapabilityStatement.rest.where(mode='client').resource.where(type='Task').exists()" should be true
    And $metadata at "CapabilityStatement.rest.where(mode='client').resource.where(type='MedicationRequest').searchParam.where(name='_tag').exists()" should be true

    # ------------------------------------------------------------------
    # Step 2: Read current inventory and verify shape
    # ------------------------------------------------------------------
    When Client gets from Spenser at "/InventoryReport" as $inventory
    Then $response.status should be 200
    # Read with JSON Pointer rather than FHIRPath. InventoryReport is an R5
    # resource, and a validator started on the R4 model rejects it as an
    # unknown resource type; a pointer does not go near the validator, so
    # this holds whichever model the validator was started on. Deliberate:
    # the smoke test should not fail for a reason that is about our own
    # deployment rather than about Spenser.
    And extract "/status" from $inventory as $invStatus
    And $invStatus should be "current"
    And extract "/countType" from $inventory as $invCountType
    And $invCountType should be "snapshot"
    And extract "/inventoryListing/0/item/0/item/coding/0/code" from $inventory as $firstBinCode
    And $firstBinCode should not be empty

    # ------------------------------------------------------------------
    # Step 3: Place an order for one piece of dark chocolate
    # ------------------------------------------------------------------
    # Built by the validator from the IG's own SpenserRequest profile rather
    # than written out by hand. Three reasons beyond brevity:
    #
    #  - whatever the profile makes REQUIRED is filled in automatically, so
    #    the order cannot be missing a mandatory element nobody remembered;
    #  - SpenserRequest is stricter than base MedicationRequest — it fixes
    #    status and intent, binds medication to the SpenserMeds value set and
    #    requires exactly one coding — so generating from it tests the order
    #    Spenser actually accepts rather than any MedicationRequest at all;
    #  - the shape follows the FHIR version of the profile, which is 5.0.0,
    #    where medication is a CodeableReference reached at
    #    `medication.concept.coding`.
    #
    # The table takes `value` for scalars, or `system`+`code` for a coding;
    # the generator picks per row, so one table covers both.
    Given Spenser generates required test data from "http://costateixeira.github.io/spenser/StructureDefinition/SpenserRequest" as $darkChocolateOrder with values:
      | path                                        | value             | system                                              | code           |
      | MedicationRequest.id                        | smoke-001         |                                                     |                |
      | MedicationRequest.subject.reference         | Patient/smoke-001 |                                                     |                |
      | MedicationRequest.medication.concept.coding |                   | http://costateixeira.github.io/spenser/CodeSystem/SpenserMeds | chocolate-dark |

    # Worth asserting now that the resource is generated: this checks the
    # validator's own output against the profile, not a literal we typed.
    Then $darkChocolateOrder should conform to "http://costateixeira.github.io/spenser/StructureDefinition/SpenserRequest"

    # POST /MedicationRequest means "dispense now", and the answer is the
    # MedicationDispense — 200 with a completed one when a piece came out,
    # 201 with a declined one when the lane is empty. Asserting only the
    # status would let a unit pass by answering 200 with anything at all.
    When Client posts to Spenser at "/MedicationRequest" with body $darkChocolateOrder
    Then $response.status should be 200
    And extract "/resourceType" from $response.body as $dispenseType
    And $dispenseType should be "MedicationDispense"
    And extract "/status" from $response.body as $dispenseStatus
    And $dispenseStatus should be "completed"

    # ------------------------------------------------------------------
    # Step 4: The dispense shows up in the unit's history
    # ------------------------------------------------------------------
    # GET /MedicationDispense is how you ask a unit what it has been doing:
    # a searchset of recent dispenses, newest first, plus one entry whose
    # search.mode is `outcome` carrying an OperationOutcome about the last
    # check of the order server.
    When Client gets from Spenser at "/MedicationDispense" as $history
    Then $response.status should be 200
    And extract "/resourceType" from $history as $historyType
    And $historyType should be "Bundle"
    And extract "/entry/0/resource/resourceType" from $history as $firstEntryType
    And $firstEntryType should not be empty

  # ====================================================================
  # Not covered here
  # ====================================================================
  # Spenser's client role is specified in the IG and untested: it polls an
  # order server and dispenses an order only when the order has been made
  # actionable, either by the `actionable` tag on the MedicationRequest or by
  # a Task with status `requested` pointing at it in Task.focus. Testing it
  # needs the test bed to stand in for the order server and answer the two
  # searches Spenser issues on every check, which the language supports
  # (`is listening for`, `receives a request from`, `replies to`) but which is
  # a separate feature file, not a scenario here.
  #
  # Also untested: a declined dispense (201 with status `declined` and the
  # reason in `notPerformedReason`), which needs an empty lane to provoke.
