import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pc from "picocolors";
import {
  FENCE_DETAILS,
  FENCE_MESSAGE,
  importFormat,
  isImportFormat,
  pastedText,
  resolveDestination,
} from "@preman/cli/import.js";
import { interactiveSelection } from "@preman/cli/prompt.js";
import { defaultPostmanAppData } from "@preman/cli/postman.js";
import { progressWriter } from "@preman/cli/progress.js";
import { renderCommand } from "@preman/cli/render/command.js";
import { renderEnvironment, renderEnvironmentSet } from "@preman/cli/render/env.js";
import { renderImport } from "@preman/cli/render/import.js";
import { renderList } from "@preman/cli/render/list.js";
import { renderMigration, renderWorkspaceList } from "@preman/cli/render/migrate.js";
import { renderLinkWrite, renderSpecs } from "@preman/cli/render/protos.js";
import { hasHumanReporter, renderReports, reporterNames, resolveReporterTargets } from "@preman/cli/reporters/index.js";
import { copySelection } from "@preman/core/api/command.js";
import { readEnvironment, writeEnvironmentValue } from "@preman/core/api/environments.js";
import { applyImportPlan, planImport } from "@preman/core/api/import.js";
import { describeWorkspace } from "@preman/core/api/inspect.js";
import { listCloudWorkspaces, migrateCloudWorkspace } from "@preman/core/api/migrate.js";
import { describeSpecs, linkCheckout } from "@preman/core/api/specs.js";
import { runSelection } from "@preman/core/api/run.js";
import { findWorkspace } from "@preman/core/workspace/discover.js";
import { nodeIdFor } from "@preman/core/workspace/paths.js";
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
/**
 * The fence `preman import` needs.
 *
 * Read off argv rather than inferred from the positionals, because `parseArgs` gives no sign it
 * consumed a `-k` it recognised: the flag simply becomes preman's own and leaves the positionals
 * one word shorter. Its presence is the only evidence the paste arrived whole.
 */
const END_OF_FLAGS = "--";
const IMPORT_COMMAND = "import";
const FIRST_ARG = 0;

