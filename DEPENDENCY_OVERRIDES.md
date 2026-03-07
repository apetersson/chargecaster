# Dependency Overrides

This file documents the root `pnpm.overrides` in [package.json](/Users/andreas/Documents/code/chargecaster/package.json).

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

### `@nestjs/platform-fastify>fastify = 5.8.2`
- Reason: without this pin, Nest resolves a nested Fastify line that reintroduces the malformed `Content-Type` advisory.
- Advisory: `GHSA-573f-x89g-hqp9`
- Removal condition: safe once `@nestjs/platform-fastify` reliably resolves `fastify@>=5.8.1` without the pin.

### `vite>esbuild = 0.27.3`
- Reason: without this pin, the backend test toolchain reintroduces the old Vite/esbuild dev-server advisory through the Vitest chain.
- Advisory: `GHSA-67mh-4wv8-2f99`
- Removal condition: safe once all Vite consumers, including Vitest's nested Vite, resolve `esbuild@>=0.25.0` without the pin.

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

## Maintenance notes

- Prefer direct dependency bumps over overrides whenever possible.
- Re-check overrides after any upgrade to Nest, Fastify, Vite, ESLint, Vitest, or ts-node.
- If an override is kept only to satisfy an old dev-only transitive path, consider removing it first during routine dependency upgrades and re-running `pnpm audit`.
