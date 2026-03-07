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

### `@nestjs/platform-fastify>fastify = 5.8.2`
- Reason: ensure Nest's nested Fastify copy is patched for the malformed `Content-Type` advisory.
- Advisory: `GHSA-573f-x89g-hqp9`
- Removal condition: safe once `@nestjs/platform-fastify` reliably resolves a patched Fastify without the pin.

### `@fastify/ajv-compiler>ajv = 8.18.0`
- Reason: force patched AJV for Fastify validation compiler.
- Advisory: `GHSA-2g4f-4pwh-qvx6`
- Removal condition: safe once upstream compiler chain resolves `ajv@>=8.18.0` on its own.

### `fast-json-stringify>ajv = 8.18.0`
- Reason: force patched AJV for Fastify's response serializer path.
- Advisory: `GHSA-2g4f-4pwh-qvx6`
- Removal condition: safe once `fast-json-stringify` and nested Fastify packages resolve `ajv@>=8.18.0` without the pin.

### `@fastify/middie = 9.2.0`
- Reason: patch Fastify middleware path-normalization bypass.
- Advisory: `GHSA-8p85-9qpw-fwgw`
- Removal condition: safe once the Fastify/Nest stack naturally resolves `@fastify/middie@>=9.2.0`.

### `vite = 5.4.21`
- Reason: patch Vite dev-server deny-list bypass on Windows.
- Advisory: `GHSA-93m4-6634-74q7`
- Removal condition: safe once all direct and transitive Vite consumers resolve `>=5.4.21`.

### `vite>esbuild = 0.27.3`
- Reason: keep Vite's nested esbuild on a patched line.
- Advisory: `GHSA-67mh-4wv8-2f99`
- Removal condition: safe once all Vite consumers already bring `esbuild@>=0.25.0`.

### `rollup = 4.59.0`
- Reason: patch Vite's Rollup dependency to the audit-approved release.
- Advisory source: transitive `vite` audit recommendation.
- Removal condition: safe once the chosen Vite line resolves a non-vulnerable Rollup transitively.

### `glob = 11.1.0`
- Reason: patch glob CLI command-injection issue in `@fastify/static` and old toolchain leaves.
- Advisory: `GHSA-5j98-mcp5-4vw2`
- Removal condition: safe once all transitive glob consumers resolve `>=11.1.0`.

### `minimatch = 10.2.3`
- Reason: patch nested extglob ReDoS across ESLint/glob chains.
- Advisory: `GHSA-23c5-xmqv-rm74`
- Removal condition: safe once all parents resolve patched minimatch versions directly.

### `@isaacs/brace-expansion = 5.0.1`
- Reason: patch nested dependency under minimatch/glob chain.
- Advisory source: audit recommendation for `@fastify/static` dependency tree.
- Removal condition: safe once the minimatch/glob chain resolves the patched version without forcing it.

### `js-yaml = 4.1.1`
- Reason: patch ESLint's nested `@eslint/eslintrc` dependency.
- Advisory source: audit recommendation for `backend>eslint>@eslint/eslintrc>js-yaml`.
- Removal condition: safe once ESLint toolchain resolves `js-yaml@>=4.1.1` transitively.

### `eslint>ajv = 6.14.0`
- Reason: patch ESLint's nested AJV v6 line.
- Advisory: `GHSA-2g4f-4pwh-qvx6`
- Removal condition: safe once ESLint's dependency tree no longer resolves vulnerable AJV v6.

### `qs = 6.15.0`
- Reason: patch `supertest -> superagent -> qs`.
- Advisory: `GHSA-6rw7-vpxm-498p`
- Removal condition: safe once `superagent`/`supertest` resolve `qs@>=6.15.0` without the pin.

### `diff = 4.0.4`
- Reason: patch `ts-node -> diff`.
- Advisory source: audit recommendation for `backend>ts-node>diff`.
- Removal condition: safe once `ts-node` resolves the patched `diff` version on its own.

## Maintenance notes

- Prefer direct dependency bumps over overrides whenever possible.
- Re-check overrides after any upgrade to Nest, Fastify, Vite, ESLint, Vitest, or ts-node.
- If an override is kept only to satisfy an old dev-only transitive path, consider removing it first during routine dependency upgrades and re-running `pnpm audit`.