const HELP = `${pc.bold("preman")} — run Postman-format gRPC and HTTP requests from the CLI

${pc.bold("usage")}
  preman list
  preman run [<collection/request>]   run one request
  preman run <collection|folder>      run every request in it, in order
  preman env show
  preman env set <key> <value>
  preman protos                       the declared protos and the links they need
  preman protos link <name> <dir>     point a shared link at a local checkout
  preman import [curl|grpcurl] [--into <group>] [-- <pasted command…>]
                                      import a pasted curl or grpcurl command
  preman copy <collection/request>     print it as a curl or grpcurl command
  preman migrate --list               list the cloud workspaces Postman can see
  preman migrate --workspace <id|name> --out <dir> [--dry-run]
                                      copy a Postman cloud workspace to disk

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
      --format <name>   import only: curl or grpcurl, when the paste does not say
      --into <group>    import only: the collection or folder to import into
                        (adopted automatically when the workspace has one)
      --name <text>     import only: the request's name, instead of the proposal
      --from <path>     import only: read the pasted command from a file
      --workspace <id|name>
                        migrate only: which Postman cloud workspace to read
      --out <dir>       migrate only: the directory to write; it must not exist
                        or must be empty
      --list            migrate only: list workspaces instead of migrating
      --dry-run         migrate and import: print what would be written, write
                        nothing
      --repoint         protos link only: move a link that already points elsewhere
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

${pc.bold("import")}
  Turns a pasted curl or grpcurl command into a request file. The paste comes
  from stdin, from --from <file>, or from the words after a ${pc.bold("--")} fence — and the
  fence is not optional for that last form, because preman owns -d, -k, -o and
  -v and would otherwise take them for itself and drop them from the paste
  without saying so.

    pbpaste | preman import --into acme
    preman import curl --into acme -- curl -k -H 'accept: text/plain' https://x

  Flags with nowhere to land are named in the report rather than ignored: TLS
  goes through --ssl-* and --insecure, redirects and timeouts are run options,
  and -o, -s and -v only ever affected curl's own output.

${pc.bold("copy")}
  The reverse of import: resolves one request against the chosen environment and
  prints it as a curl (HTTP) or grpcurl (gRPC) command. The format is not a
  choice — the request's kind decides it.

    preman copy admin/Profile --env QC

  Two things the command cannot carry, both named in the report rather than
  dropped in silence: scripts do not run, so a header a beforeRequest would have
  set is absent; and every {{token}} is resolved, so a credential that lives in
  an environment file is in the output in cleartext.

${pc.bold("migrate")}
  Reads a Postman *cloud* workspace, gRPC included, and writes it as a Postman
  filesystem workspace. Postman Desktop must be running and signed in: preman
  borrows that window's own session and never asks for a password. gRPC requests
  arrive descriptor-only — they run, but editing one against a .proto means
  adding the file and a localResources.specs entry by hand.

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
  // `import` only. `--format` overrides the sniff; the paste normally names its own program.
  format: { type: "string" },
  into: { type: "string" },
  name: { type: "string" },
  from: { type: "string" },
  // `migrate` only. No token flag: the token comes from the running Postman Desktop, so there
  // is nothing for a user to paste and nothing to leak into shell history.
  workspace: { type: "string" },
  out: { type: "string" },
  list: { type: "boolean" },
  "dry-run": { type: "boolean" },
  // `protos link` only. A shared link is read by every workspace that names it, so moving one is
  // asked for rather than assumed; without this the refusal names both targets and stops.
  repoint: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

export async function main(argv: string[]): Promise<ExitCode> {
  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];
  let positionals: string[];

  try {
    ({ values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }));
  } catch (cause) {
    // An unfenced paste is the one way to reach this on purpose: `parseArgs` rejects curl's -X
    // before any command runs, and its own advice is about positionals rather than about import.
    const unfenced = argv[FIRST_ARG] === IMPORT_COMMAND && !argv.includes(END_OF_FLAGS);
    if (unfenced) throw new PremanError(FENCE_MESSAGE, { exitCode: EXIT.CLI, details: FENCE_DETAILS });
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

    // Reading is workspace-scoped, linking is machine-scoped: `link` deliberately does not need a
    // workspace, because the machine that has to run it is usually one where nothing loads yet.
    case "protos": {
      const sub = rest[0] ?? "show";
      if (sub === "show") {
        process.stdout.write(`${renderSpecs(describeSpecs(dir), { json })}\n`);
        return EXIT.OK;
      }
      if (sub === "link") {
        const [name, target] = rest.slice(1);
        if (name === undefined || target === undefined) {
          throw new PremanError("usage: preman protos link <name> <path-to-checkout>", {
            details: ["run `preman protos` to see which links are missing"],
          });
        }
        const link = linkCheckout(name, target, { repoint: values.repoint === true });
        // How much of the workspace the write repaired, when there is one to ask: a link pointing
        // one directory off from the checkout reports `0 of 23` instead of reading as success.
        const view = findWorkspace(dir) === null ? undefined : describeSpecs(dir);
        process.stdout.write(`${renderLinkWrite(link, view, { json })}\n`);
        return EXIT.OK;
      }
      throw new PremanError(`unknown protos subcommand "${sub}"`, { details: ["expected `show` or `link`"] });
    }

    // Plan then apply, so `--dry-run` prints the same block the real run does off the same value
    // rather than walking a second code path (ADR 043).
    case "import": {
      const declared = rest[0] !== undefined && isImportFormat(rest[0]) ? rest[0] : undefined;
      const text = pastedText({
        from: values.from,
        words: declared === undefined ? rest : rest.slice(1),
        fenced: argv.includes(END_OF_FLAGS),
      });
      const destination = resolveDestination(dir, values.into);
      const plan = planImport({
        root: destination.root,
        text,
        format: importFormat(values.format) ?? importFormat(declared),
        parentDir: destination.dir,
      });
      const dryRun = values["dry-run"] === true;
      const written = dryRun
        ? null
        : applyImportPlan({ root: destination.root, parentDir: destination.dir, plan, name: values.name });
      const report = {
        plan,
        name: values.name ?? plan.name,
        destination: destination.path,
        file: written === null ? null : nodeIdFor(destination.root, written.file),
      };
      process.stdout.write(`${renderImport(report, { json })}\n`);
      return EXIT.OK;
    }

    // The reverse of `import`, and deliberately not a run: nothing is sent, so there is no
    // outcome to classify and the only exit codes are 0 and 1.
    case "copy": {
      const copy = await copySelection({
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
        certBaseDir: process.cwd(),
        vars: parseVars(values.var ?? []),
        workingDir: values["working-dir"],
        insecureFileRead: values["insecure-file-read"] === true,
        select: interactiveSelection,
      });
      // Warnings are advice for a person; --json is a value another program reads.
      if (!json) {
        for (const warning of copy.warnings) process.stderr.write(`${pc.yellow(`warn: ${warning}`)}\n`);
      }
      process.stdout.write(`${renderCommand(copy.plan, { json })}\n`);
      return EXIT.OK;
    }

    case "migrate": {
      const postmanAppData = defaultPostmanAppData();
      if (values.list === true) {
        const workspaces = await listCloudWorkspaces({ postmanAppData });
        process.stdout.write(`${renderWorkspaceList(workspaces, { json })}\n`);
        return EXIT.OK;
      }
      if (values.workspace === undefined) {
        throw new PremanError("migrate needs --workspace <id|name>", {
          details: ["run `preman migrate --list` to see what this Postman account can reach"],
        });
      }
      const dryRun = values["dry-run"] === true;
      // `--out` is required even for a dry run: the report names the destination, and a plan
      // printed without one reads as if preman had decided where the workspace goes.
      if (values.out === undefined) throw new PremanError("migrate needs --out <dir>");
      // A migration is around forty seconds of silence on a large workspace. The line goes on
      // stderr and comes back down before anything is printed, including on the way out through a
      // throw — a half-drawn bar above an error message is an error message with a bar in it.
      const progress = progressWriter(process.stderr);
      try {
        const outcome = await migrateCloudWorkspace({
          postmanAppData,
          workspace: values.workspace,
          target: values.out,
          dryRun,
          onProgress: progress.report,
        });
        progress.clear();
        process.stdout.write(`${renderMigration(outcome, { json })}\n`);
      } finally {
        progress.clear();
      }
      return EXIT.OK;
    }

    case "run": {
      const reporters = resolveReporterTargets([...(values.reporter ?? []), ...(json ? ["json"] : [])], {
        json: values["reporter-json-export"],
        junit: values["reporter-junit-export"],
      });
      const timeouts = resolveTimeouts(values);
      if (timeouts.warning !== undefined) process.stderr.write(`${pc.yellow(`warn: ${timeouts.warning}`)}\n`);
      const run = await runSelection({
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
        certBaseDir: process.cwd(),
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
        workingDir: values["working-dir"],
        insecureFileRead: values["insecure-file-read"] === true,
        safeEval: values["safe-eval"] === true,
        select: interactiveSelection,
      });

      // Warnings are advice for a person; a machine-readable reporter must stay clean.
      if (hasHumanReporter(reporters)) {
        for (const warning of run.warnings) process.stderr.write(`${pc.yellow(`warn: ${warning}`)}\n`);
      }

      const result =
        run.group === undefined
          ? { kind: "single" as const, outcome: run.outcome! }
          : { kind: "group" as const, outcome: run.group };
      const { output, files } = renderReports(result, reporters, verbose);
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
      return run.exitCode;
    }

    default:
      throw new PremanError(`unknown command "${command}"`, { details: ["run `preman --help` for usage"] });
  }
}
