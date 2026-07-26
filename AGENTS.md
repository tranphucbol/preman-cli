# preman - Agent Guidelines

CLI that runs requests from a Postman filesystem-format workspace (`.postman/` + `postman/`).
Unary gRPC and HTTP. See `README.md` for behaviour; this file is about how to change the code.

## Commands

- `bun install`
- `bun run typecheck` - `tsc --noEmit`, must be clean
- `bun run test` - Vitest, all must pass
- `bun run test -- test/e2e.test.ts` - single file
- `bun run build` - `dist/preman.js`
- `bun run src/cli.ts <args>` - run from source

Never mark work done without a clean `typecheck` **and** a full green `test` run.

## Layout

```
src/cli.ts            arg parsing, help, exit codes
src/runner.ts         orchestration: scripts -> interpolate -> invoke -> writeback
src/commands/         list, env, run
src/workspace/        discovery, resources, collections/groups, environments, zod schemas
src/vars/             scoped store, {{token}} interpolation, dynamic vars
src/scripts/          node:vm sandbox (pm shim), chai + gRPC assertions
src/grpc/             schema resolution, target/TLS, unary invoke
src/http/             target/URL, cookies, redirects, auth, compression, invoke
src/tls/certs.ts      --ssl-* layering, secure context, gRPC credentials, handshake hints
src/output/render.ts  human + --json rendering
src/errors.ts         CliError, EXIT codes
test/fixtures/ws/     a real Postman workspace + .proto used by every suite
test/fixtures/http-ws/ the HTTP workspace; `Legacy Http` in `ws/` is a skipped websocket
test/fixtures/ssl/    committed certificates; regenerate with `generate.sh`
```

## Conventions

- TypeScript strict, ESM. Import with explicit `.js` specifiers; use `import type` for types.
- No magic literals in logic: hoist to a named module-scope `const`/`Set`/`Record`.
- Errors are `CliError` with an `exitCode` and actionable `details[]`. Never throw a bare
  string, never swallow a cause.
- Ambiguity is an error that lists the candidates - never guess what the user meant.
- Exit codes: `0` ok, `1` usage/config, `2` transport, `3` business `return_code`, `4` failed
  `pm.test`. Collection runs report the worst outcome in that order.
- Comments explain *why* (especially deliberate deviations from Postman), not *what*.

## Tests

- Vitest, names read `givenX_whenY_thenZ`.
- `test/e2e.test.ts` boots a real in-process `@grpc/grpc-js` server and calls the exported
  `main(argv)`; assert the bytes that reached the wire, not just the output.
- Prefer adding scripts/vars to existing fixtures over adding request files: several suites
  assert the exact 5-request list and its group statuses.
- Use `cloneFixtureWorkspace()` before anything that writes to the workspace.
