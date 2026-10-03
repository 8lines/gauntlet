# Gauntlet: independent release units

Status: approved design, 2026-10-03.

## Intent

Today one `VERSION` is enforced across every published artifact. Six releases
between v0.1.2 and v0.1.8 changed no package source (apart from one CVE
dependency bump), yet each one republished 7 npm, 2 Composer and 2 Maven
artifacts and re-pinned about 40 files: Composer locks, Gradle consumer locks,
skill text, skill evaluation receipts, docs and Helm tests. Release 0.1.8, a
dashboard-only change, needed three extra commits to clear those pins.

Goal: every published package and the application have their own version.
A release publishes only units that changed, plus the units that depend on
them. A dashboard-only release publishes the application and the skills
archive, nothing else, and needs no manual re-pinning.

Success criteria:

- A change file mechanism decides what is released and how far each version
  moves; CI rejects a releasing change without a change file.
- `pnpm release:prepare` produces a release PR with every version, pin,
  lock, changelog, skill slot and evaluation receipt updated.
- One tag per release set triggers one workflow run with one approval, which
  publishes only the planned units, in dependency order, keeping today's
  guarantees (closed inventory, preflight, draft then publish, immutable
  releases, fail closed, idempotent reruns).
- Application and package compatibility is stated by protocol and channel
  versions and published in the docs and in every GitHub Release.

## Release units

| Unit id | Contents | Version source | Unit tag | Depends on |
|---|---|---|---|---|
| `gauntlet` | `apps/server`, `apps/dashboard` (incl. widget panel), private `packages/widget-loader` and `packages/widget-channel`, container image, Helm chart, Compose distribution | `VERSION` | `vX.Y.Z` | `protocol`, `dashboard-client` |
| `protocol` | `@8lines/gauntlet-protocol` | `packages/protocol/package.json` | `protocol-vX.Y.Z` | none |
| `dashboard-client` | `@8lines/gauntlet-dashboard-client` | its `package.json` | `dashboard-client-vX.Y.Z` | `protocol` |
| `typescript-core` | `@8lines/gauntlet-typescript-core` | its `package.json` | `typescript-core-vX.Y.Z` | `protocol` |
| `typescript-node` | `@8lines/gauntlet-typescript-node` | its `package.json` | `typescript-node-vX.Y.Z` | `protocol`, `typescript-core` |
| `next-adapter` | `@8lines/gauntlet-next-adapter` | its `package.json` | `next-adapter-vX.Y.Z` | `typescript-node` |
| `conformance-runner` | `@8lines/gauntlet-conformance-runner` | its `package.json` | `conformance-runner-vX.Y.Z` | `protocol` |
| `widget` | `@8lines/gauntlet-widget` (host page commands) | its `package.json` | `widget-vX.Y.Z` | none |
| `php-core` | `8lines/gauntlet-php-core` | its `composer.json` | `php-core-vX.Y.Z`; split repo keeps `vX.Y.Z` | none |
| `symfony-bundle` | `8lines/gauntlet-symfony-bundle` | its `composer.json` | `symfony-bundle-vX.Y.Z`; split repo keeps `vX.Y.Z` | `php-core` |
| `java-core` | `dev.eightlines.gauntlet:core` | `packages/java/core/VERSION` | `java-core-vX.Y.Z` | none |
| `spring-boot-starter` | `dev.eightlines.gauntlet:spring-boot-starter` | `packages/java/spring-boot-starter/VERSION` | `spring-boot-starter-vX.Y.Z` | `java-core` |
| `skills` | `gauntlet-skills-X.Y.Z.tgz` | `skills/VERSION` | `skills-vX.Y.Z` | `gauntlet` and every package whose coordinates the skills pin |

Rules:

- All units start at 0.1.8, the currently published version.
- The unit catalog (ids, paths, version sources, dependencies, owned paths,
  gate jobs, artifacts, implemented contracts) lives in one module that
  replaces the single-version catalog in `scripts/release/release-model.mjs`.
