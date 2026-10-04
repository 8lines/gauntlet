#!/usr/bin/env bash
# Tags and releases one published unit of a staged release set, right after that unit's registry
# artifacts were published and verified (the skills unit has no registry destination):
#   finalize its publication receipt, create its unit tag through the GitHub API (or require an
#   existing tag to point at this commit), create its GitHub Release as a draft, compare the draft's
#   assets byte for byte with the finalized files, publish the draft, and require the public release
#   to be immutable and identical through its own remote receipt.
# Only the gauntlet release is marked Latest. Nothing here pushes with git; tags created through the
# API with GITHUB_TOKEN do not start workflows.
#
# Usage: release-unit.sh RELEASE_DIRECTORY UNIT
# Environment: GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, RUNNER_TEMP; for gauntlet also IMAGE_DIGEST and
# CHART_DIGEST (the pushed image and chart digests), which every other unit must leave empty.
set -euo pipefail

if [ "$#" -ne 2 ] || [ "${1#/}" = "$1" ] || [ -z "$2" ]; then
  echo "Usage: release-unit.sh RELEASE_DIRECTORY UNIT" >&2
  exit 2
fi
RELEASE_DIRECTORY="$1"
UNIT="$2"
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}"
IMAGE_DIGEST="${IMAGE_DIGEST:-}"
CHART_DIGEST="${CHART_DIGEST:-}"
if [ "$UNIT" = "gauntlet" ]; then
  test -n "$IMAGE_DIGEST"
  test -n "$CHART_DIGEST"
else
  test -z "$IMAGE_DIGEST"
  test -z "$CHART_DIGEST"
fi
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."

TAG="$(node scripts/release/release-set.mjs field --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --field tag)"
TITLE="$(node scripts/release/release-set.mjs field --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --field title)"
PREVIOUS_TAG="$(node scripts/release/release-set.mjs field --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --field previous-tag)"

# A draft left by a failed run is not public, but creating a second one would leave two drafts for
# one tag; the operator deletes the stale draft before re-running.
DRAFT_TAGS="$(gh api --paginate "repos/$GITHUB_REPOSITORY/releases" --jq '.[] | select(.draft) | .tag_name')"
if grep -Fxq -- "$TAG" <<< "$DRAFT_TAGS"; then
  echo "A draft GitHub Release for $TAG already exists from an earlier run; delete that draft, then re-run the release set" >&2
  exit 1
fi

LATEST="--latest=false"
if [ "$UNIT" = "gauntlet" ]; then
  node scripts/release/check-published.mjs --finalize "$RELEASE_DIRECTORY" --unit "$UNIT" \
    --image-digest "$IMAGE_DIGEST" --chart-digest "$CHART_DIGEST"
  LATEST="--latest"
else
  node scripts/release/check-published.mjs --finalize "$RELEASE_DIRECTORY" --unit "$UNIT"
fi

if git rev-parse -q --verify "refs/tags/$TAG" > /dev/null; then
  test "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$GITHUB_SHA"
else
  TAG_OBJECT="$(gh api "repos/$GITHUB_REPOSITORY/git/tags" -f tag="$TAG" -f message="$TITLE" -f object="$GITHUB_SHA" -f type=commit --jq .sha)"
  gh api "repos/$GITHUB_REPOSITORY/git/refs" -f ref="refs/tags/$TAG" -f sha="$TAG_OBJECT" > /dev/null
fi

NOTES="$RUNNER_TEMP/release-notes-$UNIT.md"
NOTES_MODE="$(node scripts/release/release-set.mjs notes --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" --output "$NOTES")"
NOTES_ARGS=(--notes-file "$NOTES")
if [ "$NOTES_MODE" = "generated" ]; then
  NOTES_ARGS+=(--generate-notes)
  if [ -n "$PREVIOUS_TAG" ]; then NOTES_ARGS+=(--notes-start-tag "$PREVIOUS_TAG"); fi
fi
node scripts/release/release-set.mjs assets --release-directory "$RELEASE_DIRECTORY" --unit "$UNIT" > "$RUNNER_TEMP/assets-$UNIT.txt"
mapfile -t ASSETS < "$RUNNER_TEMP/assets-$UNIT.txt"
test "${#ASSETS[@]}" -ge 4

gh release create "$TAG" --draft --verify-tag --title "$TITLE" "$LATEST" "${NOTES_ARGS[@]}" "${ASSETS[@]}"
node scripts/release/check-published.mjs --release-directory "$RELEASE_DIRECTORY" \
  --source-commit "$GITHUB_SHA" --unit "$UNIT" --require-draft-identical
gh release edit "$TAG" --draft=false "$LATEST"
GAUNTLET_EXPECTED_IMAGE_DIGEST="$IMAGE_DIGEST" GAUNTLET_EXPECTED_CHART_DIGEST="$CHART_DIGEST" GAUNTLET_USE_REMOTE_RECEIPT=true \
  node scripts/release/check-published.mjs --release-directory "$RELEASE_DIRECTORY" \
  --source-commit "$GITHUB_SHA" --unit "$UNIT" --require-identical > "$RUNNER_TEMP/released-$UNIT.json"
node scripts/release/release-set.mjs require-state --state-file "$RUNNER_TEMP/released-$UNIT.json" --unit "$UNIT" --state already-identical
