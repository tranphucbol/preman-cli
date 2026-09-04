import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSecureContext, rootCertificates } from "node:tls";
import type { SecureContextOptions } from "node:tls";
import { credentials } from "@grpc/grpc-js";
import type { ChannelCredentials } from "@grpc/grpc-js";
import { PremanError, EXIT } from "@preman/core/errors.js";

/** Certificate material as the user spelled it: paths, a passphrase, a switch. */
export interface TlsCertInput {
  /** Path to a PEM bundle appended to the default trust store. */
  extraCaCerts?: string | undefined;
  /** Path to the client certificate, or to a combined cert+key PEM. */
  clientCert?: string | undefined;
  /** Path to the client private key. */
  clientKey?: string | undefined;
  /** Passphrase for an encrypted client key. */
  clientPassphrase?: string | undefined;
  /** Skip server certificate verification (newman's `-k`). */
  insecure?: boolean | undefined;
}

/** One source of certificate input, with the directory its paths are relative to. */
export interface TlsCertLayer {
  /** Shown to the user when a value has to be blamed, e.g. `--ssl-*`. */
  label: string;
  /** Paths in `input` resolve against this directory. */
  baseDir: string;
  input: TlsCertInput;
}

/** The three fields resolved from a path on disk, so a consumer can name the file. */
export type TlsCertPathField = "extraCaCerts" | "clientCert" | "clientKey";

/** Certificate material after resolution: file contents, not paths. */
export interface TlsCertOptions {
  extraCaCerts: Buffer | undefined;
  clientCert: Buffer | undefined;
  clientKey: Buffer | undefined;
  clientPassphrase: string | undefined;
  insecure: boolean;
  /**
   * The absolute path each buffer was read from.
   *
   * The transports want bytes and never look here. `command/` wants the opposite: a `--cacert`
   * has to name a file the receiving shell can open, and there is nowhere else in the tree that
   * still knows which one it was. Parsing it back out of {@link TlsCertOptions.sources}, which
   * formats it for a human, would make a display string load-bearing.
   */
  paths: Partial<Record<TlsCertPathField, string>>;
  /** Field name -> where it came from, for `--verbose`. */
  sources: Record<string, string>;
  /** Non-fatal problems, e.g. a passphrase with no key to unlock. */
  warnings: string[];
}

/** The flag a user would type for each field, so blame messages name something typeable. */
const FLAG_NAMES: Record<keyof TlsCertInput, string> = {
  extraCaCerts: "--ssl-extra-ca-certs",
  clientCert: "--ssl-client-cert",
  clientKey: "--ssl-client-key",
  clientPassphrase: "--ssl-client-passphrase",
  insecure: "--insecure",
};

const PEM_ENCODING = "utf8";

/** OpenSSL codes that all mean "I could not build a trusted chain to this certificate". */
const UNTRUSTED_CHAIN_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
]);

/**
 * The same failures as {@link UNTRUSTED_CHAIN_CODES}, as they read once OpenSSL's prose is
 * all that survives. Both spellings of "self signed" are listed because Node changed the
 * wording in v22.
 */
const UNTRUSTED_CHAIN_TEXTS = [
  ...UNTRUSTED_CHAIN_CODES,
  "unable to verify the first certificate",
  "unable to get local issuer certificate",
  "self signed certificate",
  "self-signed certificate",
];

const HOSTNAME_MISMATCH_CODE = "ERR_TLS_CERT_ALTNAME_INVALID";

const UNTRUSTED_CHAIN_HINT =
  "the server certificate is not trusted; pass --ssl-extra-ca-certs <path> to trust its CA, or -k to skip verification";

const HOSTNAME_MISMATCH_HINT =
  "the server certificate does not cover the host you dialled; dial a host it covers, or pass -k to skip verification";

/**
 * Merges layers into one resolved set. Layers are highest-precedence first: the first
 * layer that sets a field wins outright, so an explicit flag beats a config file rather
 * than being merged field-by-field with it.
 */
export function resolveTlsCerts(layers: readonly TlsCertLayer[]): TlsCertOptions {
  const sources: Record<string, string> = {};
  const paths: Partial<Record<TlsCertPathField, string>> = {};
  const warnings: string[] = [];

  const pick = <K extends keyof TlsCertInput>(field: K): [TlsCertLayer, NonNullable<TlsCertInput[K]>] | undefined => {
    for (const layer of layers) {
      const value = layer.input[field];
      if (value === undefined || value === "") continue;
      return [layer, value];
    }
    return undefined;
  };

  const readPath = (field: TlsCertPathField): Buffer | undefined => {
    const picked = pick(field);
    if (!picked) return undefined;
    const [layer, value] = picked;
    const path = resolve(layer.baseDir, value);
    sources[field] = `${layer.label} (${path})`;
    paths[field] = path;
    return readCertFile(field, layer, path);
  };

  const extraCaCerts = readPath("extraCaCerts");
  const clientCert = readPath("clientCert");
  const clientKey = readPath("clientKey");

  const passphrase = pick("clientPassphrase");
  if (passphrase) sources.clientPassphrase = passphrase[0].label;

  const insecure = pick("insecure");
  if (insecure) sources.insecure = insecure[0].label;

  if (clientKey && !clientCert) {
    throw new PremanError(`${FLAG_NAMES.clientKey} needs ${FLAG_NAMES.clientCert}`, {
      exitCode: EXIT.CLI,
      details: [
        `a private key on its own cannot identify the client`,
        `pass ${FLAG_NAMES.clientCert} <path> with the matching certificate`,
      ],
    });
  }

  // A passphrase with nothing to unlock is a typo, not a failure: warn and carry on.
  if (passphrase && !clientCert) {
    warnings.push(`${FLAG_NAMES.clientPassphrase} ignored: no ${FLAG_NAMES.clientCert} was given`);
  }

  const resolved: TlsCertOptions = {
    extraCaCerts,
    clientCert,
    clientKey,
    clientPassphrase: passphrase?.[1],
    insecure: insecure?.[1] === true,
    paths,
    sources,
    warnings,
  };

  assertUsable(resolved);
  return resolved;
}

