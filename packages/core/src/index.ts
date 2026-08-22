/**
 * The declared public surface of the engine. Anything not re-exported here is an
 * implementation detail, even though deep subpath imports resolve.
 */
export { PremanError, EXIT, type ExitCode } from "@preman/core/errors.js";
export { findWorkspace, requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
export {
  listGroups,
  listRequests,
  type RequestEntry,
  type RequestGroup,
  type RunTarget,
} from "@preman/core/workspace/collections.js";
export {
  runGroup,
  runRequest,
  type GroupRunOutcome,
  type GroupRunItem,
  type RunOptions,
  type RunOutcome,
} from "@preman/core/runner.js";
