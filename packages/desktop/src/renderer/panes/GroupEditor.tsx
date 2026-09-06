/**
 * The collection and folder editor: the group's own `auth:` block, and its YAML.
 *
 * A group was the one document in the workspace this app could read but not open. It has an
 * `auth:` block of exactly the same shape a request's is - that is what `resolveAuth` walks up -
 * so leaving it uneditable meant the inheritance the request pane names had no surface anywhere,
 * and the answer to "change the token for this whole collection" was a text editor.
 *
 * Two sub-tabs, not seven: a group has no url, no body and no method, and its `scripts` and `name`
 * are edited elsewhere or not yet at all. `AuthPane` is imported from the request editor rather
 * than reimplemented - one `auth:` shape, one editor for it.
 *
 * No Send button and no response, which is why `App.tsx` forks on `tab.kind` before the exchange
 * split: running a collection is the sidebar's `Run…`, and it reports into the console rather than
 * into a response pane.
 */

import { useCallback, useMemo } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import type { FieldEdit } from "@preman/desktop/engine/protocol.js";
import { project } from "@preman/desktop/renderer/model/request.js";
import {
  isDirty,
  resolveSubTab,
  useTabsStore,
  type SubTabEntry,
  type Tab,
} from "@preman/desktop/renderer/stores/tabs.js";
import { IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { CodeEditor } from "@preman/desktop/renderer/ui/CodeEditor.js";
import type { Ask } from "@preman/desktop/renderer/ui/Dialog.js";
import { SaveIcon } from "@preman/desktop/renderer/ui/icons.js";
import { TabTrigger, useTabUnderline } from "@preman/desktop/renderer/ui/Tabs.js";
import { DocumentChrome, LoadFailure, Notice, SubTabPane } from "@preman/desktop/renderer/panes/DocumentChrome.js";
import { AuthPane } from "@preman/desktop/renderer/panes/RequestEditor.js";

const GROUP_SUB_TABS: readonly SubTabEntry[] = [
  { id: "auth", label: "Auth" },
  { id: "yaml", label: "YAML" },
];

/**
 * A group with no `.resources/definition.yaml` opens as an empty document rather than an error:
 * the engine reads the absence as an unnamed group, and the first save creates the file.
 */
const EMPTY_DEFINITION = "";

export interface GroupEditorProps {
  readonly tab: Tab;
  readonly onSave: () => void;
  /** For the one destructive thing the auth pane does: dropping a block to inherit again. */
  readonly onAsk: (ask: Ask) => void;
}

export function GroupEditor({ tab, onSave, onAsk }: GroupEditorProps) {
  const saved = tab.saved;
  const data = useMemo(() => project(saved?.data, tab.edits), [saved, tab.edits]);
  const dirty = isDirty(tab);
  const sectionUnderline = useTabUnderline();

  const apply = useCallback(
    (edits: readonly FieldEdit[]) => {
      const store = useTabsStore.getState();
      for (const change of edits) store.setField(tab.nodeId, change.path, change.value);
    },
    [tab.nodeId],
  );

  if (tab.loading) return <Notice message="Loading." />;
  if (tab.error !== null) return <LoadFailure title={tab.error.message} details={tab.error.details} />;
  if (saved === null) return <Notice message="Nothing loaded." />;

  const subTab = resolveSubTab(GROUP_SUB_TABS, tab.subTab);
  const text = tab.text ?? saved.text ?? EMPTY_DEFINITION;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocumentChrome tab={tab} />

      <Tabs.Root
        value={subTab}
        onValueChange={(next) => {
          useTabsStore.getState().setSubTab(tab.nodeId, next as SubTabEntry["id"]);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {/* Save lives on this row rather than on a bar of its own: the group editor has no target
            to address, so the sub-tab row is the only chrome there is to hang it on. */}
        <Tabs.List className="flex shrink-0 items-center border-b border-line px-gutter" aria-label="Group sections">
          {GROUP_SUB_TABS.map((entry) => (
            <TabTrigger key={entry.id} value={entry.id} active={entry.id === subTab} underline={sectionUnderline}>
              {entry.label}
            </TabTrigger>
          ))}
          <div className="ml-auto">
            <IconButton label={dirty ? "Save (Cmd+S)" : "Saved"} disabled={!dirty} onClick={onSave}>
              <SaveIcon />
            </IconButton>
          </div>
        </Tabs.List>

        <SubTabPane value="auth">
          <AuthPane nodeId={tab.nodeId} data={data} apply={apply} onAsk={onAsk} />
        </SubTabPane>

        <SubTabPane value="yaml">
          <CodeEditor
            value={text}
            language="yaml"
            onCommit={(next) => {
              if (next !== text) useTabsStore.getState().setText(tab.nodeId, next);
            }}
          />
        </SubTabPane>
      </Tabs.Root>
    </div>
  );
}
