# RFC: six gaps in the core language

Written against `specVersion: 2.0.0`. Each item gives the sentence as an author
writes it, the `text:` entry, and what it could shadow — the Proposal shape
`GOVERNANCE.md` §3 asks for. Nothing here is implemented yet.

**Where these came from.** Authoring the IHE IUA suite (28 cases, three actors)
and reading the HCERT track features. Each gap is one I hit, not a wishlist.
A survey of every feature in `app/public/features/` found exactly one mention of
`call scriptlet`, and only in a comment — so the language leaks less than
expected, and the leak is item 1.

---

## 1. A value cannot be composed — the dominant gap

`{value}` matches a literal, a `$variable`, a number or a boolean. There is no
concatenation, so a value cannot be built from a run-time one. `{string}`
compiles to a TDL literal, and **TDL literals do not interpolate**.

`en.yml` documents this caveat twice, and `meow-server.feature` documents the
workaround — *"a find-and-replace on the id, or reach for `call scriptlet` with
an inline body if you need a genuinely dynamic path"*. That comment is the
clearest statement of the gap in the repository.

What it blocks today:

```gherkin
# a dynamic path — impossible
When Consumer gets from Server at "/Patient/{$id}/$everything" as $bundle

# a form body from a pasted code — impossible, hence the oauth dialect
Given set $body to "grant_type=authorization_code&code={$code}"
```

### Proposal: interpolating templates

A new placeholder `{template}`: a quoted string in which `{$name}` is a variable
reference. The generator splits on those and emits `concat()`.

```
set $body to the text "grant_type=authorization_code&code={$code}"
  → <assign to="body">concat("grant_type=authorization_code&code=", $code)
```

Add `{template}` variants only where the need is proven:

| | |
|---|---|
| `set {var} to the text {template}` | general composition |
| `{actor} gets from {actor} at {template} as {var}` | the dynamic path |

**Why a new placeholder rather than making `{string}` interpolate.** It would be
backwards compatible at the author's level — no existing path contains `{$` — but
the action templates quote the slot (`uri: 'concat($$2Base, "$3", $4)'`). An
interpolating slot has to emit unquoted `concat(...)`, so every template that
wraps a slot in quotes would have to change with it. That is a substitution-layer
change and the substitution layer is the riskiest code in the compiler: it is
where `\Z` once silently dropped every scriptlet. A separate type confines the
blast radius to entries that opt in.

**Shadowing:** none. `to the text` and the `at {template}` form are new.

**Cost:** a `PARAM_RE` entry, a branch in `subst`, two entries, corpus feature.
Medium — this is the one with real design risk.

---

## 2. No unattended file input

Parked pending a TDL question. See `docs/` in the authoring repo.

`uploads a file as $x` always emits `<interact>` with `inputType: UPLOAD`, so it
needs a human. `gets "<url>" as $x` fetches unattended but needs the fixture
hosted and reachable **from the test bed**, sets `Accept: application/json` for
what may be a PNG, and leaves the fixture unversioned relative to the suite that
tested against it.

What is missing is a fixture that travels *with* the archive:

```gherkin
When User loads the file "vectors/track1.png" as $qrImage
```

Two parts: the verb, and a fourth emitted file type (`data`) that the generator
writes and the zip carries — today it emits only `testsuite`, `testcase` and
`scriptlet`.

**Open question, and the whole item rests on it:** can TDL reference a resource
inside the deployed suite archive? Scriptlets are reached with
`<call path="…">`, so archive-relative resolution exists for *them*. Whether a
data file can be read the same way is unverified. Settle that before designing
the verb.

---

## 3. HTTP verbs clobber headers the author set

`set header "Content-Type" to "application/x-www-form-urlencoded"` has no effect:
every POST/PUT/PATCH verb assigns `jsonHeaders{Content-Type}` **inside the
verb**, so the verb's assignment runs last and wins. The author's line is
silently discarded.

This is the gap that **compiled clean while sending form-encoded bodies labelled
`application/json`** — the worst failure of the IUA work, and the reason the
`oauth` dialect exists.

### Proposal: make the default a default

The core already uses the construct, at `en.yml:521`:

```yaml
value: 'if (empty($lastRequest{response}{status})) then "0" else $lastRequest{response}{status}'
```

Apply it to every hardcoded header:

```yaml
# before
- assign: { to: 'jsonHeaders{Content-Type}', value: '"application/json"' }
# after
- assign:
    to: 'jsonHeaders{Content-Type}'
    value: 'if (empty($jsonHeaders{Content-Type})) then "application/json" else $jsonHeaders{Content-Type}'
```

