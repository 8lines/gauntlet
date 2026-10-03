# Release runbook

The release workflow publishes only an exact stable tag whose value equals
`VERSION`. Local verification and staging are non-publishing; creating or
pushing a tag is the explicit publication trigger.

## Preconditions

- `main` contains the reviewed change and has no local modifications;
- `VERSION`, npm/Composer/Maven manifests, Helm metadata, image labels, and
  documentation all agree;
- CI passes the Node.js, PHP/Symfony, Java/Spring, conformance, dashboard,
  deployment, security, package-consumer, skill, and documentation gates;
- the protected `release` environment, its secrets, and every public
  destination are configured as described in
  [repository configuration](#repository-configuration);
- GitHub release immutability is enabled for the repository before the tag is
  pushed (the workflow refuses to trust a published release unless GitHub marks
  that individual release immutable);
- the release operator has reviewed `CHANGELOG.md`, the staged inventory,
  provenance limitations, SBOMs, and vulnerability reports;
- no target application or deployment is being enabled as part of publishing.

## Release units

Gauntlet is released as thirteen units, each with its own version and its own
tag: `gauntlet` (the application, tag `v<version>`), `protocol`,
`dashboard-client`, `typescript-core`, `typescript-node`, `next-adapter`,
`conformance-runner`, `widget`, `php-core`, `symfony-bundle`, `java-core`,
`spring-boot-starter`, and `skills` (tag `<unit>-v<version>`). The catalog lives
in `scripts/release/units.mjs`, and every unit reads its version from its own
manifest or `VERSION` file.

Until plan-driven publishing lands, the release workflow still publishes one
lockstep release, so every unit version must equal the root `VERSION`. The
lockstep guard (`pnpm release:version --check`) fails otherwise.

Each unit needs a baseline tag so later releases can be compared against it.
Preview the tags that would be created for the last lockstep release, then
create them locally; the command never pushes:

```sh
pnpm release:baseline-tags --commit <release-commit>
pnpm release:baseline-tags --commit <release-commit> --apply
```

Units whose own version file did not yet exist at that commit take the root
`VERSION` from it, and a baseline tag that already points at another commit is
an error.

## Repository configuration

The `release` workflow (`.github/workflows/release.yml`) publishes from a
single `publish` job that runs in the protected GitHub environment named
`release`. Configure these once, before the first tag:

| Setting | Purpose |
| --- | --- |
| `release` environment | Holds the secrets below; restrict it to tag deployments and require reviewer approval. |
| `NPM_TOKEN` secret | npm automation or granular access token that may publish the `@8lines` scope on `https://registry.npmjs.org`. Only the "Publish staged npm packages" step receives it, as `NODE_AUTH_TOKEN`. |
| `COMPOSER_SPLIT_CORE_DEPLOY_KEY` secret | Private half of a passphrase-less OpenSSH deploy key with write access on `github.com/8lines/gauntlet-php-core`. |
| `COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY` secret | Private half of a passphrase-less OpenSSH deploy key with write access on `github.com/8lines/gauntlet-symfony-bundle`. |

The workflow's own `GITHUB_TOKEN` pushes the image and chart to
`ghcr.io/8lines`, publishes the Maven artifacts to GitHub Packages, and creates
the GitHub Release. npm packages are published without provenance: npm accepts
provenance attestations only from GitHub-hosted runners, and the `publish` job
runs on a self-hosted Blacksmith runner. No other job receives a secret.

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
PLAYWRIGHT_BROWSER_CHANNEL=chromium pnpm release:dry-run
```

`PLAYWRIGHT_BROWSER_CHANNEL` is deliberately restricted to `chromium` or
`chrome`. Use `chromium` with the pinned Playwright download above. A machine
with a separately managed, compatible Google Chrome installation may instead
run `PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm release:dry-run`. The browser
preflight must finish successfully before starting the long rehearsal.

The command rejects a dirty source tree, validates the exact version, runs the
complete repository verification, stages `.artifacts/release/0.1.8`, exercises
a uniquely named loopback-only OCI registry, verifies package consumers and
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
node scripts/release/verify-inventory.mjs --release-root "$PWD/.artifacts/release/0.1.8"
```

The generated directory is reproducible evidence, not a credential store.

## Trigger

Create an annotated tag only after the clean dry-run and code review. The tag
must point at a commit contained in `main`:

```sh
git tag -a v0.1.8 -m "Gauntlet 0.1.8"
git show --no-patch --verify v0.1.8
git push origin v0.1.8
```

The tag-triggered workflow repeats all gates. Its publication job first probes
every fixed destination. It mutates nothing when all artifacts are already
byte/commit-identical and fails closed for a partial release, conflicting
version, unknown destination, or mismatched content. It publishes only staged
artifacts and commit-bound image metadata.

The GitHub Release is a closed nine-asset set: the standalone Compose archive,
AI skills archive, Helm chart, release manifest, publication receipt,
`SHA256SUMS`, unsigned provenance record, and both platform SBOMs. An identical
rerun and the post-creation gate download every asset with bounded reads and
require its bytes to match the commit-bound staged evidence; missing, extra, or
same-name modified assets fail closed.
The release is created as a draft, all nine uploaded assets are compared to the
local finalized bytes, and only then is the draft published. A failed upload or
draft verification therefore cannot expose a partial public release. The final
gate requires GitHub to report the published release as immutable and repeats
the full byte comparison.

For an identical rerun, an immutable remote receipt can supply publication-only
metadata that does not exist in a fresh stage. It never replaces source-bound
evidence: its image digest must equal the descriptor in the staged OCI archive,
the chart package must match the staged bytes, and the receipt remains bound to
the staged manifest and source commit.

## Verify the published release

Record the workflow run URL and immutable identities for all artifacts:

- npm package version and integrity;
- annotated Composer tag target for both split repositories;
- Maven POM/JAR/checksum identities;
- multi-platform image digest plus attestations;
- Helm chart digest;
- release archive and `SHA256SUMS`.

Run clean consumers through each public registry (and GitHub Packages for
Maven) and deploy the exact image or chart into an isolated non-production
validation environment. Do not retag or overwrite `0.1.8`. A correction
requires a new version.

## Failure handling

A failure after staging deliberately retains
`.artifacts/release/0.1.8` for inspection. After preserving any evidence you
need, discard only that verified, commit-bound staged directory with:

```sh
pnpm release:discard-staged --release-root .artifacts/release/0.1.8 \
  --source-commit "$(git rev-parse HEAD)"
```

The helper verifies the closed 19-artifact inventory, every checksum, the
source commit, path ownership, and directory identity before an atomic
quarantine-and-delete. It refuses unknown, modified, symlinked, or out-of-tree
paths. Never replace this command with a broad recursive deletion. A successful
dry-run remains release evidence and should not be discarded before review.

Do not manually fill a partially published release, or manually complete and
publish a failed draft release. Preserve the workflow logs and remote state for
investigation. A public partial release is rejected by the fixed-destination
preflight; if any destination differs, stop and choose a new version. Never
delete or rewrite an already consumed tag as an ordinary retry mechanism.

Publishing does not authorize deployment. Operators separately follow the
[upgrade](upgrading.md) and [non-production safety](../safety/non-production-boundary.md)
runbooks.
