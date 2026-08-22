import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { commandRun } from "@preman/cli/commands/run.js";
import { renderEnvironment, renderEnvironmentSet } from "@preman/cli/render/env.js";
import { renderList } from "@preman/cli/render/list.js";
import { reporterNames, resolveReporterTargets } from "@preman/cli/reporters/index.js";
import { readEnvironment, writeEnvironmentValue } from "@preman/core/api/environments.js";
import { describeWorkspace } from "@preman/core/api/inspect.js";
import { PremanError, EXIT, type ExitCode } from "@preman/core/errors.js";

declare const __PREMAN_VERSION__: string;

const VERSION =
  typeof __PREMAN_VERSION__ === "undefined"
    ? (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version
    : __PREMAN_VERSION__;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5_000;
const DEFAULT_RUN_TIMEOUT_MS = 0;
const TIMEOUT_DEPRECATION = "--timeout now means the whole-run budget; use --timeout-request for the per-call deadline";

const HELP = `${pc.bold("preman")} — run Postman-format gRPC and HTTP requests from the CLI

${pc.bold("usage")}
  preman list
  preman run [<collection/request>]   run one request
  preman run <collection|folder>      run every request in it, in order
  preman env show
  preman env set <key> <value>

${pc.bold("options")}
  -d, --dir <path>      workspace to use (default: search upwards from cwd)
  -e, --env <name>      environment to load (auto-selected if only one exists)
      --url <target>    override the target: host:port for gRPC, an origin for
                        HTTP (the request's own path and query are kept)
      --tls             force TLS (https for HTTP requests)
      --plaintext       force cleartext (http for HTTP requests)
      --ssl-extra-ca-certs <path>
                        PEM file of CA certificates to trust in addition to the
                        public roots
      --ssl-client-cert <path>
                        PEM client certificate (mTLS); may also hold the key
      --ssl-client-key <path>
                        PEM private key for --ssl-client-cert
      --ssl-client-passphrase <text>
                        passphrase for an encrypted --ssl-client-key
  -k, --insecure        skip server certificate verification
      --working-dir <path>
                        base directory for request file paths (default: workspace root)
      --insecure-file-read
                        allow request files outside --working-dir
  -n, --iteration-count <n>
                        number of collection or folder passes (default: data rows or 1)
      --iteration-data <path>
                        JSON or CSV rows used by collection iterations
      --delay-request <ms>
                        delay between collection requests (default: 0)
      --timeout <ms>    whole-run budget; 0 means unbounded (default: 0)
      --timeout-request <ms>
                        per-call deadline (default: ${DEFAULT_REQUEST_TIMEOUT_MS})
      --timeout-script <ms>
                        per-script deadline (default: ${DEFAULT_SCRIPT_TIMEOUT_MS})
      --var <k=v>       set a variable, highest precedence; repeatable
      --no-save         do not write script-modified variables back to the env file
      --safe-eval       expose eval to scripts, for eval(pm.environment.get("lib_code"))
                        (also settable as safeEval: true in .postman/preman.yaml)
      --descriptor      gRPC only: use the request's embedded descriptor
                        instead of the .proto
      --bail            in a collection run, stop at the first request that fails
  -r, --reporter <name> reporter to use; repeat or comma-separate (${reporterNames().join(", ")})
      --reporter-json-export <path>
                        write the JSON report to a file
      --reporter-junit-export <path>
                        write the JUnit report to a file
      --json            alias for --reporter json
  -v, --verbose         show request body, script logs, headers, metadata and
                        trailers
  -h, --help            show this help
      --version         print the version

${pc.bold("exit codes")}
  0  success
  1  usage or configuration error
  2  transport failure: a gRPC status other than OK, or no HTTP response
  3  a response arrived but return_code is not OK (gRPC), or the HTTP status
     is not 2xx
  4  the call succeeded but a pm.test assertion failed

A collection run reports the worst outcome it saw, in that same order.

${pc.bold("scripts")}
  beforeInvoke and prerequest run before the call; onMessage (gRPC) and
  afterResponse run after it, with pm.response, pm.expect, pm.test, pm.cookies
  and pm.sendRequest available. gRPC also gets pm.message. A gRPC call that
  fails at the transport level skips its post-response scripts; an HTTP request
  runs them for any status that produced a response.
`;

function parseVars(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new PremanError(`invalid --var "${entry}"; expected key=value`);
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function parsePositiveInteger(raw: string, flag: string): number {
  const ms = Number.parseInt(raw, 10);
  if (!Number.isInteger(ms) || String(ms) !== raw.trim() || ms <= 0) {
    throw new PremanError(`invalid ${flag} "${raw}"; expected a positive integer`);
  }
  return ms;
}

function parseTimeout(raw: string | undefined, flag: string, fallback: number): number {
  return raw === undefined ? fallback : parsePositiveInteger(raw, flag);
}

function parseBudget(raw: string | undefined, flag: string, fallback = DEFAULT_RUN_TIMEOUT_MS): number {
  if (raw === undefined) return fallback;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isInteger(ms) || String(ms) !== raw.trim() || ms < 0) {
    throw new PremanError(`invalid ${flag} "${raw}"; expected a non-negative integer`);
  }
  return ms;
}

export interface ResolvedTimeouts {
  runMs: number;
  requestMs: number;
  scriptMs: number;
  warning?: string;
}

export function resolveTimeouts(values: {
  timeout?: string;
  "timeout-request"?: string;
  "timeout-script"?: string;
}): ResolvedTimeouts {
  const scriptMs = parseTimeout(values["timeout-script"], "--timeout-script", DEFAULT_SCRIPT_TIMEOUT_MS);
  if (values["timeout-request"] === undefined && values.timeout !== undefined) {
    return {
      runMs: DEFAULT_RUN_TIMEOUT_MS,
      requestMs: parseTimeout(values.timeout, "--timeout", DEFAULT_REQUEST_TIMEOUT_MS),
      scriptMs,
      warning: TIMEOUT_DEPRECATION,
    };
  }
  return {
    runMs: parseBudget(values.timeout, "--timeout"),
    requestMs: parseTimeout(values["timeout-request"], "--timeout-request", DEFAULT_REQUEST_TIMEOUT_MS),
    scriptMs,
  };
}

const OPTIONS = {
  dir: { type: "string", short: "d" },
  env: { type: "string", short: "e" },
  url: { type: "string" },
  tls: { type: "boolean" },
  plaintext: { type: "boolean" },
  // Names taken verbatim from newman so that muscle memory carries over.
  "ssl-extra-ca-certs": { type: "string" },
  "ssl-client-cert": { type: "string" },
  "ssl-client-key": { type: "string" },
  "ssl-client-passphrase": { type: "string" },
  insecure: { type: "boolean", short: "k" },
  "working-dir": { type: "string" },
  // Unlike newman's --no-insecure-file-read, preman denies escapes by default.
  "insecure-file-read": { type: "boolean" },
  // Scripts get no eval unless asked; see .postman/preman.yaml for the sticky form.
  "safe-eval": { type: "boolean" },
  timeout: { type: "string" },
  "timeout-request": { type: "string" },
  "timeout-script": { type: "string" },
  "iteration-count": { type: "string", short: "n" },
  // `-d` remains the established workspace shortcut for `--dir`.
  "iteration-data": { type: "string" },
  "delay-request": { type: "string" },
  var: { type: "string", multiple: true },
  "no-save": { type: "boolean" },
  descriptor: { type: "boolean" },
  bail: { type: "boolean" },
  reporter: { type: "string", short: "r", multiple: true },
  "reporter-json-export": { type: "string" },
  "reporter-junit-export": { type: "string" },
  json: { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

export async function main(argv: string[]): Promise<ExitCode> {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }));
  } catch (cause) {
    throw new PremanError((cause as Error).message, { details: ["run `preman --help` for usage"] });
  }

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return positionals.length === 0 && !values.help ? EXIT.CLI : EXIT.OK;
  }

  if (values.tls && values.plaintext) throw new PremanError("--tls and --plaintext are mutually exclusive");

  const dir = values.dir ?? process.cwd();
  const json = values.json === true;
  const verbose = values.verbose === true;
  const [command, ...rest] = positionals;

  switch (command) {
    case "list": {
      process.stdout.write(`${renderList(describeWorkspace(dir), { json, verbose })}\n`);
      return EXIT.OK;
    }

    case "env": {
      const sub = rest[0] ?? "show";
      if (sub === "show") {
        process.stdout.write(`${renderEnvironment(readEnvironment(dir, values.env), { json })}\n`);
        return EXIT.OK;
      }
      if (sub === "set") {
        const [key, ...valueParts] = rest.slice(1);
        if (key === undefined || valueParts.length === 0) {
          throw new PremanError("usage: preman env set <key> <value>");
        }
        const write = writeEnvironmentValue(dir, values.env, key, valueParts.join(" "));
        process.stdout.write(`${renderEnvironmentSet(write, { json })}\n`);
        return EXIT.OK;
      }
      throw new PremanError(`unknown env subcommand "${sub}"`, { details: ["expected `show` or `set`"] });
    }

    case "run": {
      const reporters = resolveReporterTargets([...(values.reporter ?? []), ...(json ? ["json"] : [])], {
        json: values["reporter-json-export"],
        junit: values["reporter-junit-export"],
      });
      const timeouts = resolveTimeouts(values);
      if (timeouts.warning !== undefined) process.stderr.write(`${pc.yellow(`warn: ${timeouts.warning}`)}\n`);
      const { output, files, exitCode } = await commandRun({
        dir,
        selector: rest.length > 0 ? rest.join(" ") : undefined,
        env: values.env,
        url: values.url,
        tls: values.tls === true ? true : values.plaintext === true ? false : undefined,
        tlsCerts: {
          extraCaCerts: values["ssl-extra-ca-certs"],
          clientCert: values["ssl-client-cert"],
          clientKey: values["ssl-client-key"],
          clientPassphrase: values["ssl-client-passphrase"],
          insecure: values.insecure === true ? true : undefined,
        },
        runTimeoutMs: timeouts.runMs,
        timeoutMs: timeouts.requestMs,
        scriptTimeoutMs: timeouts.scriptMs,
        iterationCount:
          values["iteration-count"] === undefined
            ? undefined
            : parsePositiveInteger(values["iteration-count"], "--iteration-count"),
        iterationData: values["iteration-data"],
        delayRequestMs: parseBudget(values["delay-request"], "--delay-request"),
        vars: parseVars(values.var ?? []),
        save: values["no-save"] !== true,
        preferDescriptor: values.descriptor === true,
        bail: values.bail === true,
        reporters,
        verbose,
        workingDir: values["working-dir"],
        insecureFileRead: values["insecure-file-read"] === true,
        safeEval: values["safe-eval"] === true,
      });
      if (output !== "") process.stdout.write(`${output}\n`);
      for (const file of files) {
        try {
          writeFileSync(file.path, file.content);
        } catch (cause) {
          throw new PremanError(`could not write reporter output to "${file.path}"`, {
            details: [(cause as Error).message],
          });
        }
      }
      return exitCode;
    }

    default:
      throw new PremanError(`unknown command "${command}"`, { details: ["run `preman --help` for usage"] });
  }
}