- Internal dependencies in published packages stay exact, as packing does
  today from `workspace:*`, but each points at the dependency unit's own
  version. A published set is always a set that was tested together.
- Cascade: releasing a unit gives every dependent unit at least a patch bump
  with the new exact dependency. A `protocol` change therefore also releases
  `dashboard-client`, `typescript-core`, `typescript-node`, `next-adapter`,
  `conformance-runner`, `gauntlet` and `skills`. A dashboard-only change
  releases `gauntlet` and `skills` (the skills pin the image and chart).
- The Java build reads each project's `VERSION` with the same strict parser
  it uses for `../../VERSION` today.
- The Helm chart version and `appVersion`, `values.yaml` `image.tag` and the
  Compose `.env.example` image keep following `gauntlet`'s version.

## Change files

A change file is any `.changes/*.md`:

```md
---
type: added            # added | changed | fixed | removed | security
units:
  protocol: minor
  gauntlet: patch
---
Run requests accept an optional deadline.
```

- The body is the changelog sentence, written for users, sentence case, no em
  dashes.
- Bumps are `patch`, `minor`, `major`, applied literally under semver. Before
  1.0 the documented convention is: a breaking change is `minor`.
- Several change files for one unit resolve to the highest bump.
- `none` (with the reason in the body) records that a change to owned paths
  needs no release; it is removed at preparation and never released.

CI check `pnpm release:changes --check` (new required job): each unit lists
the paths it releases (for example `packages/protocol/src/**`,
`packages/protocol/schemas/**`; tests, fixtures and READMEs excluded). A pull
request touching owned paths without a change file naming that unit fails.

## Preparing a release

`pnpm release:prepare` (maintainer, on a branch from `main`):

1. Reads change files and computes each unit's next version.
2. Applies the cascade; cascaded units get the changelog entry "Updated
   `<unit>` to X.Y.Z".
3. Writes versions into manifests using the existing span-preserving,
   all-or-nothing rewriting from `release-model.mjs`, and updates exact
   internal dependencies.
4. Re-pins what is maintained by hand today:
   - Composer locks (`packages/php/*`, `examples/symfony`, consumer tests), via
     Docker `composer:2` when PHP is not installed;
   - Gradle consumer `build.gradle.kts` and `gradle.lockfile`;
   - version slots in docs and skills, each bound to its unit;
   - skill evaluation receipts (see Skills).
5. Appends a section to each released unit's `CHANGELOG.md` and deletes the
   consumed change files.
6. Writes `.release/plan.json`: units, from and to versions, dependency
   order, source change files.
7. Prints a summary. The result is committed as a release pull request.

Changelogs: each package gets `CHANGELOG.md` in its directory, Keep a
Changelog format. The root `CHANGELOG.md` remains the `gauntlet` changelog,
keeps the shared history up to 0.1.8 and links to unit changelogs.

## Publishing

GitHub does not start workflows when more than three tags arrive in one push,
and each run needs its own environment approval, so a release set has one
trigger.

- After the release pull request merges, `pnpm release:tag` creates one
  annotated tag `release-YYYY-MM-DD.N` on the merge commit in `main`.
- Pushing it starts one `release` workflow run:
  1. Verify: the commit is in `main`, manifests equal `.release/plan.json`,
     every exact internal dependency is either in the plan or already
     published.
  2. Gates: only the jobs the planned units declare (for example `protocol`:
     node 24/25/26 and conformance; `php-core`: php and conformance;
     `java-core`: java; `gauntlet`: dashboard, widget, deployment, security;
     `skills`: skill validation and receipts). A dashboard-only release runs
     no PHP or Java gates.
  3. `release:dry-run --plan` stages each unit to
     `.artifacts/release/<unit>/<version>` and checks a closed inventory per
     unit: one tarball for an npm, Composer, Maven or skills unit; for
     `gauntlet` the docker and OCI image archives, provenance, two SBOMs, the
     chart and the Compose archive.
  4. Preflight per unit: `clean` or `already-identical`.
  5. Publish in dependency order with today's steps, scoped to the unit's
     artifacts (npm, Composer split repos, Maven, image and chart).
  6. After a unit publishes, the workflow creates its unit tag and its own
     GitHub Release (draft, verify assets, publish, require immutable). Only
     the `gauntlet` release is marked Latest. Each release carries its own
     manifest, publication receipt and `SHA256SUMS`, and a compatibility
     line.
