Feature: Track: 1HCERT VHL - QR to Verified LAC IPS Bundle
  QR upload -> HC1 decode -> metadata extract -> COSE signature check (DEV) ->
  SHL reference extract -> SHL authorize (PIN) -> FHIR fetch via manifest ->
  LacPass IG load -> validation against the LAC IPS Bundle profile.
  Uses the FHIR validator for IG load and validation (same approach as the PH4H
  MEOW and ICVP features) - no matchbox / smart-helper / fhir-server needed.

  Background:
    Given User is the system under test
    And HCertDecoder is a hcert-decoder at "http://hcert-validator:8080"
    And VHLResponder is a hcert-decoder at "http://hcert-validator:8080"
    # GITB-compatible FHIR validator (validator_cli.jar) — /itb/{igManager,fhir}/process.
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8080"

  Scenario: tc-vhl-001 Full VHL verification pipeline

    # ------------------------------------------------------------------
    # 1) Collect user inputs: QR image upload + PIN prompt.
    # ------------------------------------------------------------------
    When User uploads a file as $qrImage
    And User scans $qrImage on HCertDecoder as $qrData
    Given User is asked for $pin with "Enter the PIN for retrieving the content"

    # ------------------------------------------------------------------
    # 2) Decode HC1 -> captures COSE / payload / hcert.
    # ------------------------------------------------------------------
    When User decodes $qrData on HCertDecoder as $hcert

    # ------------------------------------------------------------------
    # 3) Verify COSE signature against the GDHCN DEV trustlist
    #    (allow_unverified_trustlist=true -> dev trustlist proof warning
    #    is non-fatal).
    #    IMPORTANT: this MUST come immediately after "decodes HC1". The verify
    #    step reads cose._raw from the *last* HTTP response, so any other HTTP
    #    step in between (e.g. "extracts metadata") would overwrite it and the
    #    signature request would go out with an empty cose_raw.
    # ------------------------------------------------------------------
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

    # ------------------------------------------------------------------
    # 4) Extract metadata (informational) — AFTER verify so it doesn't clobber
    #    the decode response the verify step reads cose._raw from.
    # ------------------------------------------------------------------
    When User extracts metadata from $hcert on HCertDecoder as $metadata

    # ------------------------------------------------------------------
    # 5) Extract short-link (SHL) reference.
    # ------------------------------------------------------------------
    When User extracts the SHL link from $hcert on HCertDecoder as $shlLink

    # ------------------------------------------------------------------
    # 6) Authorize the short link with the collected PIN -> manifest.
    # ------------------------------------------------------------------
    When User authorizes $shlLink on VHLResponder with pin $pin as $manifest

    # ------------------------------------------------------------------
    # 7) Fetch the FHIR payload described by the manifest -> first resource.
    # ------------------------------------------------------------------
    When User fetches the FHIR content of $manifest on VHLResponder as $firstResource

    # ------------------------------------------------------------------
    # 8) Load the LacPass IG into the validator (was: smart-helper loadIG
    #    target="fhir" -> fhir-server). Use the direct package.tgz URL:
    #    the canonical https://lacpass.racsel.org only 301-redirects (to
    #    https://ig.racsel.org/), which loadIG can't resolve — the package
    #    itself is served straight (200) at https://ig.racsel.org/package.tgz.
    # ------------------------------------------------------------------
    When User loads IG "https://ig.racsel.org/package.tgz" on FHIRValidator

    # ------------------------------------------------------------------
    # 9) Validate the fetched Bundle against the LAC IPS Bundle profile
    #    via the validator (was: fhir-server HAPI $validate via smart-helper).
    # ------------------------------------------------------------------
    # Profile canonical is http://racsel.org/StructureDefinition/... (NOT lacpass.racsel.org),
    # and the LAC IPS bundle profile is LACBundleIPS — there is no "lac-bundle".
    Then $firstResource should conform to "http://racsel.org/StructureDefinition/LACBundleIPS"
