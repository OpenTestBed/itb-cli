@lang:itb-core-en@^2 @dialect:json-policy@^0.1 @dialect:battery-passport@^0.1
Feature: A JSON document against a versioned policy, outside healthcare

  The fixture for the language features the battery passport trial needed:
  a dialect that builds on another (battery-passport requires json-policy),
  a conformance handler that reports a fingerprint, an option whose value is
  a bound variable, and the negative conformance form with options.

  Background:
    Given Publisher is the system under test at "http://publisher.example/data"
    And Tester is infrastructure
    And Policies is a policy-validator at "http://policies.example"

  Scenario: an option takes a bound variable, and the fingerprint is logged
    Given set $asOf to "2027-08-18"
    When Tester gets from Publisher at "/passport-pass.json" as $passport
    Then $passport should conform to "https://otb.example/policy/battery-passport/due-diligence|1.0.0" on Policies with:
      | option | value |
      | asOf   | $asOf |
    And $validation.fingerprint should match "due-diligence.1.0.0#sha256:"

  Scenario: the negative form takes options too
    When Tester gets from Publisher at "/passport-fail.json" as $passport
    Then $passport should not conform to "https://otb.example/policy/battery-passport/due-diligence|1.0.0" on Policies with:
      | option | value      |
      | asOf   | 2027-08-18 |

  Scenario: an option that names no bound variable stays text
    When Tester gets from Publisher at "/passport-pass.json" as $passport
    Then $passport should conform to "https://otb.example/policy/battery-passport/access|1.0.0" on Policies with:
      | option     | value              |
      | asOf       | $notBound          |
      | parameters | accessLevel=public |
