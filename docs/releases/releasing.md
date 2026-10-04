# Release runbook

The release workflow publishes one release set: the units listed in the
committed release plan `.release/plan.json`, triggered by one `release-*` tag.
Local verification and staging are non-publishing; pushing a release-set tag is
the explicit publication trigger.

## Preconditions

- `main` contains the reviewed change and has no local modifications;
- the release pull request prepared by `pnpm release:prepare` is merged, so
  every unit's version slots agree with that unit's own manifest or `VERSION`
  file and `.release/plan.json` names exactly the units whose version moved;
- the release machine has pnpm 11.24 on `PATH` (`corepack enable` selects the
  version pinned in `package.json`), Docker with a builder that can export images
  (the docker-container Buildx builder CI configures), and network access for
  Composer when a PHP unit is released. Run `pnpm build` before any dry run,
  because the dry run packs the built packages;
- CI passes the Node.js, PHP/Symfony, Java/Spring, conformance, dashboard,
  widget, widget-panel, deployment, skills, security, package-consumer, and
  documentation gates;
- the protected `release` environment, its secrets, and every public
  destination are configured as described in
  [repository configuration](#repository-configuration);
- GitHub release immutability is enabled for the repository before the tag is
  pushed (the workflow refuses to trust a published release unless GitHub marks
  that individual release immutable);
- the release operator has reviewed the changelog sections of every released
  unit, the staged inventory, provenance limitations, SBOMs, and vulnerability
  reports;
- no target application or deployment is being enabled as part of publishing.

## Release units

Gauntlet is released as thirteen units, each with its own version and its own
tag: `gauntlet` (the application, tag `v<version>`), `protocol`,
`dashboard-client`, `typescript-core`, `typescript-node`, `next-adapter`,
`conformance-runner`, `widget`, `php-core`, `symfony-bundle`, `java-core`,
`spring-boot-starter`, and `skills` (tag `<unit>-v<version>`). The catalog lives
in `scripts/release/units.mjs`, and every unit reads its version from its own
manifest or `VERSION` file.

Units are versioned and released independently. `pnpm release:version --check`
validates every slot against its own unit, and `--plan .release/plan.json` also
checks the plan against the manifests.
`node scripts/release/version.mjs --set-unit <unit> X.Y.Z` moves one unit and
every slot bound to it, including the unit's version cell in
`docs/reference/compatibility.md`. A moved slot in a bound skill-evaluation
input (a skill reference under `skills/`, or a path listed in
`skill-evals/*/external-inputs.json`) needs the receipts re-bound:
`pnpm skills:rebind --reason "<one sentence>"`, committed with the move.

Each unit needs a baseline tag so later releases can be compared against it.
The baseline is `e3f80e5`, the v0.1.8 release commit. Preview the tags that
would be created, then create them locally:

```sh
pnpm release:baseline-tags --commit e3f80e5
pnpm release:baseline-tags --commit e3f80e5 --apply
```

The command only creates local tags and never pushes. It never creates the
`gauntlet` tag either: `v<version>` must already exist and point at the given
commit, otherwise the command fails with `baseline requires existing tag
v<version> at <sha>` and creates nothing. Units whose own version file did not
yet exist at that commit take the root `VERSION` from it, and a baseline tag
that already points at another commit is an error.

Push unit tags by name (`git push origin <tag>...`), never with a blanket
`git push --tags`.
Only `release-*` tags start the release workflow; unit tags never do.

## Change files

Every pull request that changes what a unit releases carries a change file,
`.changes/<name>.md`, written as described in
[CONTRIBUTING.md](../../CONTRIBUTING.md#change-files). The required `changes`
check runs `pnpm release:changes --check --base <base commit>`: it maps the
changed paths to the units that release them (tests, READMEs and changelogs
excluded) and fails when a touched unit is not named by a change file added or
edited in the same pull request. A release pull request is covered by its
`.release/plan.json` for the units it plans, and only for those. To run the
check locally, commit your change files and run `git fetch origin main` first:
`pnpm release:changes --check` compares the committed `HEAD` with your local
`origin/main`, so uncommitted change files and a stale `origin/main` give a
different answer than CI.

Dependency-update pull requests, such as Dependabot's, that touch a unit's
released paths fail the `changes` check until a maintainer adds a change file
to the pull request: `patch` for a dependency change that ships with the unit,
or `none` with the reason when it does not.

## Prepare a release

On a branch from an up-to-date `main`, with every change file merged:

```sh
git switch main
git pull --ff-only
git fetch --tags origin
git switch -c release/YYYY-MM-DD
pnpm install --frozen-lockfile --package-import-method=copy
pnpm release:prepare
```

`pnpm release:prepare` reads every change file, takes the highest bump per unit
and gives every unit that depends on a released unit at least a patch release,
whose changelog says "Updated `<unit>` to X.Y.Z." for each released dependency.
`none` change files release nothing. Then, all or nothing, it:

1. writes every version and version slot with the span-preserving rewriter of
   `version.mjs --set-unit`: manifests, the Symfony bundle's `^` constraint on
   PHP Core and the Symfony example's constraints, consumer manifests, the
   Gradle consumer build and lockfile, documentation, skill references and the
   [current versions](installing-packages.md#current-versions) table;
2. re-pins the Composer locks of `packages/php/core`,
   `packages/php/symfony-bundle` and `examples/symfony` with the pinned
   `composer:2` image when a PHP unit is released, and accepts the result only
   when Composer changed nothing but the Gauntlet path packages and the content
   hash;
3. inserts a dated section into each released unit's `CHANGELOG.md` below its
   empty `## Unreleased` heading;
4. records the released units' contracts in `docs/reference/compatibility.md`;
5. deletes the consumed change files and writes `.release/plan.json` with the
   units, their from and to versions, the dependency order and the consumed
   change files;
6. re-binds the skill evaluation receipts (`pnpm skills:rebind`) when a bound
   input changed and adds an entry to the Re-binding log of each affected
   `EVALUATING.md`: the hashes match the current bytes, without new model
   samples, which confirms content integrity, not behaviour;
7. checks the version slots, the plan against manifests and tags, and the skill
   receipts, and prints one JSON summary.

On any failure it restores every tracked file and removes the files it created,
so the branch is as it was. It refuses to start on `main` or a detached
`HEAD`, with modified tracked files, with uncommitted change files, without
change files, with only `none` change files, when a changelog has hand-written
entries under `## Unreleased` or already has a section for the new version
(every changelog is checked before anything is written or Docker runs), when a
unit is not at its latest tag (fetch the tags, or release the plan that is
already prepared), and when the plan would release a package that implements a
contract major the released application does not support.

Review `git status`, the changelog sections and `.release/plan.json`, commit
everything as one release pull request and let CI rehearse it: for a pull
request that changes `.release/plan.json`, the `release-metadata` job runs
`node scripts/release/plan.mjs --check` and `pnpm release:dry-run --plan
.release/plan.json` instead of the all-units rehearsal. To rehearse the same
plan locally, run `pnpm build` and then
`PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run --plan .release/plan.json`.

## Repository configuration

The `release` workflow (`.github/workflows/release.yml`) publishes from a
single `publish` job that runs in the protected GitHub environment named
`release`. Configure these once, before the first tag:

| Setting | Purpose |
| --- | --- |
| `release` environment | Holds the secrets below; restrict it to tag deployments and require reviewer approval. |
| `NPM_TOKEN` secret | npm automation or granular access token that may publish the `@8lines` scope on `https://registry.npmjs.org`. Only the "Publish and release package units" step receives it. That step replaces its shell with `scripts/release/publish-package-units.sh` through `exec env -u …`, handing the token over on a file descriptor instead of the environment, so no other process of the job can read it from a process environment. The script gives it only to `npm publish`, as `NODE_AUTH_TOKEN`, which runs without `GH_TOKEN`. |
| `COMPOSER_SPLIT_CORE_DEPLOY_KEY` secret | Private half of a passphrase-less OpenSSH deploy key with write access on `github.com/8lines/gauntlet-php-core`. It reaches the package script the same way, on its own file descriptor, and only the `php-core` publication command sees it, without `GH_TOKEN`. |
| `COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY` secret | Private half of a passphrase-less OpenSSH deploy key with write access on `github.com/8lines/gauntlet-symfony-bundle`. It reaches the package script the same way, on its own file descriptor, and only the `symfony-bundle` publication command sees it, without `GH_TOKEN`. |

The workflow's own `GITHUB_TOKEN` pushes the image and chart to
`ghcr.io/8lines`, publishes the Maven artifacts to GitHub Packages, and creates
each unit's tag and GitHub Release. npm packages are published without
provenance: npm accepts provenance attestations only from GitHub-hosted
runners, and the `publish` job runs on a self-hosted Blacksmith runner. No other job receives a secret.

Configure a ruleset or branch protection rule on `main` that requires the
`changes` check and the other CI jobs to pass before a pull request merges.
Without it, the `changes` check only reports: a pull request that touches a
unit's released paths could still merge without a change file. Requiring pull
requests also blocks direct pushes to `main`, so decide on bypass rules for
maintainers when you set it up.

Outside the repository:

- create the public split repositories `8lines/gauntlet-php-core` and
  `8lines/gauntlet-symfony-bundle`, add one write-enabled deploy key to each
  (each key is used only for its own repository), and register both on
  Packagist with automatic updates on push;
- make the `ghcr.io/8lines/gauntlet` image and the
  `ghcr.io/8lines/charts/gauntlet` chart packages public after their first
  publication, so they can be pulled anonymously;
- ensure the npm organization `8lines` exists and the token's account may
  publish its packages publicly.

The Composer publisher validates each deploy key before any network access,
writes it only for the push as a `0600` file next to a `known_hosts` file
pinned to GitHub's published SSH host keys, pushes over SSH with
`IdentitiesOnly=yes` and strict host key checking, deletes both files, and then
verifies the pushed branch and annotated tag anonymously over HTTPS. If GitHub
rotates its SSH host keys, re-pin `GITHUB_SSH_KNOWN_HOSTS` in
`scripts/release/publish-composer.mjs` from `https://api.github.com/meta`
before releasing.

## Local rehearsal

From a clean checkout of the candidate commit:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run
```

The full form is
`pnpm release:dry-run [--plan .release/plan.json] [--release-set ID]`.
`--plan` names the release plan to rehearse; without it the dry run uses
`.release/plan.json` when that file exists and every unit otherwise.
`--release-set` names the staged release set; without it the set is
`local-<first 12 characters of HEAD>`. The release workflow passes the
`release-*` tag it runs for, so a local rehearsal normally omits the flag.
CI rehearses every unit, whatever a committed plan lists, unless the pull
request changes `.release/plan.json`: it writes
`.artifacts/ci/all-units-plan.json` with
`node scripts/release/plan.mjs --write-all-units .artifacts/ci/all-units-plan.json`
and passes that file as `--plan`. A release pull request, which changes
`.release/plan.json`, rehearses exactly that plan (see
[Prepare a release](#prepare-a-release)). The release workflow rehearses exactly
its `.release/plan.json`.

`PLAYWRIGHT_BROWSER_CHANNEL` is deliberately restricted to `chromium` or
`chrome`. Use `chromium` with the pinned Playwright download above. A machine
with a separately managed, compatible Google Chrome installation may instead
run `PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm release:dry-run`. The browser
preflight must finish successfully before starting the long rehearsal.

The command rejects a dirty source tree, validates the exact versions, runs the
verification gates of the planned units, stages
`.artifacts/release/local-<first 12 characters of HEAD>` (the release set named
for the source commit), exercises a uniquely named loopback-only OCI registry
when the plan releases the application, verifies package consumers and
inventory hashes, and removes only resources it created. It never contacts a
GitHub publishing endpoint.

The local registry exercise pushes and pulls only the host-platform native
image archive. The separately staged multi-platform OCI archive is deeply
validated for `linux/amd64` and `linux/arm64` during staging, but is not pushed
or pulled by this local registry rehearsal. The structured result reports the
native-image digest and the Helm chart digest; the chart is pulled back by its
exact version. The release workflow later copies the exact staged
multi-platform OCI archive to the registry with digest preservation and verifies
that the remote digest still equals the staged descriptor.

Review:

```sh
git status --short
node scripts/release/version.mjs --check
node scripts/release/verify-inventory.mjs --release-root "$PWD/.artifacts/release/local-$(git rev-parse HEAD | cut -c1-12)"
```

The generated directory is reproducible evidence, not a credential store.

## Trigger

`pnpm release:prepare` writes `.release/plan.json` (see
[Prepare a release](#prepare-a-release)). `pnpm release:plan` remains for
versions moved by hand with `version.mjs --set-unit`: it compares every unit's
version with its latest tag and writes the plan. It reads the local tag view,
so fetch the remote tags first; it refuses to write an empty plan when no unit
version moved:

```sh
git fetch --tags origin
pnpm release:plan
```

Commit the plan together with the version changes it describes, and review it
with the change.

Create the release-set tag only after the clean dry-run, code review, and
merge. The tag must point at a commit contained in `main`. Fetch the remote tags
first, because `pnpm release:tag` numbers the set and checks the plan against
the local tag view:

```sh
git switch main
git pull --ff-only
git fetch --tags origin && pnpm release:tag
git push origin refs/tags/release-YYYY-MM-DD.N
```

`pnpm release:tag` creates the annotated tag `release-YYYY-MM-DD.N` on the
merge commit locally and prints the exact push command; it never pushes. It
refuses a plan that does not match the manifests and tags, and a
`docs/reference/compatibility.md` that does not record every unit at its
manifest version or that the plan would break.
Pushing that one tag starts one workflow run. The run:

1. checks that the tag is annotated, that its commit is contained in `main`,
   and that `.release/plan.json` still matches the manifests, the tags and the
   compatibility ledger (`node scripts/release/plan.mjs --check`);
2. runs only the verification gates of the planned units;
3. repeats the dry run for exactly the planned units;
4. preflights each unit: every unit must be clean or already identical, and a
   partially published unit fails the run before anything is published;
5. publishes the clean units one at a time; each unit is tagged and
   released right after its own registry artifacts are published and
   verified: first the npm, Maven, and Composer units in dependency order
   (the "Publish and release package units" step), then the
   application (the commit-tagged image and its scan, the semantic image tag,
   and the Helm chart), then the skills, which have no registry destination;
6. releases each unit through `scripts/release/release-unit.sh`: it creates
   the unit tag, creates the release as a draft, compares its assets
   byte-for-byte with the local finalized files, publishes the draft, and
   verifies the published release again once GitHub reports it immutable.

Only the application release (`v<version>`) is marked Latest. Each release
carries its unit's assets, `release-manifest.json`, `publication-receipt.json`
and `SHA256SUMS`. The workflow creates unit tags through the GitHub API, and
those tags do not start another run.

Each release's notes are the unit's changelog section (or generated notes for a
unit without one), followed by its compatibility line from
`docs/reference/compatibility.md` and the release set.

The publication job mutates nothing for a unit when all artifacts are already
byte/commit-identical, and fails closed for a partial release, conflicting
version, unknown destination, or mismatched content. It publishes only staged
artifacts and commit-bound image metadata. An identical rerun and the
post-creation gate download every release asset with bounded reads and require
its bytes to match the commit-bound staged evidence; missing, extra, or
same-name modified assets fail closed. A failed upload or draft verification
therefore cannot expose a partial public release.

For an identical rerun, an immutable remote receipt can supply publication-only
metadata that does not exist in a fresh stage. It never replaces source-bound
evidence: its image digest must equal the descriptor in the staged OCI archive,
the chart package must match the staged bytes, and the receipt remains bound to
the staged manifest and source commit.

## Verify the published release

Record the workflow run URL. For each released unit, record the immutable
identities of its own destinations:

- an npm unit: its package version and integrity;
- a Composer unit: the annotated tag target in its split repository;
- a Maven unit: its POM/JAR/checksum identities;
- `gauntlet`: the multi-platform image digest plus attestations, and the Helm
  chart digest;
- every unit: its GitHub Release assets and `SHA256SUMS`.

Run clean consumers of each released package through its public registry (and
GitHub Packages for Maven), and deploy a released application image or chart
into an isolated non-production validation environment. Do not retag or
overwrite a released unit version. A correction requires a new version of that
unit.

## Failure handling

A failure after staging deliberately retains
`.artifacts/release/<set-id>` (for a local rehearsal,
`local-<first 12 characters of HEAD>`) for inspection. After preserving any
evidence you need, discard only that verified, commit-bound staged directory
with:

```sh
pnpm release:discard-staged --release-root .artifacts/release/<set-id> \
  --source-commit "$(git rev-parse HEAD)"
```

The helper verifies the closed per-plan inventory, every checksum, the
source commit, path ownership, and directory identity before an atomic
quarantine-and-delete. It refuses unknown, modified, symlinked, or out-of-tree
paths. Never replace this command with a broad recursive deletion. A successful
dry-run remains release evidence and should not be discarded before review.

Do not manually fill a partially published release, or manually complete and
publish a failed draft release. Preserve the workflow logs and remote state for
investigation. A public partial release is rejected by the fixed-destination
preflight; if any destination differs, stop and choose a new version for
that unit. Never delete or rewrite an already consumed tag as an ordinary retry
mechanism.

Re-running the same release-set tag completes the set only where nothing
public conflicts. Its preflight treats each unit independently:

- a unit already released by the failed run, with identical bytes, is
  `already-identical` and is skipped;
- a unit the failed run never pushed is `clean` and is published and released;
- a unit whose release step failed before anything of it became public is
  still `clean` and is released again. In practice this is only the
  release-only `skills` unit: a package unit or the application has already
  pushed its registry artifacts when its release step runs.

The re-run stays blocked by any unit that is pushed to its registry without a
published GitHub Release, and by a partially pushed application (for example
the commit-tagged image without the semantic tag or the chart). The preflight
reports such a unit as partially published and publishes nothing, so the
units that run never released stay unreleased too. Recover by giving the
blocked unit a new version (`node scripts/release/version.mjs --set-unit
<unit> X.Y.Z`), writing a new release plan (it also lists every unit still
unreleased), merging it, and creating a new release-set tag: a new version, a
new release plan and a new release-set tag.

A failed run can leave a stale draft GitHub Release. A draft is not public,
but the release script refuses to create a second draft for the same tag, so
the operator must delete the stale draft (after preserving its evidence) before
re-running. Never publish the stale draft by hand.

Publishing does not authorize deployment. Operators separately follow the
[upgrade](upgrading.md) and [non-production safety](../safety/non-production-boundary.md)
runbooks.
