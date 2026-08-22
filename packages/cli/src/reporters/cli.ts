import { renderGroupOutcome, renderOutcome } from "@preman/cli/render/outcome.js";
import type { Reporter } from "./index.js";

export const cliReporter: Reporter = {
  name: "cli",
  exportable: false,
  render(result, context) {
    return result.kind === "single"
      ? renderOutcome(result.outcome, { verbose: context.verbose })
      : renderGroupOutcome(result.outcome, { verbose: context.verbose });
  },
};
