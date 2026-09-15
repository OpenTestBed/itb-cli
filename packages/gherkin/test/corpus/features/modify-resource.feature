Feature: FHIR Validator modify operation
  Exercises the /itb/testdata modify operation: takes an existing resource
  and applies set / add / remove operations to it, optionally re-validating
  the modified resource against a profile.

  Background:
    Given Client is the system under test
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"

  Scenario: modify-resource Exercise set, add, remove and enforced modification

    # ------------------------------------------------------------------
    # Step 1: SET a primitive on an existing resource (no enforcement)
    # ------------------------------------------------------------------
    Given Client generates required test data from "http://hl7.org/fhir/StructureDefinition/Patient" as $patient with values:
      | path       | value           |
      | Patient.id | modify-base-001 |

    When Client modifies $patient with operations:
      | op  | path       | value           |
      | set | Patient.id | modify-after-01 |

    Then $patient should satisfy "Patient.id = 'modify-after-01'"

    # ------------------------------------------------------------------
    # Step 2: ADD a coding to a list, then REMOVE the original (index 0)
    # ------------------------------------------------------------------
    Given Client generates required test data from "http://hl7.org/fhir/StructureDefinition/AllergyIntolerance" as $allergy with values:
      | path                                     | system                                                            | code   |
      | AllergyIntolerance.clinicalStatus.coding | http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical | active |

    When Client modifies $allergy with operations:
      | op     | path                                         | system                | code   |
      | add    | AllergyIntolerance.clinicalStatus.coding     | http://example.org/cs | extra  |
      | remove | AllergyIntolerance.clinicalStatus.coding[0]  |                       |        |

    Then $allergy should satisfy "AllergyIntolerance.clinicalStatus.coding.count() = 1"
    And $allergy should satisfy "AllergyIntolerance.clinicalStatus.coding.first().code = 'extra'"

    # ------------------------------------------------------------------
    # Step 3: SET against profile (enforce=true) — must produce zero errors
    # ------------------------------------------------------------------
    Given Client generates required test data from "http://hl7.org/fhir/StructureDefinition/Patient" as $patient2 with values:
      | path       | value            |
      | Patient.id | modify-prof-base |

    When Client modifies $patient2 against "http://hl7.org/fhir/StructureDefinition/Patient" with operations:
      | op  | path           | value  |
      | set | Patient.gender | female |

    Then $patient2 should satisfy "Patient.gender = 'female'"
