Feature: Spenser dispenses N dark chocolates and inventory drops by N
  Background:
    Given Spenser is the system under test at "http://spenser.local" as defined by "http://costateixeira.github.io/spenser"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And Client is infrastructure

  Scenario: dispense-N-001 inventory delta matches dispense count
    Given Client is asked for $N with "How many dark chocolates to dispense?"
    When Client gets from Spenser at "/InventoryReport" as $before
    Then $response.status should be 200
    And extract "/inventoryListing/0/item/0/quantity/value" from $before as $X
    Given Spenser generates required test data from "http://hl7.org/fhir/StructureDefinition/MedicationRequest" as $darkOrder with values:
      | path                                        | value                  | system | code           |
      | MedicationRequest.id                        | dispense-test          |        |                |
      | MedicationRequest.status                    | active                 |        |                |
      | MedicationRequest.intent                    | instance-order         |        |                |
      | MedicationRequest.subject.reference         | Patient/dispense-test  |        |                |
      | MedicationRequest.medication.concept.coding |                        |        | chocolate-dark |
    Then $darkOrder should be a valid MedicationRequest resource
    When Client posts $darkOrder to Spenser at "/MedicationRequest" $N times, paced manually
    When Client gets from Spenser at "/InventoryReport" as $after
    Then $response.status should be 200
    And extract "/inventoryListing/0/item/0/quantity/value" from $after as $Y
    And $Y should equal $X minus $N
