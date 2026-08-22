import { toGroupJsonReport, toJsonReport } from "@preman/cli/render/outcome.js";
import type { Reporter } from "./index.js";

export const jsonReporter: Reporter = {
  name: "json",
  exportable: true,
  render(result) {
    const report = result.kind === "single" ? toJsonReport(result.outcome) : toGroupJsonReport(result.outcome);
    return JSON.stringify(report, null, 2);
  },
};
