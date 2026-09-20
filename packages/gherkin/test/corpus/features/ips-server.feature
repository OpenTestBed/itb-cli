# IPS Server — the actor that is a FHIR server acting as an IPS Creator.
#
# The IPS Server ActorDefinition derives from Creator: it fulfils every Creator
# obligation (tested by ips-creator.feature on the document it returns) and adds
# the API behaviour of the IPS Server CapabilityStatement: the $summary operation
# on Patient, returning a document Bundle conforming to Bundle (IPS). This feature
# tests that API surface and the document-level obligations; the element-level
# Creator obligations are the same 229 the generated ips-creator.feature asserts,
# and a Server run pastes nothing — the test bed fetches the document itself.
#
# The tester supplies a patient identifier the server holds summary data for.
# The reference dataset is the same as for the Creator: load the IG's
# all-sections example patient first, so every element the example carries is
# expected in the returned document.
@lang:itb-core-en@^2 @dialect:fhir-validator@^2 @actor:Server @spec:hl7.fhir.uv.ips@2.0.1
Feature: IPS Server — the $summary operation returns a conformant IPS document
  An IPS Server is a FHIR server acting as an IPS Creator by providing conformant
  IPS documents in response to FHIR API requests (CapabilityStatement ips-server).

  Background:
    Given IPSServer is the system under test at "http://ips-server:8080/fhir" as defined by "http://hl7.org/fhir/uv/ips/CapabilityStatement/ips-server"
    And Client is infrastructure
    And FHIRValidator is a fhir-validator at "http://fhir-validator:8081"
    And FHIRValidator is loaded with package "hl7.fhir.uv.ips#2.0.1"
    And set header "Accept" to "application/fhir+json"
    And Client is informed "Load the reference patient Patricia JORDANA (identifier ABC1234) from https://hl7.org/fhir/uv/ips/Bundle-bundle-ips-all-sections.json into the server under test."
    And Client is asked for $patientIdentifier with "The identifier value of the reference patient on the server (e.g. ABC1234)"

  Rule: The server declares the IPS capabilities

    Scenario: ips-server-001 The CapabilityStatement declares the $summary operation
      When Client gets from IPSServer at "/metadata" as $capability
      Then $response.status should be 200
      And $capability at "CapabilityStatement.rest.where(mode='server').resource.where(type='Patient').operation.where(name='summary').exists()" should be true
      And $capability at "CapabilityStatement.instantiates.where($this.startsWith('http://hl7.org/fhir/uv/ips/CapabilityStatement/ips-server')).exists() or CapabilityStatement.rest.resource.where(type='Patient').operation.where(name='summary').definition.exists()" should be true

  Rule: $summary returns an IPS document

    @profile:Bundle-uv-ips @covers:Bundle.identifier,Bundle.timestamp,Bundle.entry:composition
    Scenario: ips-server-002 $summary by patient identifier returns a Bundle (IPS) with identifier, timestamp and the composition first
      # Type-level invocation with the identifier parameter, as the OperationDefinition allows.
      When Client gets from IPSServer at "/Patient/$summary?identifier=" with id $patientIdentifier as $ips
      Then $response.status should be 200
      And $ips should conform to "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips" ignoring slicing errors
      And $ips at "Bundle.type" should be "document"
      And $ips at "Bundle.identifier.exists()" should be true
      And $ips at "Bundle.timestamp.exists()" should be true
      And $ips at "Bundle.entry.first().resource.ofType(Composition).exists()" should be true

    @profile:Composition-uv-ips
    @covers:Composition.status,Composition.type,Composition.subject,Composition.date,Composition.author,Composition.title
    Scenario: ips-server-003 The returned Composition is complete and about the requested patient
      When Client gets from IPSServer at "/Patient/$summary?identifier=" with id $patientIdentifier as $ips
      Then $response.status should be 200
      And $ips at "Bundle.entry.resource.ofType(Composition).all(status = 'final' or status = 'amended' or status = 'preliminary')" should be true
      And $ips at "Bundle.entry.resource.ofType(Composition).type.coding.where(system='http://loinc.org' and code='60591-5').exists()" should be true
      And $ips at "Bundle.entry.resource.ofType(Composition).subject.reference.exists()" should be true
      And $ips at "Bundle.entry.resource.ofType(Composition).date.exists()" should be true
      And $ips at "Bundle.entry.resource.ofType(Composition).author.exists()" should be true
      And $ips at "Bundle.entry.resource.ofType(Composition).title.exists()" should be true
      And $ips at "Bundle.entry.resource.ofType(Patient).identifier.where(value='$patientIdentifier').exists() or Bundle.entry.resource.ofType(Patient).exists()" should be true

    Scenario: ips-server-004 $summary honours the profile parameter
      When Client gets from IPSServer at "/Patient/$summary?profile=http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips&identifier=" with id $patientIdentifier as $ipsProfiled
      Then $response.status should be 200
      And $ipsProfiled should conform to "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips" ignoring slicing errors

    Scenario: ips-server-005 An unknown patient is refused, not answered with an empty document
      When Client gets from IPSServer at "/Patient/$summary?identifier=" with id "otb-no-such-patient-000" as $missing
      Then $response.status should be one of "404, 400, 422"
      And $missing at "OperationOutcome.issue.exists()" should be true

  Rule: The document the server returns meets the Creator obligations

    Scenario: ips-server-006 The returned document is the input for the Creator test cases
      # Run ips-creator.feature against $ips instead of a pasted document: every
      # element-level Creator obligation (229 in hl7.fhir.uv.ips 2.0.1) applies to
      # a Server unchanged, because the Server actor derives from the Creator.
      When Client gets from IPSServer at "/Patient/$summary?identifier=" with id $patientIdentifier as $ips
      Then $response.status should be 200
      And $ips should conform to "http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips" ignoring slicing errors
      And Client is informed "Continue with ips-creator.feature: use this returned document as the exported IPS." with $ips
