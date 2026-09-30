# Installing Gauntlet packages

Gauntlet is open source under the Apache License 2.0, and every release is
published to public registries. Installing packages is separate from
application runtime configuration: never put registry credentials in
`config.yaml`, adapter URLs, Helm values, Compose `.env`, image labels, or
operation definitions.

| Artifact | Destination | Read access |
| --- | --- | --- |
| npm packages | `https://registry.npmjs.org`, scope `@8lines` | public, no authentication |
| Composer packages | Packagist: `8lines/gauntlet-php-core` and `8lines/gauntlet-symfony-bundle` | public, no authentication |
| Maven artifacts | `https://maven.pkg.github.com/8lines/gauntlet` | GitHub token with `read:packages` |
| image and Helm chart | `ghcr.io/8lines/gauntlet` and `oci://ghcr.io/8lines/charts/gauntlet` | public, anonymous pull |

Public packages do not change the deployment rules. Gauntlet v0.1 has no
authentication: keep the dashboard behind a private boundary or an
authenticating reverse proxy, keep every adapter route internal, and never
enable an adapter in production. See the
[non-production boundary](../safety/non-production-boundary.md).

## npm

Install exact versions from the public registry. No `.npmrc` scope mapping or
token is needed:

```sh
pnpm add @8lines/gauntlet-protocol@0.1.3 \
  @8lines/gauntlet-typescript-core@0.1.3 \
  @8lines/gauntlet-typescript-node@0.1.3
```

The published packages are `@8lines/gauntlet-protocol`,
`@8lines/gauntlet-dashboard-client`, `@8lines/gauntlet-typescript-core`,
`@8lines/gauntlet-typescript-node`, `@8lines/gauntlet-next-adapter`,
`@8lines/gauntlet-widget`, and `@8lines/gauntlet-conformance-runner`. They are
published from the tag-triggered release workflow; verify the registry
signatures in a consumer with `npm audit signatures`. They carry no npm
provenance attestation yet: npm accepts provenance only from GitHub-hosted
runners, and the release job runs on a self-hosted runner. Ensure the lockfile resolves Gauntlet packages from
`https://registry.npmjs.org` before committing it.

## Composer

The PHP packages are published on Packagist from the public split repositories
`8lines/gauntlet-php-core` and `8lines/gauntlet-symfony-bundle`, each tagged
with an annotated `v0.1.3`. No custom `repositories` entry, `auth.json`, or
`COMPOSER_AUTH` is needed:

```sh
composer require 8lines/gauntlet-symfony-bundle:0.1.3
```

The bundle requires the matching `8lines/gauntlet-php-core` release, which
Composer installs automatically. For a framework-neutral integration, require
`8lines/gauntlet-php-core:0.1.3` alone. Verify that `composer.lock` records the
expected package versions and source commits.

The split repositories are read-only release mirrors of
`packages/php/core` and `packages/php/symfony-bundle` in `8lines/gauntlet`;
contributions go to the monorepo.

## Maven

The Java packages remain on GitHub Packages. GitHub Packages requires
authentication for every Maven download, including public packages, so a
consumer needs a GitHub account and a personal access token (classic) with the
`read:packages` scope. Supply it from environment-backed CI configuration and
never commit the real username/token pair:

```kotlin
repositories {
    mavenCentral()
    maven {
        name = "gauntlet"
        url = uri("https://maven.pkg.github.com/8lines/gauntlet")
        credentials(PasswordCredentials::class)
    }
}
```

With this declaration Gradle reads `gauntletUsername` and `gauntletPassword`
from Gradle properties, for example `ORG_GRADLE_PROJECT_gauntletUsername` and
`ORG_GRADLE_PROJECT_gauntletPassword` in CI. For Maven, reference a
`settings.xml` server whose credentials come from the environment; the
repository ID used by the application and `settings.xml` must match.

Consume immutable coordinates:

```text
dev.eightlines.gauntlet:core:0.1.3
dev.eightlines.gauntlet:spring-boot-starter:0.1.3
```

Keep Gradle dependency verification and lock metadata enabled in the consumer.

## OCI image and chart

The image and the Helm chart are public, so pulling them needs no
`docker login`, `helm registry login`, or Kubernetes imagePullSecret:

```sh
docker pull ghcr.io/8lines/gauntlet:0.1.3
helm pull oci://ghcr.io/8lines/charts/gauntlet --version 0.1.3
```

Prefer an image digest in an operator-managed deployment. Pull the Helm chart
at exact version `0.1.3`, render that local archive, and install the same bytes.
A cluster that must pull through an authenticated mirror can still set the
chart's optional `imagePullSecrets` value; the chart never creates that Secret.
When a private mirror does need credentials, supply them without a token
argument, for example
`printf '%s' "$MIRROR_TOKEN" | docker login mirror.example.test --username "$MIRROR_USER" --password-stdin`.

## Credential hygiene

Only the GitHub Packages Maven repository and private mirrors need a
credential. Use a short-lived or narrowly scoped identity with read access
only, prefer CI secret storage or a platform credential helper, and do not
paste tokens into a shell command, issue, README, or committed configuration.
Rotate or revoke exposed credentials immediately, remove them from
logs/artifacts, and investigate the scope of access. Rewriting Git history does
not revoke a token.
