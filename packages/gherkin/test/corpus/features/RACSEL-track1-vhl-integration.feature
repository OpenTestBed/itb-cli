Feature: Track 1: HCERT VHL — QR to Verified LAC IPS Bundle
  Semantic-equivalent Gherkin for the hand-written test-case-vhl.xml:
  QR upload → HC1 decode → metadata extract → COSE signature check (DEV) →
  SHL reference extract → SHL authorize (PIN) → FHIR fetch via manifest →
  LacPass IG install → HAPI $validate against the LAC IPS Bundle profile.

  Background:
    Given User is the system under test
    And HCertDecoder is a hcert-decoder at "http://hcert-validator:8080"
    And VHLResponder is a hcert-decoder at "http://hcert-validator:8080"
    And SmartHelper is a smart-helper at "http://smart-helper:8000"
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8080"

  @continue-on-error
  Scenario: tc-vhl-001 Full VHL verification pipeline

    # 1) Collect user inputs: QR image upload + PIN prompt.
    When User uploads a file as $qrImage
    And User scans $qrImage on HCertDecoder as $qrData
    Given User is asked for $pin with "Enter the PIN for retrieving the content"

    # 2) Decode HC1 → captures $coseVal, $payloadVal, $hcertVal, $coseRaw.
    When User decodes $qrData on HCertDecoder as $hcert

    # 3) Extract metadata (informational — mirrors XML step 3).
    When User extracts metadata from $hcert on HCertDecoder as $metadata

    # 4) Verify COSE signature against GDHCN DEV trustlist
    When User verifies the signature of $hcert on HCertDecoder with:
      | parameter                  | value    |
      | use_gdhcn                  | true     |
      | gdhcn_env                  | dev      |
      | participant                | -        |
      | usage                      | DSC      |
      | verify_did_proof           | true     |
      | allow_unverified_trustlist | true     |
      | allow_remote_contexts      | true     |
      | context_dir                | contexts |

    # 5) Extract short-link reference → captures $shlinkUrl.
    When User extracts the SHL link from $hcert on HCertDecoder as $shlLink

    # 6) Authorize the short link with the collected PIN → get manifest.
    When User authorizes $shlLink on VHLResponder with pin $pin as $manifest

    # 7) Fetch the FHIR payload described by the manifest → take the
    When User fetches the FHIR content of $manifest on VHLResponder as $firstResource

    # 8) Ensure the LacPass IG is loaded on the FHIR server via
    When User loads IG "https://ig.racsel.org" on FHIRValidator

    # 9) Validate the Bundle against the LAC IPS Bundle profile
    Then $firstResource should conform to "http://racsel.org/StructureDefinition/LACBundleIPS" ignoring slicing errors
