# Corpus feature for specVersion 2.1.0.
#
# Two things that were impossible before, and one that must not have changed:
#
#   1. A Content-Type set by the author survives the POST verb. Previously every
#      POST/PUT/PATCH assigned application/json INSIDE the verb, so this line
#      was silently discarded and the request went out mislabelled — it compiled
#      clean while sending form encoding declared as JSON.
#   2. A reply can carry a header, so a simulated 401 can send the
#      WWW-Authenticate challenge RFC 6750 requires.
#   3. A verb with no header set by the author still defaults to JSON. That is
#      the backwards-compatibility case and the snapshots prove it.
@lang:itb-core-en@^2
Feature: Header defaults do not override the author
  The HTTP and reply verbs default Content-Type when nothing has set it, and
  leave it alone when something has.

  Background:
    Given Server is the system under test at "https://api.example.org"
    And Client is infrastructure

  Scenario: an author-set content type survives the POST verb
    Given set header "Content-Type" to "application/x-www-form-urlencoded"
    And set header "Accept" to "application/json"
    When Client posts to Server at "/token" with:
      """
      grant_type=client_credentials&scope=read
      """
    Then $response.status should be 200

  Scenario: nothing set, so the verb's JSON default applies
    When Client posts to Server at "/Patient" with:
      """
      {"resourceType":"Patient"}
      """
    Then $response.status should be 201

  Scenario: a reply carries the challenge a refusal needs
    Given Server is listening for Client
    And set reply header "WWW-Authenticate" to "Bearer realm=example"
    When Server receives a request from Client within 60 seconds
    Then $received.method should be "GET"
    And Server replies to Client with status 401 and:
      """
      {"resourceType":"OperationOutcome"}
      """
    And Server stops listening for Client

  Scenario: a reply content type set by the author survives too
    Given Server is listening for Client
    And set reply header "Content-Type" to "application/fhir+json"
    When Server receives a request from Client within 60 seconds
    And Server replies to Client with status 200 and:
      """
      {"resourceType":"Bundle"}
      """
    And Server stops listening for Client
