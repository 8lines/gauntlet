# Control-plane configuration

Gauntlet reads one closed, versioned configuration before it opens its HTTP
listener. The configuration identifies one non-production Gauntlet instance
and at least one explicitly allowed application adapter. It is deployment
configuration, not a discovery mechanism: Gauntlet receives no Docker or
Kubernetes discovery privileges.

## Version 1 document

The canonical schema is
[`gauntlet-config-v1.schema.json`](gauntlet-config-v1.schema.json). Its
stable identifier is
`https://schemas.8lines.dev/gauntlet/config/v1.schema.json`. A YAML editor
that understands `yaml-language-server` comments can associate a copied file
with the repository schema like this:

```yaml
# yaml-language-server: $schema=./gauntlet-config-v1.schema.json
version: 1
instance:
  name: small-apps-dev
  environment:
    name: dev
    kind: development
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing:8080
    publicUrl: https://dev.billing.example
    expectedEnvironment:
      name: dev
      kind: development
    tags: [node, payments]
  - id: portal
    label: Portal
    adapterUrl: http://portal:8080
    expectedEnvironment:
      name: dev
      kind: development
    tags: [symfony]
  - id: ipv6-worker
    label: IPv6 worker
    adapterUrl: "http://[fd00::12]:8080"
    expectedEnvironment:
      name: dev
      kind: development
    tags: [java]
```

This is the same semantic document as
[`fixtures/config.valid.yaml`](fixtures/config.valid.yaml) and
[`fixtures/config.valid.json`](fixtures/config.valid.json).

The root has exactly `version`, `instance`, and `targets`; `version` must be
`1`. Objects are closed, so an unknown root, instance, target, or environment
field fails startup. There must be at least one target and target `id` values
must be unique. Each target must declare an `expectedEnvironment`. Gauntlet
compares both its `name` and `kind` exactly with the adapter manifest and blocks
all proxy routes for a mismatched target.

The exact allowed environment kinds are `development`, `test`, `qa`,
`staging`, `uat`, `preview`, and `sandbox`. There is no production kind and no
override. As an additional misconfiguration guard, an environment name is
rejected when `prod`, `production`, or `live` is the whole name or a token
separated by `.`, `_`, `:`, or `-`.

`adapterUrl` and optional `publicUrl` values are HTTP(S) origins. They may use a
host (including bracketed IPv6) and an optional port, with only the optional
root `/`. Credentials, another path, query, fragment, backslash, whitespace,
and control characters are rejected. Origins come only from deployment
configuration; a browser request cannot select an arbitrary URL.

