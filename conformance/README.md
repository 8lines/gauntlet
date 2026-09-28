# Adapter v1 conformance

The conformance runner is framework-neutral and talks only to the normalized
`/_gauntlet/v1` HTTP API. It never imports an adapter SDK.

Two committed scenarios serve different purposes:

- `scenarios/adapter-v1.json` is the frozen P0 interoperability contract.
- `scenarios/adapter-v1-extended.json` covers disabled-prefix precedence,
  sanitized handler failures, real cursor traversal, and an application-owned
  binding executed through the normalized create-run route.

Build and run the extended suite with independent enabled and disabled adapter
origins:

```sh
pnpm --filter @8lines/gauntlet-conformance-runner... build
node conformance/runner/dist/extended-cli.js \
  --enabled-base-url http://127.0.0.1:8080 \
  --disabled-base-url http://127.0.0.1:8081 \
  --scenario conformance/scenarios/adapter-v1-extended.json
```

The package API exports `loadAdapterV1ExtendedScenario` and
`runAdapterV1ExtendedConformance` for SDK-specific live test harnesses. An SDK
fixture passes by exposing the IDs and behavior declared by the shared scenario;
it must not add a custom transport route. The disabled origin must be a real
disabled adapter instance. Canonical health, manifest, upload-method, and safe
create probes must return `503 adapter-disabled` before body decoding or
application routing. A trusted ingress may instead reject the deliberately
malformed raw operation target as `400 invalid-path` before adapter dispatch.

[Documentation index](../docs/README.md)
