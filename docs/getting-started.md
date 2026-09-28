# Get started with Gauntlet

This guide connects an application you own to a private Gauntlet dashboard.
If you want to explore with sample data first, use the
[local demo](local-development.md#run-the-local-demo).

## Before you start

You need a non-production application with a Gauntlet adapter, a private
path from Gauntlet to that adapter, and a private way for your team to reach
the dashboard. Follow [application integration](integrations/index.md) if the
adapter is not installed yet.

For the Docker path below, you also need Docker Engine with Compose, access to
the private Gauntlet image and the application's container on the same Docker
Engine. For Kubernetes, follow the [Helm guide](../deploy/helm/README.md) instead.

Gauntlet v0.1 has no built-in authentication. Give access only to trusted
users; do not expose it publicly or enable application adapters in production.

## 1. Create your configuration

From the repository root:

```sh
cd deploy/compose
./gauntlet init
```

This creates two files: `.env` selects the image, bind address and port;
`config.yaml` names the environment and the applications to connect. Initialization
does not overwrite existing files. If you already have them, review and edit them.

Keep `GAUNTLET_BIND=127.0.0.1` in `.env`. In `config.yaml`, replace the sample
targets with your application's details. For example:

```yaml
version: 1
instance:
  name: billing-staging
  environment:
    name: staging
    kind: staging
targets:
  - id: billing
    label: Billing
    adapterUrl: http://billing-staging-adapter:8080
    expectedEnvironment:
      name: staging
      kind: staging
    tags: [payments]
```

`billing-staging-adapter` is an example Docker network alias; replace it with
your adapter's actual private hostname and port. `adapterUrl` is the origin
only — do not append `/_gauntlet/v1`. Both expected environment fields must
match the adapter's manifest exactly. This example describes an application
you supply; it does not deploy a Billing service.

An optional `publicUrl` sets the allowed application origin for browser-session
launches. It does not make the adapter public. The
[configuration reference](../config/README.md) describes every field and limit.

## 2. Start Gauntlet

The `ghcr.io/8lines/gauntlet` image is public, so no registry login is needed.
Start Gauntlet from `deploy/compose`:

```sh
./gauntlet up -d --wait
./gauntlet ps
```

## 3. Connect the application and open the dashboard

Startup creates the external `gauntlet` bridge if it is absent. Follow
[Integrating another Compose application](../deploy/compose/README.md#integrating-another-compose-application)
to attach only your application's adapter service to that bridge. Give it the
unique network alias used in `adapterUrl`, keep its adapter port unpublished,
and start or recreate that service through its own Compose project.

Gauntlet can be ready before the application is connected. The target
becomes usable once the adapter is reachable and its environment matches.

Open **http://127.0.0.1:8080** on the Docker host. For a remote Docker host, use
your approved SSH/VPN/private access path; your own laptop's loopback is a
different machine.

A ready server may still have an unavailable application. Check the target's
status in the dashboard, then use the [troubleshooting table](user-guide.md#troubleshooting)
if it is not online.

## 4. Run your first operation

Select the application, then an available operation. Fill in its form, use
presets or searchable choices where supplied, and review the stated impact.
Use a read-only operation or a supported dry run for the first connection check.
Complete any required confirmation, submit once and inspect the final state.

`Queued` and `Running` mean work has been accepted, not completed. Results,
artifacts and subsequent actions come from the application's operation
definition. Cancellation, uploads and session launch appear only where supported.

Continue with the [user guide](user-guide.md) for everyday usage, or
[MCP setup](mcp.md) to let an AI client use the same catalog.

[Documentation index](README.md) · [Compose operations](../deploy/compose/README.md) · [Deployment choices](deployment/decision-guide.md)
