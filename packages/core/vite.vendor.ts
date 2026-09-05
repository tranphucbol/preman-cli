import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Plugin } from "vite";

const VENDOR_ROOT = resolve(import.meta.dirname, "vendor");
const PLUGIN_NAME = "preman-vendor-protos";
/** Emitted names are POSIX regardless of host, and `bundledProtoRoot` joins them back per-platform. */
const POSIX_SEP = "/";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/**
 * Copies `packages/core/vendor/` beside the bundle it is building.
 *
 * The vendored `google/**` protos are data the engine reads at runtime, so unlike everything
 * else in core they cannot be inlined into the bundle — `@grpc/proto-loader` opens them by
 * path. `bundledProtoRoot()` looks for them as a sibling of the entry file, which is what
 * this puts there. A build that drops this plugin does not break; it degrades to the old
 * behaviour, where a `google/api/...` import fails to resolve (ADR 045).
 *
 * Every file is emitted, not just the `.proto`s: Apache-2.0 asks for the LICENSE and NOTICE
 * to travel with the copies.
 */
export function vendorProtos(): Plugin {
  return {
    name: PLUGIN_NAME,
    generateBundle() {
      for (const path of filesUnder(VENDOR_ROOT)) {
        this.emitFile({
          type: "asset",
          fileName: ["vendor", ...relative(VENDOR_ROOT, path).split(/[\\/]/)].join(POSIX_SEP),
          source: readFileSync(path),
        });
      }
    },
  };
}
