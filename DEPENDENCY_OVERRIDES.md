# Dependency Overrides

This file documents the root `pnpm.overrides` in `package.json`.

Use these overrides as temporary security pins, not permanent architecture.
When direct dependencies naturally resolve to safe versions, remove the override and re-run:

```bash
pnpm audit --json
pnpm run lint:all
pnpm run typecheck:all
pnpm run build:all
pnpm --dir backend test
```

## Active overrides

After re-testing each candidate one by one against `pnpm audit`, only two overrides are still required.

### `@nestjs/common>file-type = 21.3.1`
- Reason: `@nestjs/common@11.1.16` hard-pins `file-type@21.3.0`, which is the vulnerable release flagged by the ASF parser advisory.
- Advisory: `GHSA-5v7r-6r5c-r473`
- Removal condition: safe once the published Nest package moves to `file-type@>=21.3.1` on its own.

### `@nestjs/platform-fastify>fastify = 5.8.2`
- Reason: without this pin, Nest resolves a nested Fastify line that reintroduces the malformed `Content-Type` advisory.
- Advisory: `GHSA-573f-x89g-hqp9`
- Removal condition: safe once `@nestjs/platform-fastify` reliably resolves `fastify@>=5.8.1` without the pin.

## Recently pruned

These were removed after individual re-tests confirmed `pnpm audit` stayed green without them:

- `@fastify/ajv-compiler>ajv`
- `@fastify/middie`
- `@isaacs/brace-expansion`
- `diff`
- `eslint>ajv`
- `fast-json-stringify>ajv`
- `glob`
- `js-yaml`
- `minimatch`
- `qs`
- `rollup`
- `vite`
- `vite>esbuild`

## Maintenance notes

- Prefer direct dependency bumps over overrides whenever possible.
- Re-check overrides after any upgrade to Nest, Fastify, ESLint, Vitest, or ts-node.
- If an override is kept only to satisfy an old dev-only transitive path, consider removing it first during routine dependency upgrades and re-running `pnpm audit`.
