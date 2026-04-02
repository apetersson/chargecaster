# Dependency Overrides

This file documents the root `pnpm.overrides` in `package.json`.

Use overrides as temporary security pins after we have already tried the safer path:
1. update the direct dependency first
2. re-run `pnpm audit`
3. keep an override only if the vulnerable version is still pulled transitively

Whenever an override changes, re-run:

```bash
pnpm audit
pnpm run lint:all
pnpm run typecheck:all
pnpm run build:all
pnpm --dir backend test
```

## Active overrides

The current list is intentionally short. We re-checked every previous override one-by-one after the direct dependency bumps and removed the ones that no longer affected `pnpm audit`.

### `@nestjs/config>lodash = 4.18.1`
- Reason: `@nestjs/config@4.0.3` is already the latest published direct dependency we can use, but it still resolves `lodash@4.17.23` transitively without help.
- Advisories: `GHSA-r5fr-rjxr-66jc`, `GHSA-f23m-r3pf-42rh`
- How to remove it: once a published `@nestjs/config` release resolves `lodash@>=4.18.0` on its own, remove the override and re-check the audit.

### `@nestjs/core>path-to-regexp = 8.4.0`
- Reason: even after re-checking the override list against the latest published Nest patch, `@nestjs/core` still resolves `path-to-regexp@8.3.0` without help.
- Advisories: `GHSA-j3q9-mxjg-w52f`, `GHSA-27v5-c462-wpq7`
- How to remove it: update Nest once a release pulls in `path-to-regexp@>=8.4.0` without help, drop the override, and re-check the audit.

### `@nestjs/platform-fastify>path-to-regexp = 8.4.0`
- Reason: `pnpm audit` still traces the same `path-to-regexp` advisories through the backend's `@nestjs/platform-fastify` path, so we pin that edge explicitly as well.
- Advisories: `GHSA-j3q9-mxjg-w52f`, `GHSA-27v5-c462-wpq7`
- How to remove it: once Nest no longer needs the `@nestjs/core>path-to-regexp` pin, remove this companion pin too and confirm the audit stays green.

### `@nestjs/platform-fastify>fastify = 5.8.3`
- Reason: the backend now depends directly on `fastify@^5.8.4`, but `@nestjs/platform-fastify` still brings along a vulnerable `5.8.2` copy unless it is pinned.
- Advisory: `GHSA-444r-cwp2-x5xf`
- How to remove it: upgrade `@nestjs/platform-fastify` to a version that resolves `fastify@>=5.8.3` by itself, remove the override, and re-run the audit.

## Maintenance notes

- Prefer direct dependency bumps over overrides whenever possible.
- Revisit the override list after any upgrade to Nest, Fastify, ESLint, TypeScript-ESLint, Vite, or Vitest.
- If an override only protects a dev-only path, try pruning it during routine dependency upgrades before adding new ones.
- A direct dependency bump can make an old override redundant without any other code changes, so re-run a one-by-one prune check before carrying an override forward to the next release.
