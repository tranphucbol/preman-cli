/**
 * The declared public surface of the engine. Anything not re-exported here is an
 * implementation detail, even though deep subpath imports resolve.
 */
export { PremanError, EXIT, type ExitCode } from "@preman/core/errors.js";
export { findWorkspace, requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
export {
  listGroups,
  listRequests,
  targetLabel,
  type RequestEntry,
  type RequestGroup,
  type RunTarget,
} from "@preman/core/workspace/collections.js";
export type { EnvironmentEntry } from "@preman/core/workspace/environments.js";
export {
  runGroup,
  runRequest,
  type GroupRunItem,
  type GroupRunOutcome,
  type RunOptions,
  type RunOutcome,
} from "@preman/core/runner.js";
export { runSelection, type RunSelectionArgs, type RunSelectionResult } from "@preman/core/api/run.js";
export { failOnAmbiguity, type SelectionPort } from "@preman/core/api/select.js";
export {
  describeWorkspace,
  type SnapshotEnvironment,
  type SnapshotRequest,
  type WorkspaceSnapshot,
} from "@preman/core/api/inspect.js";
export {
  readEnvironment,
  selectEnvironment,
  writeEnvironmentValue,
  type EnvironmentView,
  type EnvironmentWrite,
} from "@preman/core/api/environments.js";
export { toGroupJsonReport, toJsonReport } from "@preman/core/report/json.js";
