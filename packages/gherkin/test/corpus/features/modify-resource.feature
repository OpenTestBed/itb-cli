Feature: FHIR Validator modify operation
  Exercises the /itb/testdata modify operation: takes an existing resource
  and applies set / add / remove operations to it, optionally re-validating
  the modified resource against a profile.

  Background:
    Given Client is the system under test
    And FHIRValidator is infrastructure at "http://fhir-validator:8081"

  Scenario: modify-resource Exercise set, add, remove and enforced modification

    # ------------------------------------------------------------------
    # Step 1: SET a primitive on an existing resource (no enforcement)
    # ------------------------------------------------------------------
    Given generate required test data as "patient" from profile "http://hl7.org/fhir/StructureDefinition/Patient" with values:
      | path       | value           |
      | Patient.id | modify-base-001 |

    When modify "patient" with operations:
      | op  | path       | value           |
      | set | Patient.id | modify-after-01 |

    Then assert FHIRPath "Patient.id = 'modify-after-01'" on "patient"

    # ------------------------------------------------------------------
    # Step 2: ADD a coding to a list, then REMOVE the original (index 0)
    # ------------------------------------------------------------------
    Given generate required test data as "allergy" from profile "http://hl7.org/fhir/StructureDefinition/AllergyIntolerance" with values:
      | path                                     | system                                                            | code   |
      | AllergyIntolerance.clinicalStatus.coding | http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical | active |

    When modify "allergy" with operations:
      | op     | path                                         | system                | code   |
      | add    | AllergyIntolerance.clinicalStatus.coding     | http://example.org/cs | extra  |
      | remove | AllergyIntolerance.clinicalStatus.coding[0]  |                       |        |

    Then assert FHIRPath "AllergyIntolerance.clinicalStatus.coding.count() = 1" on "allergy"
    And assert FHIRPath "AllergyIntolerance.clinicalStatus.coding.first().code = 'extra'" on "allergy"

    # ------------------------------------------------------------------
    # Step 3: SET against profile (enforce=true) — must produce zero errors
    # ------------------------------------------------------------------
    Given generate required test data as "patient2" from profile "http://hl7.org/fhir/StructureDefinition/Patient" with values:
      | path       | value            |
      | Patient.id | modify-prof-base |

    When modify "patient2" against profile "http://hl7.org/fhir/StructureDefinition/Patient" with operations:
      | op  | path           | value  |
      | set | Patient.gender | female |

    Then assert FHIRPath "Patient.gender = 'female'" on "patient2"
