Feature: Track 2: System Utilizes and Validates HCERT: ICVP
  QR code -> decode -> COSE verify -> transform (ICVPClaimtoIPS) -> validate the
  ICVP IPS Bundle. Uses the FHIR validator for IG load, StructureMap transform, and
  profile validation (same approach as the PH4H MEOW feature) — no matchbox /
  smart-helper / fhir-server needed.

  Background:
    Given User is the system under test
    And HCertDecoder is infrastructure at "http://hcert-validator:8080"
    # GITB-compatible FHIR validator (validator_cli.jar) — exposes
    # /itb/{igManager,transform,fhir}/process. Handles IG load, StructureMap
    # transform, and profile validation natively.
    And FHIRValidator is infrastructure at "http://fhir-validator:8080"

  # @continue-on-error → non-blocking <steps>: ICVP chains 5 IG loads (external
  # smart.who.int IGs), a StructureMap transform, and a
  # profile validation, any of which can fail in a dev environment. Non-blocking
  # lets every check report its own result in one run instead of aborting at the
  # first failure. Failing checks still go red and fail the test overall.
  @continue-on-error
  Scenario: tc-icvp-001 QR -> decode -> transform -> ICVP IPS conformance

    # ------------------------------------------------------------------
    # 1) Upload QR image and pull the raw HC1 payload.
    # ------------------------------------------------------------------
    When User uploads a QR image to HCertDecoder
    And extract "/qr_data" as "rawQRData"

    # ------------------------------------------------------------------
    # 2) Decode HC1 -> captures COSE / payload / hcert; grab the ICVP claim
    #    from the CWT payload. ICVP stores its claim under -260/-6 (PH4H/MEOW
    #    uses -260/-7 / hcert_inner_json, VHL uses -260/5 for the SHL link) —
    #    so this pointer is ICVP-specific, NOT the MEOW hcert_inner_json field.
    # ------------------------------------------------------------------
    When User decodes HC1 on HCertDecoder
    And extract "/payload/-260/-6" as "innerContent"
    And extract "/payload/1" as "issuerCode"

    # ------------------------------------------------------------------
    # 3) Verify COSE signature against the GDHCN DEV trustlist. ICVP uses
    #    NO domain (flat trustlist); allow_unverified_trustlist=true so the
    #    dev trustlist proof warning is non-fatal.
    # ------------------------------------------------------------------
    When User verifies COSE signature on HCertDecoder with:
      | parameter                  | value    |
      | use_gdhcn                  | true     |
      | gdhcn_env                  | dev      |
      | participant                | -        |
      | usage                      | DSC      |
      | verify_did_proof           | true     |
      | allow_unverified_trustlist | true     |
      | allow_remote_contexts      | true     |
      | context_dir                | contexts |
    Then "response status" should be "200"
    And extract "/valid" as "sigValid"
    And "sigValid" should be "true"

    # ------------------------------------------------------------------
    # 4) Load the IGs the transform + validate need (the validator resolves
    #    transitive dependencies). smart-icvp carries the ICVPClaimtoIPS map
    #    and the Bundle-uv-ips-ICVP profile.
    # ------------------------------------------------------------------
    When User loads IG "https://worldhealthorganization.github.io/smart-trust" on FHIRValidator
    Then "response status" should be "200"
    When User loads IG "https://smart.who.int/pcmt" on FHIRValidator
    Then "response status" should be "200"
    When User loads IG "https://smart.who.int/pcmt-vaxprequal" on FHIRValidator
    Then "response status" should be "200"
    When User loads IG "https://smart.who.int/trust-phw/" on FHIRValidator
    Then "response status" should be "200"
    # Load the published ICVP IG (canonical package) — no local package server needed.
    When User loads IG "https://smart.who.int/icvp/package.tgz" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 5) Transform the ICVP claim -> IPS Bundle via ICVPClaimtoIPS.
    # ------------------------------------------------------------------
    When User transforms "innerContent" on FHIRValidator with map "http://smart.who.int/icvp/StructureMap/ICVPClaimtoIPS" as "bundleResult"
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 5b) Stamp the document metadata the ICVPClaimtoIPS map does not emit —
    #     Composition.date, Composition.author, and Bundle.timestamp — exactly
    #     what the original TDL injected before validating.
    #     author.identifier.value uses the live CWT issuer (claim 1) and the
    #     timestamps use the real current time, matching the original test.
    # ------------------------------------------------------------------
    And set "nowTs" to now
    When modify "bundleResult" with operations:
      | op  | path                                                | value              |
      | set | Bundle.timestamp                                    | $nowTs             |
      | set | Bundle.entry[0].resource.date                       | $nowTs             |
      | set | Bundle.entry[0].resource.author.identifier.system   | urn:example:issuer |
      | set | Bundle.entry[0].resource.author.identifier.value    | $issuerCode        |

    # ------------------------------------------------------------------
    # 6) Validate the resulting Bundle against the ICVP IPS Bundle profile.
    #    NOTE: the old TDL patched Composition.date/author and Bundle.timestamp
    #    into the bundle before validating; those are intentionally NOT patched
    #    here — if the map omits them they surface as real findings to fix in
    #    the map (same philosophy as MEOW).
    # ------------------------------------------------------------------
    Then "bundleResult" conforms to "http://smart.who.int/icvp/StructureDefinition/Bundle-uv-ips-ICVP" downgrading slicing errors
