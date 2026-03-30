#!/usr/bin/env bash
set -euo pipefail

# tag_and_push.sh
# - Calculates a new semver tag (default: patch bump), tags the repo,
#   pushes git refs to GitLab, and lets GitLab CI publish the registry images.
#
# Usage:
#   tag_and_push.sh [patch|minor|major|vX.Y.Z]
#
# Env overrides:
#   REGISTRY_REPO Registry repo (default: registry.capacity.at/capacity-projects/chargecaster)
#   GIT_REMOTE    Git remote to push (default: gitlab)

REGISTRY_REPO=${REGISTRY_REPO:-registry.capacity.at/capacity-projects/chargecaster}
GIT_REMOTE=${GIT_REMOTE:-gitlab}

get_latest_tag() {
  git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"
}

increment_version() {
  local current=$1; local part=$2
  local v=${current#v}
  IFS='.' read -r major minor patch <<<"$v"
  major=${major:-0}; minor=${minor:-0}; patch=${patch:-0}
  case "$part" in
    major) major=$((major+1)); minor=0; patch=0;;
    minor) minor=$((minor+1)); patch=0;;
    patch) patch=$((patch+1));;
    *) echo "Unknown bump: $part" >&2; exit 1;;
  esac
  echo "v${major}.${minor}.${patch}"
}

arg=${1:-patch}
if [[ $arg =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_TAG="$arg"
else
  LATEST_TAG=$(get_latest_tag)
  case "$arg" in
    major|minor|patch) NEW_TAG=$(increment_version "$LATEST_TAG" "$arg");;
    *) echo "Usage: $0 [patch|minor|major|vX.Y.Z]" >&2; exit 2;;
  esac
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree not clean. Commit or stash changes first." >&2
  exit 3
fi

echo "Releasing $NEW_TAG (from $CURRENT_BRANCH)"
echo "Git remote: $GIT_REMOTE"
echo "Registry repo: $REGISTRY_REPO"

# Create annotated tag
git tag -a "$NEW_TAG" -m "Release $NEW_TAG"

echo "Pushing git branch and tags to ${GIT_REMOTE}..."
git push "${GIT_REMOTE}" "${CURRENT_BRANCH}"
git push "${GIT_REMOTE}" "${NEW_TAG}"

cat <<EOF
Done. Pushed release $NEW_TAG to ${GIT_REMOTE}.

GitLab CI will publish:
  - ${REGISTRY_REPO}:${NEW_TAG}
  - ${REGISTRY_REPO}:$(git rev-parse --short HEAD)

The main-branch pipeline also keeps these moving tags updated:
  - ${REGISTRY_REPO}:main
  - ${REGISTRY_REPO}:latest
EOF
