# Running from the terminal

```text
preman list
preman lint [--strict]              report authored fields preman will not honour
preman run [<collection/request>]   run one request
preman run <collection|folder>      run every request in order
preman env show
preman env set <key> <value>
preman protos                       list the declared .proto files, grouped by shared link
preman protos link <name> <dir>     point a shared link at a checkout on this machine
preman import --into <collection>   turn a pasted curl or grpcurl into a request
preman import --into <collection> -- <pasted command>
preman copy <collection/request>    print that request as a curl or grpcurl command
preman migrate --list               list the Postman cloud workspaces in reach
preman migrate --workspace <id|name> --out <dir>
```

`preman` searches upward from the current directory for `.postman/resources.yaml` or a
`postman/collections` directory. Use `-d <path>` to point it at another repository.

## Common options

| Option                           | Purpose                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `-d, --dir <path>`               | Select a workspace                                                             |
| `-e, --env <name>`               | Select an environment                                                          |
| `--url <target>`                 | Override the gRPC target or HTTP origin                                        |
| `--var <key=value>`              | Override a variable; repeatable                                                |
| `--tls` / `--plaintext`          | Force TLS or cleartext                                                         |
| `--ssl-extra-ca-certs <path>`    | Trust an extra CA on top of the public roots                                   |
| `--ssl-client-cert <path>`       | Client certificate for mutual TLS                                              |
| `--ssl-client-key <path>`        | Private key for that certificate                                               |
| `--ssl-client-passphrase <text>` | Passphrase for an encrypted key                                                |
| `-k, --insecure`                 | Skip server certificate verification                                           |
| `--working-dir <path>`           | Resolve request file paths from this directory; defaults to the workspace root |
| `--insecure-file-read`           | Allow request files outside the working directory                              |
| `-n, --iteration-count <n>`      | Run a collection or folder multiple times                                      |
| `--iteration-data <path>`        | Load iteration rows from a JSON or CSV file                                    |
| `--delay-request <ms>`           | Wait between collection requests                                               |
| `--timeout <ms>`                 | Set the whole-run budget when used with `--timeout-request`; `0` is unbounded  |
| `--timeout-request <ms>`         | Set each request deadline; defaults to `600000`                                |
| `--timeout-script <ms>`          | Set each script deadline; defaults to `5000`                                   |
| `--no-save`                      | Do not write script changes back to the environment                            |
| `--bail`                         | Stop a collection run after the first failure                                  |
| `-r, --reporter <name>`          | Select `cli`, `json`, or `junit`; repeat or comma-separate                     |
| `--reporter-json-export <path>`  | Write the JSON report to a file                                                |
| `--reporter-junit-export <path>` | Write the JUnit report to a file                                               |
| `--json`                         | Alias for `--reporter json`                                                    |
| `--repoint`                      | `protos link` only: move a link that already points elsewhere                  |
| `--into <group>`                 | `import` only: which collection or folder to write the request into            |
| `--name <name>`                  | `import` only: name the request instead of taking the proposed one             |
| `--from <path>`                  | `import` only: read the pasted command from a file instead of the fence        |
| `-v, --verbose`                  | Show request, response, script, and transport details                          |

Run `preman --help` for every option.

## In CI

Print the normal report while writing JUnit XML for the CI test tab:

```sh
preman run payment -r cli,junit --reporter-junit-export junit.xml
```

A collection run exits with the worst outcome it saw: `0` ok, `1` usage or config, `2` transport,
`3` a business `return_code`, `4` a failed `pm.test`. See [exit codes](../reference.md#exit-codes).

## What runs

- Unary gRPC using the request's `.proto` file or embedded descriptor
- HTTP requests, including multipart form-data uploads, structured `urlencoded`, binary, and
  GraphQL bodies
- Server-sent event streams, shown event by event as they arrive in the app and buffered by the CLI
- Collections and folders in Postman order
- Repeated collection runs with JSON or CSV iteration data
- Postman environments, globals, collection variables, and the
  [dynamic variable set](../reference.md#variables)
- Pre-request, post-response, and gRPC `onMessage` scripts
- Collection- and folder-level scripts and authentication, inherited by descendant requests
- `bearer`, `basic`, and `apikey` authentication for both HTTP and gRPC
- `pm.test`, `pm.expect`, cookies, `pm.sendRequest`, mutable `pm.request`, and sandbox `require()`
- Postman's common script libraries, including Lodash, CryptoJS, Moment, Cheerio, XML2JS, and UUID
- Private certificate authorities and mutual TLS, from flags or `.postman/preman.yaml`
- Environment writeback and JSON output for CI
- JUnit reports for GitLab, Jenkins, and other CI test-report consumers

Streaming gRPC and request kinds other than gRPC and HTTP are not supported. Unsupported items in a
collection run are reported instead of being executed.

See [the reference](../reference.md) for selection rules, variable precedence, protocol behavior,
scripts, assertions, exit codes, and schema resolution.
