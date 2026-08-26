Feature: Track 1: HCERT VHL — QR to Verified LAC IPS Bundle
  Semantic-equivalent Gherkin for the hand-written test-case-vhl.xml:
  QR upload → HC1 decode → metadata extract → COSE signature check (DEV) →
  SHL reference extract → SHL authorize (PIN) → FHIR fetch via manifest →
  LacPass IG install → HAPI $validate against the LAC IPS Bundle profile.

  Background:
    Given User is the system under test
    And HCertDecoder is infrastructure at "http://hcert-validator:8080"
    And VHLResponder is infrastructure at "http://hcert-validator:8080"
    And SmartHelper is infrastructure at "http://smart-helper:8000"
    And FHIRValidator is infrastructure at "http://fhir-validator:8080"

  # @continue-on-error → non-blocking <steps>: the DEV COSE signature can't
  # verify (the card's DSC isn't published in the WHO dev trustlist), so the
  # signature check shows red but the SHL → FHIR → conforms-to pipeline still
  # runs. The check still fails the test overall — it just doesn't abort it.
  @continue-on-error
  Scenario: tc-vhl-001 Full VHL verification pipeline

    # ------------------------------------------------------------------
    # 1) Collect user inputs: QR image upload + PIN prompt.
    #    (Interact/UPLOAD + Interact/TEXT — matches XML steps 0.1/0.2.)
    # ------------------------------------------------------------------
    When User uploads a QR image to HCertDecoder
    Given User enters a PIN
    And extract "/qr_data" as "rawQRData"

    # ------------------------------------------------------------------
    # 2) Decode HC1 → captures $coseVal, $payloadVal, $hcertVal, $coseRaw.
    #    Consolidates the XML's POST /decode/hcert + four JSON-pointer
    #    extractions into a single Gherkin step.
    # ------------------------------------------------------------------
    When User decodes HC1 on HCertDecoder

    # ------------------------------------------------------------------
    # 3) Extract metadata (informational — mirrors XML step 3).
    # ------------------------------------------------------------------
    When User extracts metadata on HCertDecoder

    # ------------------------------------------------------------------
    # 4) Verify COSE signature against GDHCN DEV trustlist
    #    (allow_unverified_trustlist=true — non-fatal path in XML,
    #    treated as a normal assertion here).
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
    # 5) Extract short-link reference → captures $shlinkUrl.
    # ------------------------------------------------------------------
    When User extracts SHL reference on HCertDecoder
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 6) Authorize the short link with the collected PIN → get manifest.
    # ------------------------------------------------------------------
    When User authorizes SHL on VHLResponder with url and pin
    Then "response status" should be "200"
    And extract "/manifest" as "manifestVal"

    # ------------------------------------------------------------------
    # 7) Fetch the FHIR payload described by the manifest → take the
    #    first resource (matches XML's /fhir/0/resource extraction).
    # ------------------------------------------------------------------
    When User fetches FHIR from VHLResponder with manifest
    Then "response status" should be "200"
    And extract "/fhir/0/resource" as "firstResource"

    # ------------------------------------------------------------------
    # 8) Ensure the LacPass IG is loaded on the FHIR server via
    #    SmartHelper (target=fhir — same call as XML step "Upload IG").
    # ------------------------------------------------------------------
    When User loads IG "https://ig.racsel.org" on FHIRValidator
    Then "response status" should be "200"

    # ------------------------------------------------------------------
    # 9) Validate the Bundle against the LAC IPS Bundle profile
    # ------------------------------------------------------------------
    Then "firstResource" conforms to "http://racsel.org/StructureDefinition/LACBundleIPS" downgrading slicing errors
