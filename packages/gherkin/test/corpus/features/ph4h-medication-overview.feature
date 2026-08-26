Feature: PH4H MedicationOverview — IHE MEOW conformance
  Exercises the WHO SMART PH4H transform-and-validate pipeline that produces
  an IHE Pharm MEOW-conformant Bundle. A compact QR payload
  (MedicationOverviewMin) is fed through the chained FML map
  MedicationOverviewMin → MedicationOverviewBundle (via the MEOW intermediate
  logical model MedicationOverviewLM), then the resulting Bundle is validated
  against the IHE Pharm MEOW MedicationOverview Bundle profile.

  Background:
    Given Client is the system under test
    # FHIRValidator is the GITB-compatible FHIR validator (validator_cli.jar)
    # that exposes /itb/{igManager,transform,loadResource,fhir}/process
    # endpoints. This is NOT a HAPI FHIR server — those don't accept the
    # GITB envelope. Point at whatever URL/port the validator (or its
    # cors-proxy) listens on in your deployment; the validator-workbench
    # setup uses 127.0.0.1:8090 (proxy → validator_cli on :8089).
    And FHIRValidator is infrastructure at "http://fhir-validator:8080"

  Scenario: tc-ph4h-001 Martha DeLarosa — Min → Bundle transform + MEOW conformance

    # ------------------------------------------------------------------
    # 1. Load the IHE Pharm MEOW package tarball (r4 branch build).
    #    Direct URL — no registry lookup, no local-cache prereq.
    # ------------------------------------------------------------------
    When Client loads IG "https://ihe.github.io/pharm-meow/branches/r4/package.tgz" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 2. Load the smart-ph4h IG (defines MedicationOverviewMin and the
    #    chained StructureMaps). Local build — same path the validator
    #    workbench uses.
    # ------------------------------------------------------------------
    When Client loads IG "E:/work/ImplementationGuides/smart-ph4h/output/package.tgz" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 3. Fetch the chained FML (Min → Bundle) directly from the smart-ph4h
    #    source repo, then parse it into a StructureMap resource.
    # ------------------------------------------------------------------
    When Client gets "https://raw.githubusercontent.com/WorldHealthOrganization/smart-ph4h/MeOW-r4/input/maps/MedicationOverviewMin-to-MedicationOverviewBundle.map" as "fmlText"
    When Client parses FML "fmlText" on FHIRValidator as "structureMap"
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 4. Register the parsed StructureMap on the validator so the
    #    transform step can resolve it by canonical URL.
    # ------------------------------------------------------------------
    When Client registers StructureMap "structureMap" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 5. Provide the input: Martha DeLarosa's MedicationOverviewMin
    #    (2 treatment lines — breast cancer + one open-ended). Matches the
    #    `medication-overview-min` sample in the validator workbench.
    # ------------------------------------------------------------------
    Given set "medMin" to:
      """
      {
        "resourceType": "MedicationOverviewMin",
        "n": "Martha DeLarosa",
        "dob": "1972-05-01",
        "s": "female",
        "id": "574687583",
        "m": [
          {
            "m": "L02BG03",
            "es": "2015-03-01",
            "da": "2015-03-15",
            "d": "1 tablet once daily",
            "r": "treatment for breast cancer"
          },
          {
            "m": "G02CX04",
            "es": "2016-01-01",
            "d": "as directed"
          }
        ]
      }
      """

    # ------------------------------------------------------------------
    # 6. Transform MedicationOverviewMin → MedicationOverview Bundle
    #    (chained through MedicationOverviewLM under the hood).
    # NOTE: verify the map canonical against the actual `map "..."` header
    # in the fetched FML — placeholder URL below.
    # ------------------------------------------------------------------
    When Client transforms "medMin" on FHIRValidator with map "http://smart.who.int/ph4h/StructureMap/MedicationOverviewMin-to-MedicationOverviewBundle" as "bundle"
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 7. Assert the produced Bundle conforms to the IHE Pharm MEOW
    #    MedicationOverview Bundle profile. If the map canonical or
    #    the profile canonical below differ from the actual IG values,
    #    substitute the real URLs (both are placeholders following the
    #    standard IHE ITI / WHO SMART naming conventions).
    # ------------------------------------------------------------------
    Then "bundle" conforms to "https://profiles.ihe.net/ITI/pharm/MEOW/StructureDefinition/IHE.PHARM.MEOW.MedicationOverviewBundle"
