#!/usr/bin/env bash
# Publishes and releases the clean package units (npm, Maven, Composer) of a staged release set, one
# at a time in dependency order: publish the unit's single destination, verify it, then tag and
# release it through release-unit.sh before the next unit starts.
#
# Usage: publish-package-units.sh RELEASE_DIRECTORY 3<npm-token 4<php-core-deploy-key 5<symfony-bundle-deploy-key
# Environment: PACKAGE_UNITS (dependency order), NPM_UNITS, MAVEN_UNITS, COMPOSER_UNITS, GH_TOKEN,
# GITHUB_ACTOR, GITHUB_REPOSITORY, GITHUB_SHA, RUNNER_TEMP, GAUNTLET_USE_REMOTE_RECEIPT.
#
# The secrets arrive only on file descriptors 3, 4 and 5, never in this process's environment, so no
# process can read them from its initial environment. They are read before anything is spawned, kept in
# unexported variables, and given to their own publish command alone as a per-command assignment;
# those commands also run without GH_TOKEN.
set -euo pipefail

NPM_SECRET=""
CORE_KEY=""
BUNDLE_KEY=""
IFS= read -r -d '' NPM_SECRET <&3 || true
exec 3<&-
IFS= read -r -d '' CORE_KEY <&4 || true
exec 4<&-
IFS= read -r -d '' BUNDLE_KEY <&5 || true
exec 5<&-

if [ "$#" -ne 1 ] || [ "${1#/}" = "$1" ]; then
  echo "Usage: publish-package-units.sh RELEASE_DIRECTORY 3<npm-token 4<php-core-deploy-key 5<symfony-bundle-deploy-key" >&2
  exit 2
fi
RELEASE_DIRECTORY="$1"
: "${PACKAGE_UNITS:?}" "${GH_TOKEN:?}" "${GITHUB_ACTOR:?}" "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}"
NPM_UNITS="${NPM_UNITS:-}"
MAVEN_UNITS="${MAVEN_UNITS:-}"
COMPOSER_UNITS="${COMPOSER_UNITS:-}"
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

for UNIT in $PACKAGE_UNITS; do
  if [[ " $NPM_UNITS " == *" $UNIT "* ]]; then
    PACKAGE="$(node scripts/release/release-set.mjs artifact --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT")"
    NODE_AUTH_TOKEN="$NPM_SECRET" env -u GH_TOKEN npm publish "$PACKAGE" --registry=https://registry.npmjs.org/ --access public
  elif [[ " $MAVEN_UNITS " == *" $UNIT "* ]]; then
    case "$UNIT" in
      java-core) TASK=":core:publish" ;;
      spring-boot-starter) TASK=":spring-boot-starter:publish" ;;
      *) exit 1 ;;
    esac
    ORG_GRADLE_PROJECT_gauntletRemotePublishing=true \
      ORG_GRADLE_PROJECT_gauntletRemoteUsername="$GITHUB_ACTOR" \
      ORG_GRADLE_PROJECT_gauntletRemotePassword="$GH_TOKEN" \
      packages/java/gradlew --no-daemon --no-configuration-cache --console=plain -p packages/java "$TASK"
  elif [[ " $COMPOSER_UNITS " == *" $UNIT "* ]]; then
    case "$UNIT" in
      php-core) COMPOSER_SPLIT_CORE_DEPLOY_KEY="$CORE_KEY" env -u GH_TOKEN node scripts/release/publish-composer.mjs \
        --release-directory "$RELEASE_DIRECTORY" --source-commit "$GITHUB_SHA" --unit "$UNIT" ;;
      symfony-bundle) COMPOSER_SPLIT_BUNDLE_DEPLOY_KEY="$BUNDLE_KEY" env -u GH_TOKEN node scripts/release/publish-composer.mjs \
        --release-directory "$RELEASE_DIRECTORY" --source-commit "$GITHUB_SHA" --unit "$UNIT" ;;
      *) exit 1 ;;
    esac
  else
    exit 1
  fi
  node scripts/release/check-published.mjs --release-directory "$RELEASE_DIRECTORY" \
    --source-commit "$GITHUB_SHA" --unit "$UNIT" --require-identical > "$RUNNER_TEMP/published-$UNIT.json"
  node scripts/release/release-set.mjs require-state --state-file "$RUNNER_TEMP/published-$UNIT.json" --unit "$UNIT" --state published-artifacts-identical
  bash scripts/release/release-unit.sh "$RELEASE_DIRECTORY" "$UNIT"
done
