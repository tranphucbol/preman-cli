# The log and debugging

## The log

The app writes one log — `preman.log` in Electron's `logs` directory, which **Settings ▸
Diagnostics** will reveal for you — holding process lifecycle, host spawns, exits and crash reasons,
every failure the engine turned into an error you saw, and everything the engine wrote to its own
output. Each line is timestamped and carries one of `INFO`, `WARN`, `ERROR` or `FATAL`:

```
2026-08-31T20:36:35.613Z INFO  preman starting: 43.4.1 (electron 43.4.1, chrome 150.0.7871.224, node 24.18.1)
2026-08-31T20:36:35.644Z INFO  preman-engine-acquiring-core: engine host started for /Users/you/repos/acquiring-core
2026-08-31T20:36:45.283Z WARN  preman-engine-acquiring-core: proto not loaded: cannot read /Users/you/repos/acquiring-core/api/proto/refund.proto: ENOENT
```

There is nothing to turn on and nothing to filter, and it holds no traffic at all: no URL, no
header, no body, no variable. The engine resolves `{{token}}` before it sends, so a log that
recorded a request would be a credential file with a different name; the console drawer is where you
look at a request. It does name files inside your workspace, which means your home directory is in
it — worth a glance before you attach one to a bug report. See
[ADR 035](../decisions/035-the-log-contains-no-traffic.md) and
[ADR 036](../decisions/036-the-log-says-how-bad-it-was.md).

## Debugging the engine

```sh
bun run desktop:inspect  # build and launch, with the main process's inspector on 127.0.0.1:9229
```

To debug the engine, set `PREMAN_INSPECT=1` (or `brk`, to stop before it reads the workspace) and
the host forks with an inspector on an ephemeral port — one host per open workspace, so the port
cannot be fixed. The `Debugger listening on ws://…` line it prints is forwarded to the terminal
along with everything else the host says; `.vscode/launch.json`'s **engine** configuration asks for
that URL, and **preman** attaches to both processes at once.