/**
 * Builds the context once up front so unusable material (an encrypted key with no
 * passphrase, a mismatched pair, a file that is not PEM at all) fails as a CLI error
 * here instead of surfacing as an opaque transport error mid-run.
 */
function assertUsable(certs: TlsCertOptions): void {
  if (certs.extraCaCerts === undefined && certs.clientCert === undefined) return;

  try {
    createSecureContext(secureContextOptions(certs));
  } catch (cause) {
    throw new PremanError("cannot use the supplied certificate material", {
      exitCode: EXIT.CLI,
      details: [
        `reason: ${cause instanceof Error ? cause.message : String(cause)}`,
        `if the key is encrypted, pass ${FLAG_NAMES.clientPassphrase} <text>`,
      ],
    });
  }
}

/** A resolved set with nothing in it, for callers that take no certificate input. */
export function emptyTlsCerts(): TlsCertOptions {
  return resolveTlsCerts([]);
}

function readCertFile(field: keyof TlsCertInput, layer: TlsCertLayer, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new PremanError(`cannot read ${FLAG_NAMES[field]} file`, {
      exitCode: EXIT.CLI,
      details: [
        `set by ${layer.label}`,
        `resolved to ${path}`,
        `reason: ${code ?? (cause instanceof Error ? cause.message : String(cause))}`,
      ],
    });
  }
}

/**
 * The single place certificate material becomes TLS options, so the gRPC and HTTP
 * stacks cannot drift apart in what they trust or present.
 */
export function secureContextOptions(certs: TlsCertOptions): SecureContextOptions {
  const options: SecureContextOptions = {};

  if (certs.extraCaCerts) {
    // Setting `ca` replaces the trust store rather than adding to it, so the defaults
    // have to be re-listed explicitly or every public CA stops being trusted.
    options.ca = [...rootCertificates, certs.extraCaCerts.toString(PEM_ENCODING)];
  }

  if (certs.clientCert) {
    options.cert = certs.clientCert;
    // A lone --ssl-client-cert is allowed to be a combined PEM holding both halves.
    options.key = certs.clientKey ?? certs.clientCert;
    if (certs.clientPassphrase !== undefined) options.passphrase = certs.clientPassphrase;
  }

  return options;
}

/** The same options, plus the verification switch `https.request` understands. */
export function httpsRequestOptions(certs: TlsCertOptions): SecureContextOptions & { rejectUnauthorized?: boolean } {
  const options: SecureContextOptions & { rejectUnauthorized?: boolean } = secureContextOptions(certs);
  if (certs.insecure) options.rejectUnauthorized = false;
  return options;
}

/** True when the user asked for anything that changes the default TLS behaviour. */
function hasCertMaterial(certs: TlsCertOptions): boolean {
  return certs.extraCaCerts !== undefined || certs.clientCert !== undefined || certs.insecure;
}

export function grpcChannelCredentials(certs: TlsCertOptions, tls: boolean): ChannelCredentials {
  if (!tls) return credentials.createInsecure();
  // createFromSecureContext ignores GRPC_SSL_CIPHER_SUITES and
  // GRPC_DEFAULT_SSL_ROOTS_FILE_PATH, so plain `--tls` keeps using createSsl and only
  // pays that price when the user actually supplies certificate options.
  if (!hasCertMaterial(certs)) return credentials.createSsl();
  return credentials.createFromSecureContext(createSecureContext(secureContextOptions(certs)), {
    rejectUnauthorized: certs.insecure ? false : undefined,
  });
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "";
}

/**
 * Turns a handshake failure into advice naming the flag that fixes it. Returns an empty
 * list for anything that is not a certificate problem.
 */
export function tlsFailureHints(cause: unknown): string[] {
  const code = errorCode(cause);
  const text = errorText(cause);

  if (code === HOSTNAME_MISMATCH_CODE || text.includes(HOSTNAME_MISMATCH_CODE)) {
    const reason = (cause as { reason?: unknown }).reason;
    return typeof reason === "string" ? [`${HOSTNAME_MISMATCH_HINT} (${reason})`] : [HOSTNAME_MISMATCH_HINT];
  }

  if (code !== undefined && UNTRUSTED_CHAIN_CODES.has(code)) return [UNTRUSTED_CHAIN_HINT];

  // gRPC reports handshake failures as UNAVAILABLE and keeps only OpenSSL's prose in the
  // message, so there is no `code` property to match on the way there is for HTTP.
  for (const untrusted of UNTRUSTED_CHAIN_TEXTS) {
    if (text.includes(untrusted)) return [UNTRUSTED_CHAIN_HINT];
  }

  return [];
}
