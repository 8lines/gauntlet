# Gauntlet v0.1 Release Program

This index turns the approved release design and the focused implementation plans into one ordered program. It is coordination metadata, not a second specification.

## Authority

- Approved design: `docs/superpowers/specs/2026-09-02-release-standalone-safety-skills-design.md`
- Integration branch: `main`
- Initial product version: `0.1.0`
- Protocol version: Adapter API v1
- Product posture: private, proprietary, explicitly non-production only

## Recorded rulings

1. Work directly on `main`, without a worktree, because the user explicitly requested that workflow. Every implementation task is committed separately so it remains reviewable and reversible.
2. `apps/dashboard/`, `docs/mockups/`, the current Fastify static-serving changes, and `pnpm-lock.yaml` are existing release inputs. Dashboard plan Task 1 owns their review and first commit; no other task may reset or silently replace them.
3. `@8lines/gauntlet-protocol` owns the environment model and production-name guard. `InvocationContext.target.environment` stays optional, string-valued, and non-authoritative.
4. The control-plane configuration plan owns `StaticTargetConfig.expectedEnvironment`, the v1 file schema, and configuration loading. Protocol safety Task 6 consumes those outputs and owns the required `createApp` instance-environment gate.
5. Confirmation is required whenever an operation declares `confirmationRequired`, including dry runs. It is bound to operation ID, exact revision, and declared impact.
6. The private release plan Task 4 exclusively owns the PHP 8.3+/Symfony 7.2+ compatibility constraints, locks, images, and CI matrix. The protocol plan owns runtime safety behavior, not package baselines.
7. The private release plan creates the proprietary license once. The documentation plan consumes and explains it.
8. GitHub Artifact Attestations are unavailable for private repositories on the current 8lines GitHub Free plan. The image instead carries BuildKit `provenance=mode=max,version=v1` plus SPDX SBOM attestations, and the staged release contains checksums and an artifact inventory.
9. Creating remote repositories, pushing, tagging, or publishing artifacts is an external side-effect boundary. Local release readiness must be proven first; publication is performed only with explicit authority at that boundary.

## Ordered execution

Dependencies are resolved in this order. Tasks inside each referenced plan retain their own RED-GREEN-REFACTOR instructions and acceptance checks.

1. `2026-09-03-dashboard-product-image.md`, Task 1 — adopt and commit the existing dashboard/static-serving baseline.
2. `2026-09-03-protocol-sdk-safety.md`, Tasks 1–5 — canonical protocol, schemas, fixtures, revisions, and dashboard wire parsing.
3. `2026-09-03-dashboard-product-image.md`, Tasks 2–3 — own dashboard request construction, confirmation UI, uploads, and result actions after the wire contract exists.
4. `2026-09-03-control-plane-configuration.md`, Tasks 1–3 — closed configuration schema, bounded loader, and constrained legacy migration.
5. `2026-09-03-protocol-sdk-safety.md`, Task 6 — require the validated control-plane environment at startup.
6. `2026-09-03-control-plane-configuration.md`, Tasks 4–5 — configured composition, readiness, and cross-format verification.
7. `2026-09-03-protocol-sdk-safety.md`, Tasks 7–18 — target matching, TypeScript/PHP/Java runtime safety, conformance, and examples.
8. `2026-09-03-dashboard-product-image.md`, Tasks 4–6 — mobile/desktop verification, static routing, and the product image.
9. `2026-09-03-standalone-compose.md`, Tasks 1–4 — supported standalone distribution and two-adapter smoke topology.
10. `2026-09-03-helm-chart.md`, Tasks 1–5 — supported Kubernetes distribution.
11. `2026-09-03-private-release-engineering.md`, Tasks 1–4 — establish the version/artifact model after every versioned deployment file exists, then prove the PHP compatibility floor.
12. `2026-09-03-protocol-sdk-safety.md`, Task 19 — cross-language verification after the PHP compatibility floor exists.
13. `2026-09-03-private-release-engineering.md`, Tasks 5–9 — Java artifacts, staged release, CI/publication workflow, and the local dry-run.
14. `2026-09-03-ai-skills.md`, Tasks 1–6 — pressure-tested integration and extension-authoring skills, one complete skill at a time.
15. `2026-09-03-release-documentation.md`, Tasks 1–9 — documentation that describes verified behavior and the final documentation-gated clean release rehearsal.
16. `2026-09-03-private-release-engineering.md`, Task 10 — optional remote bootstrap and non-publishing workflow rehearsal after authority is confirmed.

## Acceptance-criteria coverage

| Release requirement | Owning plan |
| --- | --- |
| Clean, canonical private repository and rehearsed remote workflow | Private release engineering, Task 10 |
| One complete local release command | Private release engineering, Task 9 |
| Dashboard and API in one non-root image | Dashboard/product image |
| Standalone Compose reaching two explicit targets | Standalone Compose |
| Hardened single-replica Kubernetes deployment | Helm chart |
| Fail-closed structured environment gates in every runtime | Protocol/SDK safety |
| Exact expected-target/manifest environment match | Protocol/SDK safety |
| Revision-bound confirmation, including dry-run | Protocol/SDK safety |
| Truthful handler-level dry-run with mutation sentinel | Protocol/SDK safety |
| Installable private npm, Composer, and Maven consumers | Private release engineering |
| Pull-request verification and tag-only publication | Private release engineering |
| Installable, evaluated AI skills | AI skills |
| Directory, deployment, integration, safety, release, and rollback manuals | Release documentation |
| Explicit v0.1 auth, durability, and replica limits | Release documentation |

## Execution discipline

- Use `superpowers:subagent-driven-development` with one implementation agent at a time because all agents share the same checkout.
- Use a fresh specification reviewer after every task and a final whole-program reviewer before release readiness is claimed.
- New production behavior follows `superpowers:test-driven-development`; the inherited dashboard baseline is characterized before it is changed.
- No completion claim is made until the clean release command, package consumer tests, container smoke tests, Compose checks, Helm checks, skill evaluations, documentation checks, and repository status have been independently verified.
