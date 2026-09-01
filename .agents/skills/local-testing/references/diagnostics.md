# Diagnosing a running app

Three processes, so "it did not work" has three places to look: the window, the main process, and
one engine host per open workspace.

## The log

One file, always on, nothing to enable.

| Path                                 | What             |
| ------------------------------------ | ---------------- |
| `~/Library/Logs/preman/preman.log`   | the current log  |
| `~/Library/Logs/preman/preman.log.1` | the previous one |

The directory is `app.getPath("logs")`, passed in by `main.ts:614` so that
`packages/desktop/src/main/diagnostics.ts` owns no path decision of its own
(`packages/desktop/src/main/diagnostics.ts:122,162`). It rotates at 2MB, and there are never more
than the two files (`packages/desktop/src/main/diagnostics.ts:38-40`).

Each line is a timestamp, a level, and a message. The levels are `INFO`, `WARN`, `ERROR`, `FATAL`.
Engine lines are tagged with the host they came from, which is how you tell two open workspaces
apart:

```
2026-08-31T20:36:35.613Z INFO  preman starting: 43.4.1 (electron 43.4.1, chrome 150.0.7871.224, node 24.18.1)
2026-08-31T20:36:35.644Z INFO  preman-engine-acquiring-core: engine host started for /Users/you/repos/acquiring-core
2026-08-31T20:36:45.283Z WARN  preman-engine-acquiring-core: proto not loaded: cannot load /Users/you/repos/acquiring-core/docs/openapi.yaml: illegal token 'openapi'
```

```sh
tail -f ~/Library/Logs/preman/preman.log
```

**What is in it:** process and host lifecycle, engine failures, protos that would not load, and the
paths named in banners the user was already shown.

**What is never in it:** a URL, a header, a body, a variable name or a variable value. The engine
resolves `{{token}}` before it sends, so a log that recorded a request would be a credential file
under another name. That is a decision, not an omission - see
[ADR 035](../../../../docs/decisions/035-the-log-contains-no-traffic.md) and
[ADR 036](../../../../docs/decisions/036-the-log-says-how-bad-it-was.md).

It does name files inside the workspace, which means it contains your home directory. Read it
before attaching it to a bug report, and never paste it wholesale.

To see a request and its response, use the console drawer in the app. It logs every call the app
makes, not only what the scripts said, with `pm.sendRequest` calls indented under the request that
caused them.

## The engine host output tail

An engine host's stdout and stderr are captured line by line. The last 200 lines are kept, each
truncated to 4KB (`packages/desktop/src/main/diagnostics.ts:35-36`). That tail is what a crash
banner shows, and it is written into the log, so a host that died still explains itself.

If a workspace opens to a broken pane rather than to rows, the tail is the first thing to read: the
host failed before it could answer, and the reason is in its own output rather than in the
renderer.

## Debugging the engine

```sh
PREMAN_INSPECT=1 bun run desktop     # attach an inspector to each engine host
PREMAN_INSPECT=brk bun run desktop   # stop before it reads the workspace
```

`packages/desktop/src/main/hosts.ts:72-79`. The port is ephemeral (`127.0.0.1:0`), deliberately:
there is one host per open workspace, so a fixed port is a collision the second workspace finds.
Node prints the chosen `Debugger listening on ws://...` URL to stderr, which is captured and
forwarded to the terminal and the log. `.vscode/launch.json` has an **engine** configuration that
asks for that URL, and a **preman** configuration that attaches to both processes at once.

An unrecognised value is treated as unset. A typo in the variable will never stop the app starting.

```sh
bun run desktop:inspect
```

is the separate case: a Node debugger on the **main** process, not the engine.

## Crash reports

A Node diagnostic report is written as `report-<stamp>-<n>.json` in the same logs directory, and the
newest five are kept (`packages/desktop/src/main/diagnostics.ts:45-47,143-155`). The log records the
path to the report, never its contents. Open the file directly when a crash needs more than the
banner.

## Reproducing without the window

If a failure is in the engine rather than the window, the CLI runs the same core against the same
workspace, and its output is not filtered by a pane:

```sh
bun run packages/cli/src/bin.ts run <collection/request> -d <workspace> -v --no-save
```

`--no-save` keeps a diagnostic run from writing variables back. If it fails there, it is a core
bug and a test in `test/` can hold it. If it only fails in the app, the difference is the desktop
layer, and `test/desktop.*.test.ts` is where that gets pinned down.
