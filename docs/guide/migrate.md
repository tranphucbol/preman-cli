# Migrating from Postman cloud

If the collections are still in a Postman cloud workspace rather than in Git, `preman migrate` copies
one onto disk in the same format Local View writes:

```sh
preman migrate --list
preman migrate --workspace "Payment Core" --out ./payment-core
```

```text
Migrated 2 collections, 1 folder, 1 environment into ./payment-core
  1 gRPC request
  2 HTTP requests
  1 skipped (websocket-request)
      Adapter/Legacy/Legacy Socket
```

**Postman Desktop must be running and signed in.** `preman` borrows that window's own session, so
there is no API key to create and no password to type. `--workspace` takes an id or a name; two
workspaces sharing a name are reported with their ids rather than guessed between. `--dry-run` prints
every file that would be written and writes none. The destination must be empty — an existing
workspace is never merged into.

A large workspace takes the better part of a minute, so it draws a bar while it works:

```text
  reading collections   █████░░░░░░░░░░░░░░░  29%  12/41  327 reads
```

It is on standard error, so the report and `--json` still pipe cleanly, and it comes back down before
anything is printed. The proportion counts collections rather than requests, because Postman reveals
what is inside a collection only as it is read — the total number of calls is genuinely unknown until
the end, and a bar that revised its own denominator would slide backwards.

This reads Postman's private API, which is the only one that can see gRPC requests; the documented
one returns schema v2.1 and omits them entirely. It is undocumented, so a Postman update can break
it without notice. See [ADR 033](../decisions/033-migrating-from-postman-cloud.md).

## gRPC requests need their `.proto`

Postman's cloud copy of the embedded descriptor is truncated — 184 of 188 requests in the workspace
this was measured against came back cut to 300 characters, and a truncated descriptor does not
decode. Where Postman recorded the path to the `.proto` it was built from, the migration keeps that
path exactly as recorded and lists it in `.postman/resources.yaml`, so on the machine that authored
the request it runs against the live file, which is the better source anyway. Where it did not, or
where the file is not on this machine, the request is still written and says which `.proto` it wants
when you run it. Request kinds `preman` cannot run, websockets among them, are skipped and named one
line each, so it is clear what stayed behind.

## In the app

The desktop app does the same thing from **File ▸ Migrate from Postman…**, or the command palette:
it lists the workspaces, asks where to put the one you pick, and opens it when it is written.
