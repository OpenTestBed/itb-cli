# EIRA alignment of an ArchiMate model — the first feature written against a
# dialect that is not about FHIR at all.
#
# Every line below is a core sentence shape. The archimate dialect only says
# what "loads model", `at "<query>"` and "should conform to" mean for an
# ArchiMate model; the core language did not change to make this possible.
#
# The service behind ModelRepo / EiraValidator is specified in
# components/archimate/component.yml and does not exist yet: this feature is
# the acceptance test for both the dialect contract and that service.
@lang:itb-core-en@^2 @dialect:archimate@^1
Feature: EIRA alignment of the national eHealth exchange architecture
  The solution architecture for cross-border patient summary exchange must
  align with the European Interoperability Reference Architecture (EIRA):
  every building block is typed, the interoperability layers are all present,
  and the application services realise the digital public service they support.

  Background:
    Given Architect is the system under test
    And ModelRepo is an archimate-repository at "http://archi:8080"
    And EiraValidator is an eira-validator at "http://eira:8080"
    When Architect loads model "ehealth-exchange" from ModelRepo as $model

  Scenario: eira-001 the model is EIRA-conformant
    Then $model should conform to "https://eira.ec.europa.eu/eira/6.0" with:
      | option | value                 |
      | view   | Solution Architecture |

  Scenario: eira-002 every interoperability layer is represented
    Then $model at "views[name='Legal view'].elements.count()" should be at least 1
    And $model at "views[name='Organisational view'].elements.count()" should be at least 1
    And $model at "views[name='Semantic view'].elements.count()" should be at least 1
    And $model at "views[name='Technical view'].elements.count()" should be at least 1

  Scenario: eira-003 the patient summary service is a typed digital public service
    Then $model at "elements[type='ApplicationService'].count()" should be at least 1
    And $model at "elements[name='Patient Summary Service'].specialization" should be "eira:DigitalPublicService"
    And $model at "elements[name='Patient Summary Service'].properties['eira:ABB']" should not be empty

  Scenario: eira-004 every application interface realises a service
    Then $model at "elements[type='ApplicationInterface'][!relations(Realization).target(ApplicationService)].count()" should be 0

  Scenario: eira-005 the legal basis is traceable to the technical layer
    Then $model at "elements[type='Constraint'][specialization='eira:LegalRequirement'].count()" should be at least 1
    And $model at "elements[type='Constraint'][specialization='eira:LegalRequirement'].relations(Influence).count()" should be at least 1
