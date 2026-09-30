# AI skills

Gauntlet ships two optional Codex-compatible workflows. They guide changes
inside an application repository; they are not runtime plugins for the Gauntlet
server and installing them does not modify an application or deployment.

| Skill | Use it for | It does not do |
| --- | --- | --- |
| `$gauntlet-app-integration` | Connect an existing Node.js, Next.js, Symfony, or Spring application and its non-production deployment to Gauntlet. | Define domain operations or infer that a deployment is safe from an environment label. |
| `$gauntlet-extension-authoring` | Add one finite, typed operation or data source to an application whose adapter is already integrated. | Mount a transport, change ingress or network exposure, or create a generic executor. |

Both skills stop rather than enable an adapter when production identity is
ambiguous. The integration skill requires application-specific environment
evidence, a private adapter route, a stable secret reference, truthful runtime
semantics, and live negative-path checks. The extension skill keeps behavior in
an explicit application-owned catalog and rejects arbitrary SQL, class names,
command or event names, topics, file paths, URLs, and other caller-selected
dispatch targets. Confirmation prevents accidents; it is not authorization.

To let an AI operate already-registered capabilities at runtime, use
[MCP](mcp.md). Installing these authoring skills does not enable `/mcp`.

## Install from a source checkout

On Linux or macOS, use an existing, absolute skills directory whose directory
and parent are owned by the current user. The
checked-in installer validates the selected skill and its content-bound
evaluation receipt before copying anything. It refuses a destination that is
group- or world-writable, rejects extended access ACLs, and refuses to merge
with or overwrite an existing skill. Unsupported operating systems fail
closed. ACL inspection uses a root-owned, non-writable system `ls`: Linux and
NixOS require GNU coreutils, while macOS uses the BSD system binary. A
BusyBox-only Linux image is intentionally unsupported because its `ls` cannot
prove that named ACLs are absent. Installation fails closed when no trusted
probe is available.

For Codex:

```sh
mkdir -p "$HOME/.codex/skills"
skills_destination="$(cd "$HOME/.codex/skills" && pwd -P)"
node scripts/skills/install.mjs --destination "$skills_destination" \
  gauntlet-app-integration gauntlet-extension-authoring
```

For an agent installation that discovers `~/.agents/skills`, use that absolute
directory instead:

```sh
mkdir -p "$HOME/.agents/skills"
skills_destination="$(cd "$HOME/.agents/skills" && pwd -P)"
node scripts/skills/install.mjs --destination "$skills_destination" \
  gauntlet-app-integration gauntlet-extension-authoring
```

The source installer validates every requested skill before it starts staging
the batch and serializes the batch with an atomic destination lock. It records
the owning process before creating deterministic scratch directories, rolls
back only directories created by the same failed invocation, and can recover a
stale lock after the recorded process is gone. It never treats an active owner
as stale. The command is not an upgrade tool: if a skill already exists,
compare it, move it aside explicitly, and rerun the installer; never delete an
unknown directory merely to make installation succeed.

## Install from a release archive

The GitHub release contains `gauntlet-skills-0.1.6.tgz` and records its
digest in `SHA256SUMS` and the release inventory. Verify those release files
before extraction. Extract into a new private temporary directory, not directly
into the skills destination:

```sh
skills_unpack="$(mktemp -d)"
chmod 700 "$skills_unpack"
tar -xzf gauntlet-skills-0.1.6.tgz -C "$skills_unpack"
skills_archive_root="$skills_unpack/gauntlet-skills-0.1.6"
```

The archive contains a closed manifest, the two validated skill trees, and a
self-contained installer. That installer intentionally accepts exactly one
skill per invocation, refuses overwrite, verifies the copied tree against the
manifest, and uses an atomic per-destination lock. Run it once for each skill:

```sh
skills_destination="$(cd "$HOME/.codex/skills" && pwd -P)"
node "$skills_archive_root/scripts/skills/install.mjs" \
  --destination "$skills_destination" gauntlet-app-integration
node "$skills_archive_root/scripts/skills/install.mjs" \
  --destination "$skills_destination" gauntlet-extension-authoring
```

Keep the preceding installed directory until the replacement has been checked.
The installer never overwrites it and never performs an implicit rollback.

## Invoke the workflows

Name the workflow explicitly in the implementation request. For example:

```text
Use $gauntlet-app-integration to connect this Symfony application and its
staging deployment. Keep the adapter disabled until every safety gate has live
evidence; do not touch production.
```

```text
Use $gauntlet-extension-authoring to add a finite “expire test invoice”
operation to this already integrated application. Call the existing domain
service, define the complete schema and tests, and do not add a generic command
or SQL endpoint.
```

The application and deployment supplied in the request remain the complete
scope. Review the proposed file and infrastructure changes before applying
them to a shared environment. A skill cannot grant credentials, prove network
isolation, or replace application authorization and domain validation.

## Repository verification

Maintainers run all three gates:

```sh
pnpm skills:test-install
pnpm skills:test-evals
pnpm skills:validate
```

`skills:test-install` covers validation, source installation, deterministic
archive construction, tamper detection, locking, and overwrite refusal.
`skills:test-evals` runs the hermetic fixture contracts. `skills:validate`
reconciles each scenario matrix with every transcript and verifies current
skill, evaluation, external-input, and transcript SHA-256 values.

The checked-in evaluation evidence is synthetic and local. Its hashes provide
repository content integrity, not model-provider attestation, package
publication proof, physical network proof, or evidence from a customer
deployment. A real integration is complete only after its own private-route and
runtime probes pass in the selected non-production environment.
