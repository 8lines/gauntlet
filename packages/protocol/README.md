# Gauntlet adapter protocol

`@8lines/gauntlet-protocol` is the language-neutral contract shared by the
Gauntlet control plane and every in-application adapter. The checked-in JSON
Schemas and OpenAPI document define the wire format. This document defines the
portable behavior that JSON Schema and revision implementations must share
across TypeScript, PHP, and Java.

The executable sources of truth are:

- `fixtures/v1/tc-schema-core-pattern-vectors.json` for portable regular
  expressions; and
- `fixtures/v1/jcs-revision-vectors.json` for canonical JSON and revision
  hashing; and
- `fixtures/v1/adapter-semantic-vectors.json` for manifest, operation,
  data-source resolve, and preset-secret semantics. Its closed companion schema
  is `fixtures/v1/adapter-semantic-vectors.schema.json`.

An SDK implementation is conformant only when it accepts and rejects those
vectors exactly. It must not broaden the grammar based on features available in
its host regular-expression engine.

## `tc-schema-core@1` patterns

Patterns use case-sensitive ECMAScript Unicode search semantics over the
`unicode-scalar-sequences` instance domain declared by the vector artifact. No
multiline, dot-all, ignore-case, global, or sticky flag is enabled. An
unanchored pattern searches within the value. `^` and `$` anchor it; `$` means
absolute end and does not match before a final LF, CR, U+2028, or U+2029. The
validated source is compiled unchanged with the equivalent of
`new RegExp(pattern, "u")` after the portable checks. Validators must not
translate or normalize it.

Candidates containing lone UTF-16 surrogate code units are outside this
instance domain. Adapter and control-plane protocol boundaries MUST reject such
strings before JSON Schema pattern evaluation; this requirement does not alter
the current wire schema shapes. ECMAScript `/u` permits a negated class to match
a lone surrogate, but that host-engine behavior does not expand the portable
domain: the candidate must already have been rejected, and portable interval
analysis complements classes only over Unicode scalar values.

A decoded pattern is limited to 512 UTF-16 code units. Its grammar is:

```text
disjunction := alternative ("|" alternative)*
alternative := term*
term        := assertion | atom quantifier?
assertion   := "^" | "$"
atom        := raw-scalar | allowed-escape | class | group
group       := "(" ("?:")? disjunction ")"
quantifier  := "?" | "*" | "+" | "{" m ("," n?)? "}"
```

Capturing and noncapturing groups have the same matching semantics in this
profile. Quantifier bounds are canonical ASCII decimals without leading zeroes
apart from `0`, are at most 1000, and satisfy `m <= n`. Quantifiers are greedy.

Outside a class, the only escapes are literals from
`\\^$.*+?()[]{}|/`. Inside a class, the only escapes are `\\`, `\]`,
`\^`, and `\-`. Negation and raw Unicode scalar literals are supported. An
ordinary range is allowed only when it does not span the surrogate block: a
range whose start is at most U+D7FF and whose end is at least U+E000 is
rejected. A raw hyphen is a literal in the positions where ECMAScript treats it
as one, including the trailing hyphens used by the protocol ID patterns;
escaping it is preferred in newly authored patterns. Accepted range sets are
normalized to Unicode-scalar intervals.

The profile rejects:

- lone surrogates and decoded C0/C1 control characters;
- `.`, shorthand classes, boundaries, backreferences, lookaround, named groups,
  inline flags, and property, code-point, hex, or control escapes;
- lazy, possessive, or repeated quantifier suffixes and malformed bounds;
- nested, empty, or wildcard-equivalent classes, descending or
  surrogate-spanning ranges, and class set operators `&&` and `--`; and
- any expression that fails the deterministic analysis below.

The identical scanner is applied to every `pattern` value and every
`patternProperties` key. A rejection reports the escaped JSON Schema pointer
and a fixed portable-profile message; it never includes a `pattern` value in
the message body.

### One-pass guarantee

Each consuming literal or class occurrence receives a distinct position and a
normalized set of Unicode-scalar intervals. While parsing, the validator
computes nullable-derivation multiplicity, `FIRST`, and `LAST` summaries.
Alternation adds nullable derivations and concatenation multiplies them; any
combinator producing more than one is rejected. A quantifier with a maximum
greater than one requires a non-nullable body and adds every
`LAST(body) -> FIRST(body)` transition. An optional quantifier also rejects a
nullable body because skipping it and taking its empty derivation are two
paths. Exact `{0}` remains one unambiguous empty derivation.