- Failure handling keeps today's rules: nothing is overwritten, a partial
  public state fails preflight, a correction is a new version. Re-running
  the same release-set tag completes missing units only when already
  published bytes are identical.

## Compatibility

The contract between the application and packages is the set of runtime
versions already enforced: the adapter protocol major (`protocolVersion` 1.x,
checked by `dashboard-client`), profiles and capabilities (`tc-*@1`), and
`WIDGET_CHANNEL_VERSION`.

- Each unit declares what it implements (for example `protocol: 1`); the
  application declares what it supports (`protocol: [1]`,
  `widgetChannel: [1]`).
- `release:prepare` generates `docs/reference/compatibility.md` (unit
  versions and contracts) and the compatibility line used in GitHub Release
  notes.
- CI rejects a plan where a package implements a protocol major the released
  application does not support.

## Skills and evaluations

- `skills/VERSION` holds the skills version.
- Every version slot in skill text declares its unit: image and chart slots
  follow `gauntlet`, npm slots their packages, PHP slots `php-core`, Maven
  slots `spring-boot-starter`. The release text slot catalog in
  `release-model.mjs` becomes per unit.
- When a pinned unit is in a plan, `skills` gets a cascade patch.
  `release:prepare` rewrites the slots, re-binds evaluation hashes with the
  existing `scripts/skills` tooling and appends a standard entry to a
  "Re-binding log" section of each `EVALUATING.md` (re-bound without new
  model samples; content integrity, not behaviour).
- `prepare-fixture.mjs` and its tests read candidate versions from manifests
  instead of hard-coded literals. The forward Node Compose fixture stays
  pinned to the version named in its frozen prompt.

## Migration

- Create baseline unit tags at the v0.1.8 release commit `e3f80e5`
  (`protocol-v0.1.8`, `skills-v0.1.8`, and so on; `v0.1.8` already exists).
  Tags only: no new GitHub Releases, nothing republished.
- Add `skills/VERSION`, `packages/java/core/VERSION` and
  `packages/java/spring-boot-starter/VERSION` at 0.1.8.
- Replace `VERSION`-equals-everything checks (`version.mjs --check`,
  `check-docs`, Helm tests, consumer tests) with per-unit checks. Helm tests
  read the version from `Chart.yaml` instead of hard-coding it.

## Documentation

- Rewrite `docs/releases/releasing.md` for change files, preparation,
  release-set tags and per-unit releases. Add the prerequisites found during
  0.1.8: `pnpm build` before the dry run, pnpm 11.24 on `PATH`, a Docker
  builder that can export images.
- `docs/releases/installing-packages.md`: generated table of current unit
  versions.
- `docs/releases/upgrading.md`: remove the stale "exact 0.1.1 artifacts".
- `CONTRIBUTING.md`: how to write change files and when `none` applies.
- `docs/reference/compatibility.md`: generated.

## Testing

- Unit tests: change file parsing and validation; bump and cascade
  computation; plan generation and order; manifest rewriting with rollback
  per ecosystem; per-unit inventories; `release:changes --check` against
  sample diffs; compatibility rejection.
- Integration: `release:dry-run --plan` for three plans: dashboard only
  (`gauntlet`, `skills`), a `protocol` change with full cascade, and
  `php-core` only.
- The existing release test suite (`pnpm release:test`) stays green, adapted
  to units.

## Out of scope

A 1.0 versioning policy, changing registries, deriving versions from
conventional commits, publishing private packages (`widget-loader`,
`widget-channel`, apps).
