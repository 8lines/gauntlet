# Gauntlet Adapter v1 conformance runner

`@8lines/gauntlet-conformance-runner` provides scenario-driven checks for an
Adapter v1 implementation and a loopback-only fixture adapter. Scenario files
are supplied by the caller.

Run the base conformance suite against one adapter origin:

```sh
pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.1 gauntlet-conformance \
  --base-url http://127.0.0.1:8081 \
  --scenario ./adapter-v1.json
```

Start the local fixture adapter on an operating-system-assigned loopback port:

```sh
pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.1 gauntlet-conformance-fixture \
  --scenario ./adapter-v1.json \
  --host 127.0.0.1 \
  --port 0
```

Run extended conformance against independent enabled and disabled origins:

```sh
pnpm dlx --package @8lines/gauntlet-conformance-runner@0.1.1 gauntlet-conformance-extended \
  --enabled-base-url http://127.0.0.1:8081 \
  --disabled-base-url http://127.0.0.1:8082 \
  --scenario ./adapter-v1-extended.json
```

[Documentation index](../../docs/README.md)
