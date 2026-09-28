# Bounded data sources

A data source supplies options for one business field. It is not a database,
search, filter, URL, or query-language endpoint.

## Definition

Give it a stable ID and label. Declare search truthfully, cursor pagination,
resolve support, a practical default limit, and a hard maximum. Add closed
dependency and context schemas when results depend on other form fields,
actor, target, or tenant. An operation references the source with its input
pointer, dependency pointers, context pointers, and required flag.

The handler must enforce the hard maximum even if a caller bypasses the UI.
Reject an invalid requested limit rather than silently permitting a larger
page. Resolve also needs an explicit request-count bound; 25 is the default
choice for the customer-selector contract unless the application has a lower
reviewed limit.

## Query

1. Resolve and authorize the tenant/domain scope through a mandatory
   application-owned authorization service before reading rows. Its result is
   the sole scope; invocation `target.id` is an untrusted claim, never a tenant
   fallback.
2. Normalize search text using one documented locale-independent rule and
   apply only bounded business matching. Do not accept regex, predicates,
   column names, sort expressions, SQL fragments, or arbitrary filters.
3. Sort by stable business keys plus an immutable unique tie-breaker. For the
   customer selector, use normalized name then UUID.
4. Decode a bounded opaque authenticated cursor. Bind its version, tenant,
   normalized search/dependency fingerprint, page size, and last sort key (or
   equivalent offset) into its signature. Reject malformed, oversized,
   expired, wrong-version, wrong-scope, or tampered cursors without echoing
   their contents.
5. Return at most the effective limit. Items contain only stable value, label,
   and reviewed optional presentation metadata. Never copy entities or private
   columns into metadata.

Opaque means the client cannot construct database selection semantics. Base64
alone is not integrity. Keep cursor signing keys in application secret storage,
not in the operation definition, browser, logs, or persisted input.

## Resolve

Reject more than the declared maximum values before querying. Preserve the
request's exact order and duplicates. Return one result for each requested
value; use an explicit `null` item for missing, unauthorized, deleted, or
cross-tenant values. Do not collapse, resort, or omit missing values. Apply the
same tenant/domain filters and output projection as query.

## Tests

Exercise zero/default/max/over-limit requests; normalized search; equal-label
tie-breaking; page traversal without gaps or duplicates; cursor tampering,
scope replay, filter replay, version, expiry, and length; tenant isolation;
ordered resolve with duplicates and missing values; resolve over-limit;
response schema validation; and private-field/secret leak checks. Run these
through the registered framework catalog as well as focused handler tests.
