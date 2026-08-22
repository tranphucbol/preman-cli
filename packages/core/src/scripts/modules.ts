import { createRequire } from "node:module";
import { CliError, EXIT } from "@preman/core/errors.js";
import { chai } from "./expect.js";
import { SANDBOX_ALIASES, SANDBOX_PACKAGES } from "./module-names.js";

export { SANDBOX_ALIASES, SANDBOX_PACKAGES };

const UNKNOWN_MODULE_EXIT = EXIT.CLI;
const LODASH_GLOBAL = "_";
const CRYPTO_GLOBAL = "CryptoJS";
const LODASH_PACKAGE = "lodash";
const CRYPTO_PACKAGE = "crypto-js";
const CHAI_PACKAGE = "chai";
const AVAILABLE_MODULES_DETAIL = `available modules: ${SANDBOX_PACKAGES.join(", ")}`;

const allowedModules = new Set<string>(SANDBOX_PACKAGES);
const loadedModules = new Map<string, unknown>();
const requireFromPreman = createRequire(import.meta.url);

function loadModule(name: string): unknown {
  // Chai is already loaded and configured by expect.ts; returning that exact
  // namespace keeps Postman-specific assertions and config visible here.
  if (name === CHAI_PACKAGE) return chai;
  return requireFromPreman(SANDBOX_ALIASES[name] ?? name);
}

/** Lazily loads and memoises a sandbox library. Throws CliError for unknown names. */
export function requireSandboxModule(name: string): unknown {
  if (typeof name !== "string" || !allowedModules.has(name)) {
    const requested = typeof name === "string" ? `"${name}"` : "without a module name";
    throw new CliError(`sandbox require() cannot load ${requested}`, {
      exitCode: UNKNOWN_MODULE_EXIT,
      details: [AVAILABLE_MODULES_DETAIL],
    });
  }

  if (loadedModules.has(name)) return loadedModules.get(name);

  try {
    const loaded = loadModule(name);
    loadedModules.set(name, loaded);
    return loaded;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CliError(`sandbox module "${name}" could not be loaded`, {
      exitCode: UNKNOWN_MODULE_EXIT,
      details: [message],
    });
  }
}

/** Names bound as lazily loaded bare globals inside every script context. */
export function sandboxGlobals(): Record<string, unknown> {
  return Object.defineProperties(
    {},
    {
      [LODASH_GLOBAL]: {
        enumerable: true,
        get: () => requireSandboxModule(LODASH_PACKAGE),
      },
      [CRYPTO_GLOBAL]: {
        enumerable: true,
        get: () => requireSandboxModule(CRYPTO_PACKAGE),
      },
    },
  );
}