**Non-breaking.** An author who sets nothing still gets JSON. An author who set a
Content-Type now keeps it.

**Shadowing:** none — no new sentence. Every snapshot containing a header assign
moves, which is the point and must be read.

**Cost:** small, and it removes most of the `oauth` dialect's justification.

---

## 4. Replies cannot set headers

`replies to … with status {int} and:` sets status and body only. A simulated 401
cannot carry `WWW-Authenticate`, so IUA's AC-04 tests a client's reaction to a
refusal *without the challenge a real server would send* — the test is weaker
than the requirement it covers, and the feature says so in a comment.

### Proposal

One sentence, plus item 3's fix applied to the two reply verbs, which clobber
`replyHeaders{Content-Type}` the same way:

```gherkin
Given set reply header "WWW-Authenticate" to "Bearer realm=\"example\""
And ResourceServer replies to Client with status 401 and:
```

```yaml
- text: 'set reply header {string} to {value}'
  doc: Set a header on every following reply (literal or $variable).
  actions:
    - assign: { to: 'replyHeaders{$1}', value: '$2' }
```

The `replyHeaders` map already exists, so there is nothing to wire.

**Shadowing:** `set header {string} to {value}` is a different sentence; the two
cannot be confused by the matcher, but a reviewer should check the author cannot
confuse them either. "reply" first reads correctly.

**Cost:** small. Do it with item 3 — same defect, same patch.

---

## 5. No arithmetic, and no clock comparison

`set {var} to now` and `set {var} to now with format {string}` exist, but nothing
compares two times, and there is no arithmetic. IUA's AS-04 — *"`exp` is in the
future"* — had to become an operator attestation because `exp` is epoch seconds
and the language cannot compare it with anything.

**Feasible in part.** TDL offers `number()`, which the core already uses, so
`{ref} should be greater than {value}` on numbers is available. What is missing
is **a clock in the same unit**: `now with format` goes through
`TokenGenerator/timestamp`, which takes a date pattern, and no pattern yields
epoch seconds.

**Proposal: establish the clock first.** Either a `TokenGenerator` format that
produces epoch seconds, or a comparison that parses a NumericDate. Until one
exists, there is nothing to propose — and an attestation is the honest
alternative, not a workaround. **Verify before designing.**

---

## 6. No scenario-level iteration

The action layer has `foreach`, so a step given a data table can iterate its
rows, and eight core sentences use tables. What is absent is Gherkin's
`Scenario Outline` / `Examples` — running one scenario once per row.

The cost shows in the IUA suite: AS-01, AS-03 and AS-04 repeat the same
client-credentials request because there is no way to say "this scenario, for
each of these grants".

**This is a parser change, not a language entry** — bigger than items 3 and 4,
and independent of them. Worth its own RFC. Note it changes test case
*identity*: one outline with four rows is four test cases in ITB, and their ids
have to be stable and meaningful.

---

## 7. No encoding primitives

No base64, no URL-encoding. Two consequences already in the tree:

- the `jwt` dialect decodes tokens by borrowing the FHIR validator's FHIRPath and
  calling `decode('urlbase64')` — an HL7 Java implementation detail that is in
  neither the FHIRPath specification nor FHIR R5's added-functions list, and
  `component.yml` says so;
- the `oauth` dialect's form bodies are **not URL-encoded**, a documented
  limitation rather than a solved problem.

TDL's function set as used by the core is `concat`, `empty`, `not`, `number`,
`string-length`, `translate`. `translate()` maps characters and cannot do base64.

**Probably not a language change.** If TDL has no encoder, a sentence cannot be
written over it; the answer is a small processing service, which is what the
`jwt` dialect's own notes conclude. **Confirm the TDL function set from the
schema rather than from the core's usage** before closing this.

---

## Suggested order

| | Item | Size | Why first |
|---|---|---|---|
| 1 | **3 + 4** together | small | One defect in two places, construct already proven, non-breaking, removes most of a dialect |
| 2 | **1** | medium | The dominant gap, but real design risk in the substitution layer |
| 3 | **2** | medium | Blocks unattended CI; needs the TDL archive question settled first |
| 4 | **6** | large | Parser change, independent |
| 5 | **5**, **7** | unknown | Verify TDL's clock and encoder before designing anything |

Items 3+4 are one patch and one new sentence, and the snapshot diff is the whole
observable effect. That is the change to do first and review carefully, because
every header assign in the corpus moves.