Transitions form a multiset: parallel identical transitions are not removed.
At the start and after every consuming position, all possible target character
sets must be pairwise disjoint. This rejects ambiguous expressions such as
`(a+)+`, `(a|aa)*`, `(a*)*`, and `a?a`, while accepting the deterministic JSON
Pointer expression `^(?:/(?:[^~/]|~[01])*)*$`. Combined with the 512-code-unit
limit, this defines deterministic matching from one start position.

Native search can still retry a deterministic expression at every input
position: unanchored `a*b`, for example, is quadratic when the suffix is absent.
Therefore any source containing `*`, `+`, or an open upper bound `{m,}` MUST
begin at its first code unit with an unescaped `^`, and the root expression MUST
have no top-level alternation. Alternation nested after that shared anchor is
allowed. Unanchored expressions may use only bounded quantifiers; their maximum
of 1000 bounds work per candidate start. Together these rules define the
portable linear-time profile. A broader grammar requires a new profile
identifier.

## JCS revisions

Revision inputs are JSON parsed as IEEE-754 binary64 values. To calculate a
revision:

1. Work on own JSON data properties only. Preserve a member literally named
   `__proto__`; it has no prototype semantics.
2. Remove only the named revision member (`revision` or `manifestRevision`) at
   the document root. Retain nested members with the same name.
3. Reject lone surrogates in both property names and string values. Reject
   non-finite numbers and integer-valued unsafe binary64 numbers when their
   ECMAScript JSON serialization is non-exponential. Exponential values such
   as `1e21` remain accepted.
4. Canonicalize the remaining document with RFC 8785/JCS, including UTF-16
   property-name ordering and ECMAScript number serialization.
5. Hash the UTF-8 canonical JSON bytes with SHA-256 and return lowercase
   hexadecimal prefixed by `sha256:`.

The numeric boundary is intentional. In particular, `-0`, `1e-7`, `1e-6`,
`1e21`, `1e-27`, `5e-324`, `1e-320`, and
`2.2250738585072014e-308` have frozen canonical representations, while the
non-exponential unsafe integer `9007199254740992` is rejected. SDK authors
must use the canonical strings and hashes in `jcs-revision-vectors.json` rather
than recomputing expected test values with their production implementation.

## Manifest semantics

Envelope validation against `manifest.schema.json` runs before
`manifestSemanticsAreValid`. The schema owns the closed shape of availability
Problems and diagnostics, including the portable `operationId` syntax. The
shared semantic predicate then applies these cross-document rules:

- an `available` operation summary may require only profiles and capabilities
  listed by the manifest;
- an `unavailable` summary retains its complete declared requirements even
  when one or more are not implemented by the adapter, and carries its safe
  schema-valid Problem; and
- a diagnostic may identify a schema-valid operation ID that was omitted from
  `operations` after its binding failed validation. Diagnostic identity does
  not imply that an executable operation summary exists.

Feature references, summary and data-source uniqueness, content-derived
revisions, and data-source schema semantics are identical for both availability
states.

## Execution-policy semantics

The execution policy is enforceable behavior, not presentation metadata.
`concurrency` omitted or set to `allow` admits independent handlers. `forbid`
admits no new run while another run of the same operation owns an execution
reservation and returns `urn:gauntlet:problem:operation-busy` with status
409; an idempotent replay is still the original run and never becomes a busy
error. `queue` admits runs in reservation order and starts one handler for that
operation at a time. Queue waiting does not consume the operation timeout.

`timeoutSeconds` starts when the handler enters `running`. Expiry requests
cooperative cancellation and terminalizes the run as `timed_out` with
`urn:gauntlet:problem:run-timed-out`, title `Run timed out`, and status 504.
Explicit cancellation of a cancellable queued or running run terminalizes it
as `cancelled` with `urn:gauntlet:problem:run-cancelled`, title
`Run cancelled`, and status 409. Cancelling a run whose
operation declares `cancellationSupported: false` returns
`urn:gauntlet:problem:run-not-cancellable` with status 409 and does not
mutate the run, including when the stored run is already terminal. For an
operation that does support cancellation, retrying cancellation after a run
became terminal returns that same authoritative terminal run unchanged.

