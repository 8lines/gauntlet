# Symfony reference adapter

This project is an executable Gauntlet adapter v1 fixture. It demonstrates
a feature, a typed destructive operation, a searchable cursor data source, an
internal application binding, a session-launch capability and durable Run
state across independent Symfony kernels.

It is intentionally disabled unless `GAUNTLET_ENABLED=true` is supplied.
It requires PHP 8.3 or newer and Symfony 7.4 or 8.x (`^7.4 || ^8.0`; Symfony 8
itself requires PHP 8.4 or newer). The image is a
development/conformance fixture and must not be deployed to production.

## Build and test

Run from the repository root so Docker can copy the local PHP packages and the
shared conformance scenario:

```bash
docker build -f examples/symfony/Dockerfile \
  -t gauntlet-symfony-example .
docker run --rm gauntlet-symfony-example \
  vendor/bin/phpunit --testsuite all
pnpm --filter @8lines/gauntlet-conformance-runner test
```

The default PHP 8.3 and Composer images are immutable digest pins. Both remain
selectable for compatibility checks; use another immutable digest when
overriding either value:

```bash
docker build -f examples/symfony/Dockerfile \
  --build-arg PHP_IMAGE=php:8.3.33-cli-bookworm@sha256:177529735599a8244b2c903522f029839dce1c2ac4be122fdc00ada4b45a20e4 \
  --build-arg COMPOSER_IMAGE=composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584 \
  -t gauntlet-symfony-example .
```

The image installs dependencies without ignored platform requirements. The
reference store uses PDO SQLite, while the Core and Bundle also require their
declared curl, DOM, hash, JSON, libxml and mbstring extensions.

The local path repositories in this fixture exist only so this repository can
test the unreleased source tree. A separate application consumes version 0.1
from Packagist instead, without any custom `repositories` entry or credential:

```bash
composer require 8lines/gauntlet-symfony-bundle:^0.1.1
```

## Disabled-by-default check

Starting the image without a flag leaves the whole adapter prefix closed:

```bash
docker run --rm --name gauntlet-symfony-disabled \
  -p 127.0.0.1:8080:8080 \
  gauntlet-symfony-example
```

In another terminal:

```bash
curl -i http://127.0.0.1:8080/_gauntlet/v1/health
```

The response is `503 application/problem+json` with problem type
`urn:gauntlet:problem:adapter-disabled`.

## Run the live adapter

Enable it explicitly and publish it only on loopback for local verification:

```bash
docker run --rm --name gauntlet-symfony-live \
  -e GAUNTLET_ENABLED=true \
  -e GAUNTLET_IDEMPOTENCY_SECRET \
  -p 127.0.0.1:8080:8080 \
  gauntlet-symfony-example
```

Health is then available at
`http://127.0.0.1:8080/_gauntlet/v1/health`. Set
`GAUNTLET_IDEMPOTENCY_SECRET` from local secret management before running
that command. It must contain at least 32 bytes and remain identical across all
workers sharing a Run store; the image contains no default value.

The default SQLite path is
`/tmp/gauntlet-symfony-example/runs-<APP_ENV>.sqlite`. Override it with
`GAUNTLET_RUN_STORE_PATH`. To retain fixture Runs across container restarts,
mount a dedicated writable volume and point the variable at a file inside it:

```bash
docker run --rm --name gauntlet-symfony-live \
  -e GAUNTLET_ENABLED=true \
  -e GAUNTLET_IDEMPOTENCY_SECRET \
  -e GAUNTLET_RUN_STORE_PATH=/state/runs.sqlite \
  -v gauntlet-symfony-state:/state \
  -p 127.0.0.1:8080:8080 \
  gauntlet-symfony-example
```

The SQLite store is a reference implementation for this fixture. Production
applications bind the Core `RunStore` contract to their own shared database.
The example deliberately keeps the default inline dispatcher and process-local
execution coordinator, so it demonstrates durable sequential Run history but
does not claim cross-worker `forbid`/FIFO/cancellation guarantees. A replicated
deployment must also bind a shared `ExecutionCoordinator`; see the Symfony
bundle README. Active cancellation additionally requires a deferred,
process-local task dispatcher and the managed cancellation endpoint. Neither
component may serialize the execution task or its potentially secret input.

## External P0 conformance

With the enabled container running on port 8080, execute from the repository
root:

```bash
GAUNTLET_ADAPTER_URL=http://127.0.0.1:8080 \
GAUNTLET_SCENARIO=conformance/scenarios/adapter-v1.json \
pnpm conformance:adapter-v1
```

For an automatically assigned host port and scoped cleanup:

```bash
container_name="gauntlet-symfony-conformance-$$"
cleanup_symfony() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup_symfony EXIT INT TERM

docker run -d --name "$container_name" \
  -e GAUNTLET_ENABLED=true \
  -e GAUNTLET_IDEMPOTENCY_SECRET \
  -p 127.0.0.1::8080 \
  gauntlet-symfony-example
host_port="$(docker port "$container_name" 8080/tcp | sed -n 's/.*://p' | tail -1)"

GAUNTLET_ADAPTER_URL="http://127.0.0.1:${host_port}" \
GAUNTLET_SCENARIO=conformance/scenarios/adapter-v1.json \
pnpm conformance:adapter-v1
```

Only the bundle's `/_gauntlet/v1/*` routes are exposed. The example's
`CustomFinalizeController` is an internal callable service reached through the
operation handler; it is not an application HTTP endpoint.

[Documentation index](../../docs/README.md)
