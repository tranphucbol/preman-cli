import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { commandEnvSet, commandEnvShow } from "./commands/env.js";
import { commandList } from "./commands/list.js";
import { commandRun } from "./commands/run.js";
import { CliError, EXIT, type ExitCode } from "./errors.js";

const VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30_000;

const HELP = `${pc.bold("preman")} — run Postman-format requests from the CLI

${pc.bold("usage")}
  preman list
  preman run [<collection/request>]   run one request
  preman run <collection|folder>      run every request in it, in order
  preman env show
  preman env set <key> <value>

${pc.bold("options")}
  -d, --dir <path>      workspace to use (default: search upwards from cwd)
  -e, --env <name>      environment to load (auto-selected if only one exists)
      --url <host:port> override the gRPC target
      --tls             force TLS
      --insecure        force plaintext
      --timeout <ms>    call deadline (default: ${DEFAULT_TIMEOUT_MS})
      --var <k=v>       set a variable, highest precedence; repeatable
      --no-save         do not write script-modified variables back to the env file
      --descriptor      use the request's embedded descriptor instead of the .proto
      --bail            in a collection run, stop at the first request that fails
      --json            machine-readable output
  -v, --verbose         show request body, script logs, metadata and trailers
  -h, --help            show this help
      --version         print the version

${pc.bold("exit codes")}
  0  success
  1  usage or configuration error
  2  gRPC status other than OK
  3  call succeeded but return_code is not OK
  4  call succeeded but a pm.test assertion failed

A collection run reports the worst outcome it saw, in that same order.

${pc.bold("scripts")}
  beforeInvoke runs before the call; onMessage and afterResponse run after it,
  with pm.response, pm.message, pm.expect and pm.test available. Post-response
  scripts are skipped when the call fails at the transport level.
`;

function parseVars(entries: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) throw new CliError(`invalid --var "${entry}"; expected key=value`);
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  const ms = Number.parseInt(raw, 10);
  if (!Number.isInteger(ms) || ms <= 0) throw new CliError(`invalid --timeout "${raw}"; expected a positive integer`);
  return ms;
}

const OPTIONS = {
  dir: { type: "string", short: "d" },
  env: { type: "string", short: "e" },
  url: { type: "string" },
  tls: { type: "boolean" },
  insecure: { type: "boolean" },
  timeout: { type: "string" },
  var: { type: "string", multiple: true },
  "no-save": { type: "boolean" },
  descriptor: { type: "boolean" },
  bail: { type: "boolean" },
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
    throw new CliError((cause as Error).message, { details: ["run `preman --help` for usage"] });
  }

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return positionals.length === 0 && !values.help ? EXIT.CLI : EXIT.OK;
  }

  if (values.tls && values.insecure) throw new CliError("--tls and --insecure are mutually exclusive");

  const dir = values.dir ?? process.cwd();
  const json = values.json === true;
  const verbose = values.verbose === true;
  const [command, ...rest] = positionals;

  switch (command) {
    case "list": {
      process.stdout.write(`${commandList({ dir, json, verbose })}\n`);
      return EXIT.OK;
    }

    case "env": {
      const sub = rest[0] ?? "show";
      if (sub === "show") {
        process.stdout.write(`${commandEnvShow({ dir, env: values.env, json })}\n`);
        return EXIT.OK;
      }
      if (sub === "set") {
        const [key, ...valueParts] = rest.slice(1);
        if (key === undefined || valueParts.length === 0) {
          throw new CliError("usage: preman env set <key> <value>");
        }
        process.stdout.write(`${commandEnvSet({ dir, env: values.env, json, key, value: valueParts.join(" ") })}\n`);
        return EXIT.OK;
      }
      throw new CliError(`unknown env subcommand "${sub}"`, { details: ["expected `show` or `set`"] });
    }

    case "run": {
      const { output, exitCode } = await commandRun({
        dir,
        selector: rest.length > 0 ? rest.join(" ") : undefined,
        env: values.env,
        url: values.url,
        tls: values.tls === true ? true : values.insecure === true ? false : undefined,
        timeoutMs: parseTimeout(values.timeout),
        vars: parseVars(values.var ?? []),
        save: values["no-save"] !== true,
        preferDescriptor: values.descriptor === true,
        bail: values.bail === true,
        json,
        verbose,
      });
      process.stdout.write(`${output}\n`);
      return exitCode;
    }

    default:
      throw new CliError(`unknown command "${command}"`, { details: ["run `preman --help` for usage"] });
  }
}

/* c8 ignore start -- process wiring, exercised by running the binary */
const entrypoint = process.argv[1];
const isDirectRun = entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;

if (isDirectRun) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${pc.red("error:")} ${error.message}\n`);
      for (const detail of error.details) process.stderr.write(`${detail}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`${pc.red("error:")} ${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = EXIT.CLI;
    }
  }
}
/* c8 ignore stop */