Handlers must observe their SDK's cancellation signal or cancellation check to
stop application work promptly; runtimes cannot safely hard-kill arbitrary
application code. Once cancellation or timeout wins the terminal transition,
the context is closed and late progress, artifacts, actions, handler results,
or failures cannot mutate that run. Exactly one terminal transition wins. A
serialized execution reservation remains held until the underlying handler has
actually settled, even after its run becomes terminal, so application side
effects cannot overlap. Consequently, an uncooperative handler can block later
`queue` runs (and keep `forbid` busy) until it returns.

In-memory execution coordinators are single-process test/development defaults.
An adapter deployed with multiple workers or replicas must use an
application-owned coordinator shared by those replicas together with its
shared durable `RunStore`; otherwise `forbid`, FIFO ordering, and cross-replica
cancellation are only process-local and the adapter must not claim those
guarantees.

## Adapter semantic vectors

`adapter-semantic-vectors.json` is the normative, language-neutral v1 truth
table. Consumers verify each source fixture's raw SHA-256 before parsing it,
then evaluate the checked-in boolean; expected results and revisions must not
be calculated by the predicate under test. Every source path is a safe sibling
basename. The vector instance is ASCII UTF-8 without a BOM, uses LF only, ends
with LF, and remains below 256 KiB. The companion schema and four source
fixtures have the same UTF-8/BOM/CR/final-LF byte contract.

The `rfc6902-test-subset@1` construction profile applies ordered `add`,
`remove`, `replace`, and `copy` patches to a fresh owned-JSON clone. JSON
Pointer and RFC 6902 rules apply exactly: array indexes are canonical decimal,
`-` is only an add/copy destination, copy resolves before mutation and clones
its value, and remove/replace require an existing own member. No parent
creation, root replacement, merge, interpolation, wildcard, URI resolution, or
code execution exists. A patch cannot address the root revision member.
Manifest and operation revisions are handled afterward by the explicit
`preserve` or `set` directive, and every declared match or mismatch is checked
independently before the semantic predicate runs.

The `tc-preset-operation@1` profile clones the verified operation fixture,
uses the suite's literal object input schema, and emits one ordered secret rule
per `secretPointers` entry without deduplication. It removes `uiSchema`, sets
`dataSources` to `[]`, and creates `preset-<index>` / `Preset <index>` entries
from independently cloned inputs. An empty pointer list still produces
`inputHandling.rules: []`. The case's checked-in revision is installed and
verified before envelope and semantic evaluation. Parsed schema member order
is preserved; canonical ordering is used only for the separate revision
assertion.

### Preset analysis ceilings

The v1 analyzer accepts counts exactly at these maxima and fails closed only
when the next graph node, edge, or visit exceeds one:

```text
MAX_GRAPH_NODES   = 250000
MAX_GRAPH_EDGES   = 500000
MAX_PRESET_VISITS = 500000

inputNodeCount = roots + array elements + object-member values
visitBudget = min(500000, max(8192,
  graphNodes * 4 + graphEdges * 2 + inputNodeCount * 64))
```

Object keys do not count as input nodes. Graph nodes use canonical JSON Schema
pointers; every structural occurrence is an edge. Secret pointer strings are
deduplicated for graph compilation, while duplicate rules remain in the
operation and its revision. Route multiplicity saturates at two. The visit
counter is shared by every preset in an operation; object-identity and
schema-node primitive de-duplication sets reset for each preset.

Static traversal covers local `$ref`, `properties`, `dependentSchemas`,
`allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`, `prefixItems`, and
`items`. `patternProperties`, `contains`, `additionalProperties`,
`propertyNames`, `unevaluatedItems`, `unevaluatedProperties`, and
`contentSchema` make a target dynamically addressed and therefore fail closed.

The closed `tc-preset-workloads@1` recipes are `deep-chain`,
`rules-presets-cartesian`, `dense-mutual-reference`, and `wide-array`. Their
parameters, expected revisions, and canonical full-operation UTF-8 byte counts
are portable requirements; the wide operation is generated only inside an
isolated child process and is never checked in. Node 24 reference metadata
retains 2,500 ms timeouts for cartesian and dense workloads, a 10,000 ms wide
timeout, 512 MiB old-space and 48 MiB semi-space flags, secret-wide RSS below
458,752 KiB, and a secret/control RSS delta below 40,960 KiB. Those process
budgets are Node-specific; they do not change the portable recipes or results.

[Documentation index](../../docs/README.md)
