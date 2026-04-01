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

### `@nestjs/common>file-type = 21.3.2`
- Reason: `@nestjs/common` still resolves a vulnerable `file-type` release below `21.3.2`.
- Advisory: `GHSA-j47w-4g3g-c36v`
- How to remove it: bump Nest to a release that naturally resolves `file-type@>=21.3.2`, remove the override, then confirm `pnpm audit` stays green.

### `@nestjs/core>path-to-regexp = 8.4.0`
- Reason: even after updating Nest to the latest patch we use, `@nestjs/core` still resolves `path-to-regexp@8.3.0`.
- Advisories: `GHSA-j3q9-mxjg-w52f`, `GHSA-27v5-c462-wpq7`
- How to remove it: update Nest once a release pulls in `path-to-regexp@>=8.4.0` without help, drop the override, and re-check the audit.

### `@nestjs/platform-fastify>path-to-regexp = 8.4.0`
- Reason: `pnpm audit` still traces the same `path-to-regexp` advisory through the backend's `@nestjs/platform-fastify` path, so we pin that edge explicitly as well.
- Advisories: `GHSA-j3q9-mxjg-w52f`, `GHSA-27v5-c462-wpq7`
- How to remove it: once Nest no longer needs the `@nestjs/core>path-to-regexp` pin, remove this companion pin too and confirm the audit stays green.

### `@nestjs/platform-fastify>fastify = 5.8.3`
- Reason: the backend now depends directly on `fastify@^5.8.4`, but `@nestjs/platform-fastify` still brings along a vulnerable `5.8.2` copy unless it is pinned.
- Advisory: `GHSA-444r-cwp2-x5xf`
- How to remove it: upgrade `@nestjs/platform-fastify` to a version that resolves `fastify@>=5.8.3` by itself, remove the override, and re-run the audit.

### `flat-cache>flatted = 3.4.2`
- Reason: ESLint still reaches `flatted` through `file-entry-cache -> flat-cache`, and the safe release is not yet selected automatically.
- Advisories: `GHSA-25h7-pfq9-p65f`, `GHSA-rf6f-7fwh-wjgh`
- How to remove it: update ESLint or `flat-cache` until `pnpm why flatted` shows only `>=3.4.2`, then delete the override and re-test.

### `micromatch>picomatch = 2.3.2`
- Reason: the TypeScript-ESLint toolchain still routes through `fast-glob -> micromatch -> picomatch`, and the vulnerable `2.3.1` resurfaces without this pin.
- Advisories: `GHSA-c2c7-rcm5-vvqj`, `GHSA-3v7f-55p6-f55p`
- How to remove it: upgrade the TypeScript-ESLint / fast-glob stack until it resolves `picomatch@>=2.3.2` on its own, then remove the override and verify with `pnpm audit`.

### `vite>picomatch = 4.0.4`
- Reason: Vite still exposes a direct `picomatch` edge below `4.0.4` in the currently compatible release line.
- Advisories: `GHSA-c2c7-rcm5-vvqj`, `GHSA-3v7f-55p6-f55p`
- How to remove it: move to a Vite release that already carries `picomatch@>=4.0.4`, remove the override, and check the audit again.

### `fdir>picomatch = 4.0.4`
- Reason: Vite also reaches `picomatch` through `fdir`, so the direct Vite pin alone is not enough to clear the advisory.
- Advisories: `GHSA-c2c7-rcm5-vvqj`, `GHSA-3v7f-55p6-f55p`
- How to remove it: once the Vite/fdir combination resolves `picomatch@>=4.0.4` naturally, remove this override and re-run `pnpm audit`.

### `minimatch@3.1.5>brace-expansion = 1.1.13`
- Reason: the ESLint config stack still resolves `brace-expansion@1.1.12` through `minimatch@3.1.5` without help.
- Advisory: `GHSA-f886-m6hf-6m8v`
- How to remove it: update the parent toolchain until `minimatch@3.1.5` no longer appears, or it already selects `brace-expansion@>=1.1.13`, then drop the override and re-test.

### `minimatch@9.0.9>brace-expansion = 2.0.3`
- Reason: the newer TypeScript-ESLint path still resolves `brace-expansion@2.0.2` unless pinned.
- Advisory: `GHSA-f886-m6hf-6m8v`
- How to remove it: upgrade the parent dependency chain until `minimatch@9` naturally uses `brace-expansion@>=2.0.3`, then remove the override and verify.

### `minimatch@10.2.3>brace-expansion = 5.0.5`
- Reason: `glob@13` in the Fastify static asset path still selects `brace-expansion@5.0.4` through `minimatch@10.2.3`.
- Advisory: `GHSA-f886-m6hf-6m8v`
- How to remove it: update the `glob` / `@fastify/static` chain until it resolves `brace-expansion@>=5.0.5` without a pin, then delete this override and re-test.

### `minimatch@10.2.4>brace-expansion = 5.0.5`
- Reason: `eslint-plugin-sonarjs` still pulls `minimatch@10.2.4`, which otherwise lands on `brace-expansion@5.0.4`.
- Advisory: `GHSA-f886-m6hf-6m8v`
- How to remove it: upgrade `eslint-plugin-sonarjs` or its `minimatch` dependency until `brace-expansion@>=5.0.5` is selected naturally, then remove the override and re-run checks.

### `yaml = 2.8.3`
- Reason: the backend now depends directly on `yaml@^2.8.3`, but the override keeps the whole workspace on the patched release while other tools still pull their own copies.
- Advisory: `GHSA-48c2-rrv3-qjmp`
- How to remove it: once every workspace and transitive consumer resolves `yaml@>=2.8.3` without help, delete the override and confirm `pnpm audit` stays green.

## Maintenance notes

- Prefer direct dependency bumps over overrides whenever possible.
- Revisit the override list after any upgrade to Nest, Fastify, ESLint, TypeScript-ESLint, Vite, or Vitest.
- If an override only protects a dev-only path, try pruning it during routine dependency upgrades before adding new ones.