Listener, static dashboard and MCP settings are separate process environment
variables; they do not belong inside this closed configuration document. See
[server settings](../apps/server/README.md#runtime-environment) and
[MCP configuration](../docs/mcp.md#settings-and-access-boundary).

## Widget

The document also accepts an optional top-level `widget` object and an
optional per-target `widget` object:

```yaml
widget:
  enabled: true
targets:
  - id: shop
    label: Shop
    adapterUrl: http://shop-dev:8080
    expectedEnvironment: { name: dev, kind: development }
    widget:
      origins: [https://shop.dev.example]
```

`widget.enabled` defaults to `false`. A target's `widget.origins` entries must
be exact canonical HTTP(S) origins: no wildcards, credentials, paths, or
trailing slash. An uppercase host and a default port (`:443` for `https`,
`:80` for `http`) are rejected too, since neither is the origin's canonical
form — for example, `https://shop.dev.example:443` is rejected in favor of
`https://shop.dev.example`. This matches the existing MCP origin rules. For
example, `https://shop.dev.example/` (trailing slash) and
`https://*.dev.example` (wildcard) are both rejected. The JSON Schema and the
Helm chart schema reject wildcards, credentials, paths, trailing slashes, and
an uppercase host, but not a default port — the default-port case is only
caught when the server validates the fully assembled configuration. An
invalid `widget` value fails startup with `invalid-document`, the same as any
other invalid configuration field. When the widget is enabled,
`GAUNTLET_WIDGET_DIR` must also point at the built widget assets; the served
`/widget/*` routes are documented in
[server settings](../apps/server/README.md).

## Authentication

The optional top-level `auth` object turns on Gauntlet's own sign-in:

```yaml
auth:
  mode: password
  publicUrl: https://gauntlet.qa.internal
  sessionTtl: 12h
  password:
    shared:
      hash: "scrypt$16384$8$1$..."
  tokens:
    - name: ci-nightly
      hash: "sha256$..."
```

`mode` is `none` (the default when `auth` is omitted, and then no other key is
allowed) or `password`. Password mode requires `publicUrl`, an exact HTTP(S)
origin without path, query or fragment, and exactly one of `password.shared`
or `password.users` (a non-empty list of unique `username` IDs with their
`hash`). `sessionTtl` is `<n>m`, `<n>h` or `<n>d` between 5 minutes and 30
days. `tokens` lists static API tokens by unique `name` and unique hash. The
file holds only hashes, produced by `node dist/auth-cli.js hash-password` and
`create-token`; the signing secret comes from `GAUNTLET_AUTH_SECRET`, never
from this file. See [authentication](../docs/deployment/authentication.md).

## File selection and parsing

Set `GAUNTLET_CONFIG_FILE` to a file ending in lowercase `.yaml`, `.yml`, or
`.json`. If it is not set, the container default is
`/etc/gauntlet/config.yaml`. Mount the default as a read-only file, for
example:

```yaml
volumes:
  - ./config.yaml:/etc/gauntlet/config.yaml:ro
```

The maximum input size is 1 MiB (`1048576` bytes), measured before decoding.
Input must be valid UTF-8. YAML must contain exactly one document and cannot
use aliases or duplicate keys. JSON must contain exactly one JSON value and
cannot use duplicate object keys. The parsed value is then validated again by
the runtime; schema validation in an IDE does not replace startup validation.

Configuration reload is not implemented in v0.1. After changing the mounted
file, restart the Gauntlet process or its single container/pod. A deployment
must not assume that replacing the file changes a running process.

## Source precedence and legacy migration

Source selection is deterministic and fail-closed:

1. An explicit `GAUNTLET_CONFIG_FILE` together with any legacy variable is
   a `source-conflict`; Gauntlet does not guess which source should win.
2. With no explicit file, the presence of any legacy variable selects the
   legacy path. All four variables listed below are then required.
3. With neither an explicit file nor a legacy variable, Gauntlet reads the
   default `/etc/gauntlet/config.yaml`.

The deprecated compatibility input consists of exactly these four variables:

- `GAUNTLET_TARGETS_JSON`: a JSON array of target objects;
- `GAUNTLET_INSTANCE_NAME`: the instance identifier;
- `GAUNTLET_ENVIRONMENT_NAME`: the instance environment name;
- `GAUNTLET_ENVIRONMENT_KIND`: one of the seven allowed kinds.

Every object in `GAUNTLET_TARGETS_JSON` still requires its own
`expectedEnvironment`; the legacy path does not weaken environment matching.
It has the same 1048576-byte bound and passes through the same closed v1
runtime validation as a file. After a valid legacy configuration is selected,
the process emits one deprecation warning with code
`GAUNTLET_TARGETS_JSON_DEPRECATED`. Migrate to a configuration file; the
legacy variables are intended for removal after the migration period.

## Diagnostics and security boundary

Invalid configuration prevents startup. Loader failures use only one of these
bounded codes: `source-conflict`, `file-unreadable`, `file-too-large`,
`unsupported-extension`, `invalid-syntax`, `invalid-document`, or
`legacy-environment-missing`. Diagnostics do not echo file contents, secrets,
credentials, target origins, or hostile thrown values.

Valid non-production metadata is an accidental-misconfiguration guard; it
cannot prove physical infrastructure identity. Gauntlet v0.1 has no
authentication. Run it only behind a trusted private network boundary, never
in production, and keep every adapter origin private and reachable only from
the control plane.

[Documentation index](../docs/README.md)
