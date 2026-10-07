# Standalone Docker Compose operations

This directory is the supported single-host distribution for a Gauntlet instance that controls several small applications. Run it on the same Docker Engine as those applications. The `gauntlet` wrapper pins the project, environment file, and base Compose model, while operator-owned `.env` and `config.yaml` stay outside version control.

## Safety boundary

Gauntlet is strictly a non-production tool. Its own configuration and every connected adapter declare a structured environment, and each adapter must remain disabled independently in production. There is no production override.

Gauntlet v0.1 has no authentication. Keep both the dashboard and every adapter endpoint behind a verified private boundary. A private bind, TLS, a VPN, or Tailscale transport is not caller identity: binding is not authentication. Firewall rules, Tailscale ACLs, and application-side authorization remain operator responsibilities.

The deployment intentionally runs one replica. Control-plane run projections are process-local and are lost on restart, replacement, or removal. Application-side execution and persistence belong to each adapter. Do not scale this Compose service.

## Prerequisites

- A host with Docker Engine and the Compose plugin.
- The exact approved `ghcr.io/8lines/gauntlet` version or digest. The image is public, so pulling it needs no registry login.
- Every participating application running on the same Docker Engine.
- A reviewed non-production name and kind for the Gauntlet instance and every target.

If you mirror the image into a private registry, use interactive registry login or a Docker credential helper for that mirror. Registry credentials belong in Docker's credential store, never in `.env`, `config.yaml`, a command argument, or an adapter URL.

## First installation

Copy this whole distribution directory to the Docker daemon host. Initialization creates `.env` with mode `0600` and `config.yaml` with mode `0644`; it refuses to merge with or overwrite either file.

Enter the directory containing this README and the `gauntlet` wrapper. From a source checkout run `cd deploy/compose`; after extracting the release archive run `cd gauntlet`.

<!-- gauntlet:first-install -->
```sh
./gauntlet init
# Edit .env and config.yaml, then review the declared non-production environment.
./gauntlet up -d --wait
./gauntlet ps
```

Keep `GAUNTLET_BIND=127.0.0.1` unless access through one specific private interface is deliberately required. Use an approved stable version or canonical digest for `GAUNTLET_IMAGE`; never use a floating tag. The first container-creating command safely creates the external `gauntlet` bridge if it is absent.

## Integrating another Compose application

Only the service that exposes the adapter joins the shared network. It exposes the container port to peers but never publishes that port to the host. Give it an environment-qualified, globally unique network alias; ordinary names such as `api` or `web` can collide across projects and make Docker DNS ambiguous.

<!-- gauntlet:application-network -->
```yaml
services:
  billing:
    expose:
      - "8080"
    networks:
      default: {}
      gauntlet:
        aliases:
          - small-apps-dev-billing

networks:
  gauntlet:
    external: true
    name: gauntlet
```

The matching target uses `http://small-apps-dev-billing:8080`. The portal example uses the distinct alias `small-apps-dev-portal`. Keep the adapter mounted only at `/_gauntlet/v1`; browsers call Gauntlet's `/api/v1` and never call an adapter directly.

Every container attached to the shared bridge can attempt to reach its peers. Attach only trusted non-production services. An external bridge spans one Docker Engine, not multiple hosts, VPS instances, Swarm nodes, or Kubernetes clusters.

## Private access

The default loopback bind is suitable for a browser on the daemon host. For remote access, prefer one of these reviewed boundaries:

- an SSH tunnel ending at `127.0.0.1` on the daemon host;
- a private reverse proxy with an allowlist and TLS, or an authenticating reverse proxy (for example basic authentication or SSO) in front of the dashboard only;
- one concrete private VPN or Tailscale interface address, protected by firewall and ACL rules.

Never bind the dashboard to wildcard `0.0.0.0` or expose it through public ingress. Do not enable Funnel for this service. Verify the effective host firewall and the private route from a separate client before giving testers access.

## Editing targets and environment

`config.yaml` is the source of truth for the instance identity, target URLs, and exact expected target environments. It must not contain credentials. A target name and kind must match the manifest advertised by that adapter; do not relabel a production deployment as staging or development.

After changing only `config.yaml`, restart the single process:

<!-- gauntlet:config-reload -->
```sh
./gauntlet restart
```

After changing `.env`, the image coordinate, bind address, port, or `GAUNTLET_CONFIG_PATH`, recreate the service:

<!-- gauntlet:recreate -->
```sh
./gauntlet up -d --wait
```

The wrapper requires its fixed `.env` and base model but allows `GAUNTLET_CONFIG_PATH` to select an operator-managed file other than the default `config.yaml`.

## Status, readiness, and logs

<!-- gauntlet:routine -->
```sh
./gauntlet ps
./gauntlet logs --tail 200
./gauntlet logs -f
```

