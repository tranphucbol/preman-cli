import { toJunitReport } from "@preman/core/report/junit.js";
import type { Reporter } from "./index.js";

/**
 * The XML itself is core's, so the desktop app can export the same bytes without going
 * through the CLI. All that is left here is registering it as a reporter.
 */
export const junitReporter: Reporter = {
  name: "junit",
  exportable: true,
  render: toJunitReport,
};
