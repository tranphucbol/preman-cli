import { renderGroupOutcome, renderOutcome } from "@/output/render.js";
import type { Reporter } from "@/output/reporter.js";

export const cliReporter: Reporter = {
  name: "cli",
  exportable: false,
  render(result, context) {
    return result.kind === "single"
      ? renderOutcome(result.outcome, { verbose: context.verbose })
      : renderGroupOutcome(result.outcome, { verbose: context.verbose });
  },
};
