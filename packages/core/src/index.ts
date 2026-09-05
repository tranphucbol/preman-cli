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
  targetLabels,
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
  buildCatalog,
  refreshCatalog,
  type Catalog,
  type CatalogNode,
  type CatalogNodeKind,
  type CatalogProtocol,
} from "@preman/core/api/catalog.js";
export { watchWorkspace, type WatchHandle, type WatchOptions } from "@preman/core/api/watch.js";
export {
  createCollection,
  createFolder,
  createEnvironmentFile,
  createRequestFile,
  deleteNode,
  duplicateRequestFile,
  editDefinitionFile,
  editRequestFile,
  moveNode,
  renameNode,
  reorderSiblings,
  replaceFileText,
  writeRequestFile,
  type CreateCollectionArgs,
  type CreateEnvironmentArgs,
  type CreateGroupArgs,
  type CreateRequestArgs,
  type DuplicateRequestArgs,
  type FieldEdit,
  type MoveArgs,
  type RequestKind,
  type WriteRequestArgs,
} from "@preman/core/api/mutate.js";
export { applyImportPlan, planImport, type ApplyImportArgs, type PlanImportArgs } from "@preman/core/api/import.js";
export type { DroppedFlag, ImportPlan } from "@preman/core/import/plan.js";
export type { CommandFormat } from "@preman/core/command/format.js";
export {
  copySelection,
  planCommand,
  type CopySelectionArgs,
  type CopySelectionResult,
  type PlanCommandArgs,
} from "@preman/core/api/command.js";
export type { CommandPlan, Revealed, Unexpressed } from "@preman/core/command/plan.js";
export {
  flattenHeaders,
  type HeaderPairs,
  type RunEvent,
  type RunEventSink,
  type SentRequest,
} from "@preman/core/api/events.js";
export {
  BodyStore,
  type BodyHead,
  type BodyMatch,
  type BodyPublication,
  type BodyWindow,
} from "@preman/core/api/bodies.js";
export {
  readEnvironment,
  selectEnvironment,
  writeEnvironmentValue,
  type EnvironmentView,
  type EnvironmentWrite,
} from "@preman/core/api/environments.js";
export {
  readVariables,
  type VariableBinding,
  type VariableLayer,
  type VariableView,
} from "@preman/core/api/variables.js";
export { previewText, type TextPreview } from "@preman/core/api/preview.js";
export {
  applySpecPlan,
  collectProtoFiles,
  describeSpecs,
  isProtoFile,
  linkCheckout,
  planSpecConversion,
  planSpecs,
  removeSpec,
  type DeclaredSpec,
  type LinkAction,
  type LinkOverride,
  type PlanOptions,
  type PlannedLink,
  type PlannedSpec,
  type SpecPlan,
  type SpecsView,
} from "@preman/core/api/specs.js";
export {
  DEFAULT_SHARED_PROTO_ROOT,
  SHARED_PROTO_ROOT_ENV,
  sharedProtoRoot,
  type SharedLink,
} from "@preman/core/workspace/links.js";
export {
  listCloudWorkspaces,
  migrateCloudWorkspace,
  type MigrateArgs,
  type MigrationOutcome,
} from "@preman/core/api/migrate.js";
export type { CloudWorkspace } from "@preman/core/postman/model.js";
export type { SkippedItem } from "@preman/core/postman/plan.js";
export type { MigrationPhase, MigrationProgress, MigrationReporter } from "@preman/core/postman/progress.js";
export type { Scope } from "@preman/core/vars/store.js";
export { toGroupJsonReport, toJsonReport } from "@preman/core/report/json.js";
export { toJunitReport, type RunReport } from "@preman/core/report/junit.js";
