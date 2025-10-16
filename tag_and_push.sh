#!/usr/bin/env bash
set -euo pipefail

# tag_and_push.sh
# - Calculates a new semver tag (default: patch bump), tags the repo,
#   builds multi-arch images, pushes to Docker Hub, and pushes git + tags.
#
# Usage:
#   tag_and_push.sh [patch|minor|major|vX.Y.Z]
#
# Env overrides:
#   DOCKER_REPO   Docker Hub repo (default: apetersson/chargecaster)
#   PLATFORMS     Target platforms (default: linux/amd64,linux/arm64)
#   GIT_REMOTE    Git remote to push (default: origin)

DOCKER_REPO=${DOCKER_REPO:-apetersson/chargecaster}
PLATFORMS=${PLATFORMS:-linux/amd64,linux/arm64}
GIT_REMOTE=${GIT_REMOTE:-origin}

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

echo "Releasing $NEW_TAG (from $CURRENT_BRANCH) to $DOCKER_REPO"

# Create annotated tag
git tag -a "$NEW_TAG" -m "Release $NEW_TAG"

# Ensure buildx is available and a builder is selected
if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx not available. Please install Docker Buildx." >&2
  exit 4
fi

# Try to bootstrap an existing builder; if none, create one
if ! docker buildx inspect >/dev/null 2>&1; then
  docker buildx create --use --name chargecaster-builder >/dev/null
fi
docker buildx inspect --bootstrap >/dev/null

echo "Building and pushing multi-arch images…"
docker buildx build \
  --platform "$PLATFORMS" \
  -t "$DOCKER_REPO:$NEW_TAG" \
  -t "$DOCKER_REPO:latest" \
  . --push

echo "Pushing git branch and tags to $GIT_REMOTE…"
git push "$GIT_REMOTE" "$CURRENT_BRANCH"
git push "$GIT_REMOTE" "$NEW_TAG"

echo "Done. Released $NEW_TAG"