`/health` means the local process is alive. `/ready` means the control plane loaded a valid configuration and is ready to serve; it intentionally does not prove that every target is online. Inspect target state in the dashboard or `/api/v1/targets`. A target marked mismatched must be fixed at its actual deployment/configuration boundary, not bypassed.

## Upgrade

Back up the current operator files and image coordinate privately. Change `GAUNTLET_IMAGE` to the approved exact version or digest, then:

<!-- gauntlet:upgrade -->
```sh
./gauntlet pull
./gauntlet up -d --wait
./gauntlet ps
```

A version tag is stable naming but can be mutable at a registry; a digest is content-immutable. Verify target states after the upgrade. Recreate strategy and one replica imply short downtime.

## Rollback

Restore the previously approved exact image version or digest in `.env`, then run the same pull-and-recreate sequence:

<!-- gauntlet:rollback -->
```sh
./gauntlet pull
./gauntlet up -d --wait
./gauntlet ps
```

Rollback restores software and configuration compatibility; it cannot restore process-local run history. Recheck the instance environment and every target after rollback.

## Stop, start, and removal

<!-- gauntlet:shutdown -->
```sh
./gauntlet stop
./gauntlet start
./gauntlet down
```

`stop` keeps the container. `start` resumes it. `down` removes the Gauntlet container and its project-local ingress network, but it does not delete `.env` or `config.yaml` and does not remove the external `gauntlet` network. The shared bridge may still be in use by application projects. Never use a daemon-wide prune as a Gauntlet cleanup step.

Remove the copied distribution only after stopping it and confirming a private backup. This runbook intentionally provides no command that deletes operator files or the shared bridge.

## Backup and recovery limits

Back up `.env`, `config.yaml`, and the preceding approved image coordinate in a private operator store. Configuration is not a secret store, but its internal hostnames and topology still deserve limited access. Gauntlet does not persist run history in v0.1. Durable domain changes, job state, audit trails, and rollback data remain the responsibility of each target application and adapter.

An interrupted `init` fails closed rather than overwriting partial or operator-owned paths. Inspect the directory and restore from the untouched examples or your backup; do not blindly replace existing files.

## Remote Docker and VPS limitations

With a remote Docker context, bind-mount sources and `127.0.0.1` refer to the daemon host, not the laptop running the CLI. Relative files are not uploaded to the daemon, and the external bridge exists only on that one engine. The wrapper does not promise transparent remote-context operation.

For a VPS, copy the distribution to that VPS and invoke it there, or provision the exact absolute files on the daemon host. The wrapper fixes both the Compose project and shared network names: run one Gauntlet instance per Docker Engine. A separate directory does not isolate a second instance on the same daemon. Use a separate daemon or host for each environment, and never connect a development Gauntlet to production services across hosts.

## Troubleshooting

- **Initialization refused:** one of the operator files or the initialization lock already exists. Preserve it, inspect ownership, and compare it with the examples; the wrapper will not overwrite it.
- **Shared network unavailable:** verify the local Docker daemon and permissions. A container-creating wrapper command retries the inspect/create race but never removes the network.
- **Configuration mount fails:** `GAUNTLET_CONFIG_PATH` must identify an existing regular file on the daemon host; Compose will not create a missing path as a directory.
- **Target offline:** check same-engine network membership, the unique alias, adapter health, and its disabled/enabled state.
- **Environment mismatch:** compare the actual manifest name and kind with `expectedEnvironment`; fix the deployment rather than changing safety semantics.
- **Dashboard unreachable remotely:** keep loopback/private binding and repair the SSH/VPN/proxy/firewall path. Do not solve it by public exposure.

## Authentication

To require a password, generate the signing secret and password hashes with
the image, for example
`./gauntlet run --rm --no-deps gauntlet node dist/auth-cli.js generate-secret`
and `./gauntlet run --rm --no-deps -T gauntlet node dist/auth-cli.js hash-password`.
Put the secret in the installed `.env` as `GAUNTLET_AUTH_SECRET`, add the
`auth` section to `config.yaml`, and run `./gauntlet up -d --wait`. The
installed `.env` is created private to its owner; keep it that way. See
[authentication](../../docs/deployment/authentication.md).

## Pinned operations

The Compose distribution does not set `GAUNTLET_DATA_DIR`, so Gauntlet keeps
pinned operations in memory and they are lost when the container restarts.
The server logs a `GAUNTLET_DATA_EPHEMERAL` warning at startup to say so.

## MCP access for AI clients

Set `GAUNTLET_MCP_ENABLED=true` in the installed `.env` and run
`./gauntlet up -d --wait`. Connect a Streamable HTTP MCP client to the
private dashboard origin with path `/mcp`. The optional
`GAUNTLET_MCP_ALLOWED_ORIGINS_JSON` setting defaults to `[]`; native clients
without Origin headers work with that default. Keep the existing private bind.
See [MCP setup, tools and limits](../../docs/mcp.md).

[Documentation index](../../docs/README.md)
