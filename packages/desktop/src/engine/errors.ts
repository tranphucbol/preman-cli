import { EXIT, PremanError } from "@preman/core/errors.js";
import type { EngineError } from "@preman/desktop/engine/protocol.js";

const UNKNOWN_FAILURE = "the engine failed for an unknown reason";

/**
 * Flatten anything thrown into the wire shape. A `PremanError` keeps its exit code
 * and its `details[]`; anything else keeps its message and is reported as a usage
 * failure, because an engine host that cannot say what went wrong must not claim a
 * transport or business cause.
 */
export function toEngineError(cause: unknown): EngineError {
  if (cause instanceof PremanError) {
    return { message: cause.message, details: [...cause.details], exitCode: cause.exitCode };
  }
  if (cause instanceof Error) {
    return { message: cause.message, details: [], exitCode: EXIT.CLI };
  }
  return { message: UNKNOWN_FAILURE, details: [String(cause)], exitCode: EXIT.CLI };
}
