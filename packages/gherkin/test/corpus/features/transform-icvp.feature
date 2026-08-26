Feature: FHIR Validator transform operation
  Exercises the /itb/transform endpoint by applying the WHO ICVP→IPS
  StructureMap to a small ICVP claim payload and asserting that the
  resulting Bundle has the expected document shape and data.

  Background:
    Given Client is the system under test
    And FHIRValidator is infrastructure at "http://fhir-validator:8081"

  Scenario: transform-001 ICVP claim → IPS Bundle (real StructureMap)

    # ------------------------------------------------------------------
    # Step 1: Load the WHO ICVP IG so the StructureMap is in context
    # ------------------------------------------------------------------
    Given FHIRValidator is loaded with package "smart.who.int.icvp"

    # ------------------------------------------------------------------
    # Step 2: Stash a small ICVP claim payload as the source resource
    # ------------------------------------------------------------------
    Given define resource "icvpClaim" as:
      """
      {
        "dob": "1994-10-13",
        "gn":  "Parent/Antonio Rojas",
        "n":   "Cristina Rodriguez",
        "ndt": "NI",
        "nid": "126008-7",
        "ntl": "CHL",
        "s":   "male",
        "v": {
          "bo":  "A1234",
          "cn":  "Juan Castro",
          "dt":  "2020-11-15",
          "is":  "MINSALUD",
          "vle": "2025-11-15",
          "vls": "2020-11-15",
          "vp":  "YellowFeverProductd2c75a15ed309658b3968519ddb31690"
        }
      }
      """

    # ------------------------------------------------------------------
    # Step 3: Run the transform — produce the IPS Bundle
    # ------------------------------------------------------------------
    When transform "icvpClaim" using map "http://smart.who.int/icvp/StructureMap/ICVPClaimtoIPS" as "ipsBundle"

    # ------------------------------------------------------------------
    # Step 4: Assert the invariant parts of the resulting Bundle (UUIDs vary)
    #
    # Note: use FHIRPath's type-filter operators (`ofType` / `is`) — `resourceType`
    # is NOT a FHIR model property, only a JSON serialisation marker, so
    # `.where(resourceType = '...')` always returns empty.
    # ------------------------------------------------------------------
    Then assert FHIRPath "Bundle.type = 'document'" on "ipsBundle"
    And  assert FHIRPath "Bundle.entry.resource.ofType(Patient).name.text.first() = 'Cristina Rodriguez'" on "ipsBundle"
    And  assert FHIRPath "Bundle.entry.resource.ofType(Patient).gender = 'male'" on "ipsBundle"
    And  assert FHIRPath "Bundle.entry.resource.ofType(Patient).birthDate = '1994-10-13'" on "ipsBundle"
    And  assert FHIRPath "Bundle.entry.resource.ofType(Immunization).lotNumber = 'A1234'" on "ipsBundle"
    And  assert FHIRPath "Bundle.entry.resource.ofType(Immunization).vaccineCode.coding.code.first() = 'YellowFever'" on "ipsBundle"
    And  assert FHIRPath "Bundle.entry.resource.ofType(Composition).type.coding.code.first() = '60591-5'" on "ipsBundle"
