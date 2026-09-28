@lang:itb-core-en@^2 @dialect:fhir-validator@^2
Feature: Spenser dispenses N dark chocolates and inventory drops by N
  The same test as spenser-dispense-n.feature, with the reasoning stripped
  out. Read that one to understand why each step is there.

  Background:
    Given Spenser is the system under test at "http://spenser.local" as defined by "http://costateixeira.github.io/spenser"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And FHIRValidator is loaded with package "jct.fhir.spenser#1.0.0"
    And Client is infrastructure

  Scenario: dispense-N-001 inventory delta matches dispense count
    Given Client is asked for $N with "How many dark chocolates to dispense?"
    When Client gets from Spenser at "/InventoryReport" as $before
    Then $response.status should be 200
    And extract "/inventoryListing/0/item/0/quantity/value" from $before as $X
    Given Spenser generates required test data from "http://costateixeira.github.io/spenser/StructureDefinition/SpenserRequest" as $darkOrder with values:
      | path                                        | value                 | system                                                        | code           |
      | MedicationRequest.id                        | dispense-test         |                                                               |                |
      | MedicationRequest.subject.reference         | Patient/dispense-test |                                                               |                |
      | MedicationRequest.medication.concept.coding |                       | http://costateixeira.github.io/spenser/CodeSystem/SpenserMeds | chocolate-dark |
    Then $darkOrder should conform to "http://costateixeira.github.io/spenser/StructureDefinition/SpenserRequest"
    When Client posts $darkOrder to Spenser at "/MedicationRequest" $N times, paced manually
    When Client gets from Spenser at "/InventoryReport" as $after
    Then $response.status should be 200
    And extract "/inventoryListing/0/item/0/quantity/value" from $after as $Y
    And $Y should equal $X minus $N
