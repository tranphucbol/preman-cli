/**
 * The request editor: the method/URL bar and the seven sub-tabs.
 *
 * Two rules hold this pane together. First, everything renders from
 * `project(saved.data, edits)`, never from `saved.data`, so a pending edit survives a
 * sub-tab switch. Second, every control is uncontrolled and commits on blur or a debounce,
 * so the store is written once per edit rather than once per keystroke.
 *
 * The `YAML` sub-tab is the escape hatch: anything this editor cannot express is still
 * editable, and the engine validates it against the same schemas before it lands.
 */

import { useCallback, useMemo, useState } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import type { FieldEdit, MethodChoice } from "@preman/desktop/engine/protocol.js";
import {
  BODY_TYPES,
  type BodyType,
  FIELD,
  GRPC_SCRIPT_TYPES,
  HTTP_METHODS,
  HTTP_SCRIPT_TYPES,
  NO_BODY,
  type Pair,
  type PairList,
  type ScriptSlot,
  edit,
  editPairAdded,
  editPairEnabled,
  editPairKey,
  editPairRemoved,
  editPairValue,
  editScript,
  hasDescriptor,
  isGrpc,
  project,
  readBodyType,
  readMethod,
  readPairs,
  readScripts,
  readSettings,
  readText,
} from "@preman/desktop/renderer/model/request.js";
import { listMethods, messageSkeleton, type Failure } from "@preman/desktop/renderer/actions.js";
import type { PaletteItem } from "@preman/desktop/renderer/model/palette.js";
import { loadTab } from "@preman/desktop/renderer/stores/session.js";
import { type SubTab, type Tab, isDirty, useTabsStore } from "@preman/desktop/renderer/stores/tabs.js";
import type { Ask } from "@preman/desktop/renderer/ui/Dialog.js";
import { CodeEditor, type CodeLanguage } from "@preman/desktop/renderer/ui/CodeEditor.js";
import {
  Button,
  CellField,
  Field,
  IconButton,
  Labelled,
  Select,
  SelectOption,
} from "@preman/desktop/renderer/ui/Controls.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import {
  CancelIcon,
  GenerateIcon,
  PickerIcon,
  SaveIcon,
  SendIcon,
  WarningIcon,
} from "@preman/desktop/renderer/ui/icons.js";
import { CommandPalette } from "@preman/desktop/renderer/panes/CommandPalette.js";
import { KeyValueGrid } from "@preman/desktop/renderer/panes/KeyValueGrid.js";

const HEADERS_FIELD = "headers";
const PARAMS_FIELD = "queryParams";
const METADATA_FIELD = "metadata";
const URLENCODED_FIELD = "body";

/** Sub-tab order matches Postman's, so muscle memory lands on the right one. */
const SUB_TABS: readonly { readonly id: SubTab; readonly label: string }[] = [
  { id: "params", label: "Params" },
  { id: "auth", label: "Auth" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "scripts", label: "Scripts" },
  { id: "settings", label: "Settings" },
  { id: "yaml", label: "YAML" },
];

const TRIGGER_CLASS =
  "h-tab shrink-0 border-b-2 border-transparent px-2.5 text-xs text-ink-dim hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink";

export interface RequestEditorProps {
  readonly tab: Tab;
  readonly running: boolean;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  /** For the one destructive thing this pane does: replacing a hand-written message. */
  readonly onAsk: (ask: Ask) => void;
  readonly onFail: (failure: Failure | null) => void;
}

export function RequestEditor({ tab, running, onSend, onCancel, onSave, onAsk, onFail }: RequestEditorProps) {
  const saved = tab.saved;
  const data = useMemo(() => project(saved?.data, tab.edits), [saved, tab.edits]);
  const grpc = isGrpc(data);
  const dirty = isDirty(tab);

  const apply = useCallback(
    (edits: readonly FieldEdit[]) => {
      const store = useTabsStore.getState();
      for (const change of edits) store.setField(tab.nodeId, change.path, change.value);
    },
    [tab.nodeId],
  );

  /**
   * Commit a blur-edited field, but only if it actually changed.
   *
   * These fields commit on blur, and focus leaves them for reasons that are not edits - clicking
   * the method picker beside one, or the Send button. An unconditional apply would mark the tab
   * dirty for having been looked at, which then makes the dirty dot mean nothing.
   */
  const commit = useCallback(
    (path: readonly (string | number)[], current: string, next: string) => {
      if (next !== current) apply([edit(path, next)]);
    },
    [apply],
  );

  const picker = useMethodPicker(tab.nodeId, apply, onFail);

  if (tab.loading) return <Notice message="Loading." />;
  if (tab.error !== null) return <Failure title={tab.error.message} details={tab.error.details} />;
  if (saved === null) return <Notice message="Nothing loaded." />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tab.conflicted ? <ConflictBanner nodeId={tab.nodeId} /> : null}
      {tab.orphaned ? (
        <Banner tone="danger" message="This file is gone from disk. Saving will write it back." detail={saved.file} />
      ) : null}

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-gutter py-2">
        {grpc ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <div className="min-w-0 flex-1">
              <Field
                key={readText(data, FIELD.methodPath)}
                mono
                defaultValue={readText(data, FIELD.methodPath)}
                placeholder="package.Service/Method"
                aria-label="Method path"
                onBlur={(event) => {
                  commit(FIELD.methodPath, readText(data, FIELD.methodPath), event.currentTarget.value);
                }}
              />
            </div>
            {/* Beside the field, not instead of it: the field is still the escape hatch for a
                method whose proto this workspace does not declare. */}
            <IconButton label="Pick a method" onClick={picker.show}>
              <PickerIcon />
            </IconButton>
          </div>
        ) : (
          <Select
            mono
            value={readMethod(data)}
            aria-label="Method"
            onValueChange={(next) => {
              apply([edit(FIELD.method, next)]);
            }}
          >
            {HTTP_METHODS.map((verb) => (
              <SelectOption key={verb} value={verb}>
                {verb}
              </SelectOption>
            ))}
          </Select>
        )}
        {/* The target is secondary for gRPC, where the method path is the identity, and primary
            for HTTP, where the URL is. Hence the two widths rather than one shared bar. */}
        <div className={grpc ? "w-72 shrink-0" : "min-w-0 flex-1"}>
          <Field
            key={readText(data, FIELD.url)}
            mono
            defaultValue={readText(data, FIELD.url)}
            placeholder={grpc ? "{{grpc_host}}" : "{{base_url}}/path"}
            aria-label="URL"
            onBlur={(event) => {
              commit(FIELD.url, readText(data, FIELD.url), event.currentTarget.value);
            }}
          />
        </div>
        {running ? (
          <Button variant="danger" onClick={onCancel}>
            <CancelIcon />
            Cancel
          </Button>
        ) : (
          <Button variant="primary" onClick={onSend}>
            <SendIcon />
            Send
          </Button>
        )}
        <IconButton label={dirty ? "Save (Cmd+S)" : "Saved"} disabled={!dirty} onClick={onSave}>
          <SaveIcon />
        </IconButton>
      </div>

      <Tabs.Root
        value={tab.subTab}
        onValueChange={(next) => {
          useTabsStore.getState().setSubTab(tab.nodeId, next as SubTab);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List className="flex shrink-0 items-center border-b border-line px-gutter" aria-label="Request sections">
          {SUB_TABS.map((entry) => (
            <Tabs.Trigger key={entry.id} value={entry.id} className={TRIGGER_CLASS}>
              {entry.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Pane value="params">
          {grpc ? (
            <PairPane field={METADATA_FIELD} noun="metadata entry" data={data} apply={apply} />
          ) : (
            <PairPane field={PARAMS_FIELD} noun="param" data={data} apply={apply} />
          )}
        </Pane>

        <Pane value="auth">
          <AuthPane data={data} apply={apply} />
        </Pane>

        <Pane value="headers">
          {grpc ? (
            <Notice message="gRPC calls carry metadata, not headers. Edit it under Params." />
          ) : (
            <PairPane field={HEADERS_FIELD} noun="header" data={data} apply={apply} />
          )}
        </Pane>

        <Pane value="body">
          {grpc ? (
            <MessagePane data={data} apply={apply} onAsk={onAsk} onFail={onFail} />
          ) : (
            <BodyPane data={data} apply={apply} />
          )}
        </Pane>

        <Pane value="scripts">
          <ScriptsPane data={data} grpc={grpc} apply={apply} />
        </Pane>

        <Pane value="settings">
          <SettingsPane data={data} grpc={grpc} apply={apply} />
        </Pane>

        <Pane value="yaml">
          <CodeEditor
            value={tab.text ?? saved.text}
            language="yaml"
            onCommit={(next) => {
              if (next !== (tab.text ?? saved.text)) useTabsStore.getState().setText(tab.nodeId, next);
            }}
          />
        </Pane>
      </Tabs.Root>

      <CommandPalette
        open={picker.open}
        items={picker.items}
        label="Pick a gRPC method"
        placeholder="Filter methods"
        onDismiss={picker.dismiss}
        onChoose={picker.choose}
      />
    </div>
  );
}

type Apply = (edits: readonly FieldEdit[]) => void;

/**
 * The gRPC method picker.
 *
 * It reuses the command palette's dialog rather than a dropdown, for the same reason the palette
 * itself is virtualized: a workspace can declare twenty-six protos, and a menu that mounts every
 * method of every service is a menu that stalls on open. Type-to-narrow is also simply the right
 * interaction for a list of fully-qualified method paths.
 *
 * Choosing writes two fields, `methodPath` and `schema.location`, because that is what changing
 * method actually is in the file format. The engine computed the location relative to this request
 * (see `MethodChoice`), so nothing here does path arithmetic.
 */
function useMethodPicker(nodeId: string, apply: Apply, onFail: (failure: Failure | null) => void) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<readonly MethodChoice[]>([]);

  const show = useCallback(() => {
    setOpen(true);
    // Asked for on every open. The engine caches the parse by mtime, so this is a map over a list
    // it already has - and a list held in this component would go stale the moment a proto changed.
    void listMethods(nodeId).then((result) => {
      if (!result.ok) {
        setOpen(false);
        onFail(result.failure);
        return;
      }
      setChoices(result.value.methods);
      // A warning here means a spec would not load, which is why a method someone expected is
      // missing. Silence would look like the method never existed.
      if (result.value.warnings.length > 0) {
        onFail({ message: "Some protos could not be loaded.", details: [...result.value.warnings] });
      }
    });
  }, [nodeId, onFail]);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  const items = useMemo<readonly PaletteItem[]>(
    () =>
      choices.map((choice) => ({
        kind: "method",
        id: choice.methodPath,
        label: choice.methodPath,
        // Streaming is offered and refused on send: a method missing from the picker reads as a
        // broken index, and "unary only" is a sentence the app can say when it matters.
        detail: choice.streaming ? `${choice.specLabel} · streaming` : choice.specLabel,
      })),
    [choices],
  );

  const choose = useCallback(
    (item: PaletteItem) => {
      const choice = choices.find((candidate) => candidate.methodPath === item.id);
      if (choice === undefined) return;
      apply([
        edit(FIELD.methodPath, choice.methodPath),
        ...(choice.schemaLocation === undefined ? [] : [edit(FIELD.schemaLocation, choice.schemaLocation)]),
      ]);
    },
    [apply, choices],
  );

  return { open, items, show, dismiss, choose };
}

function Pane({ value, children }: { readonly value: SubTab; readonly children: React.ReactNode }) {
  return (
    <Tabs.Content value={value} className="flex min-h-0 flex-1 flex-col focus:outline-none">
      {children}
    </Tabs.Content>
  );
}

/** One grid, wired to whichever field it edits. The shape-preserving edits live in the model. */
function PairPane({
  field,
  noun,
  data,
  apply,
}: {
  readonly field: string;
  readonly noun: string;
  readonly data: unknown;
  readonly apply: Apply;
}) {
  const list: PairList = readPairs(data, field);
  return (
    <KeyValueGrid
      list={list}
      noun={noun}
      onToggle={(pair, disabled) => {
        apply(editPairEnabled(field, list, pair, disabled));
      }}
      onKeyChange={(pair, key) => {
        apply(editPairKey(field, list, pair, key));
      }}
      onValueChange={(pair, value) => {
        apply([editPairValue(field, list, pair, value)]);
      }}
      onRemove={(pair) => {
        apply(editPairRemoved(field, list, pair));
      }}
      onAdd={(key, value) => {
        apply(editPairAdded(field, list, key, value));
      }}
      onBulk={(entries) => {
        apply([edit([field], entries)]);
      }}
    />
  );
}

/**
 * Auth is an open `{type, credentials}` block in the format and every provider names its
 * credentials differently, so this surfaces the type plus whatever keys the file already
 * carries rather than pretending to know the shape of nine auth schemes.
 */
function AuthPane({ data, apply }: { readonly data: unknown; readonly apply: Apply }) {
  const type = readText(data, FIELD.authType);
  const credentials = readCredentials(data);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-gutter">
      <Labelled label="Type" htmlFor="auth-type" hint="Empty means inherit from the folder. Core resolves the chain.">
        <div className="w-56">
          <Field
            id="auth-type"
            key={type}
            mono
            defaultValue={type}
            placeholder="bearer"
            onBlur={(event) => {
              if (event.currentTarget.value !== type) apply([edit(FIELD.authType, event.currentTarget.value)]);
            }}
          />
        </div>
      </Labelled>
      <FieldRows
        rows={credentials}
        empty="No credentials here. Either the folder supplies them, or add them on the YAML tab."
        onCommit={(key, value) => {
          apply([edit(["auth", "credentials", key], value)]);
        }}
      />
    </div>
  );
}

/**
 * `auth.credentials` is an open record and every scheme names its keys differently, so the
 * pane edits the keys the file already has rather than pretending to know the shape of nine
 * auth schemes. Adding a key is the YAML tab's job.
 */
function readCredentials(data: unknown): readonly Pair[] {
  return readNestedRecord(data, ["auth", "credentials"]);
}

function readNestedRecord(data: unknown, path: readonly string[]): readonly Pair[] {
  let cursor: unknown = data;
  for (const step of path) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return [];
    cursor = (cursor as Record<string, unknown>)[step];
  }
  if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return [];
  return Object.entries(cursor as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
    disabled: false,
    at: key,
  }));
}

/**
 * A fixed list of known keys with editable values. Distinct from `KeyValueGrid`, which
 * exists for lists the user grows and shrinks; here the keys come from the file.
 */
function FieldRows({
  rows,
  empty,
  onCommit,
}: {
  readonly rows: readonly Pair[];
  readonly empty: string;
  readonly onCommit: (key: string, value: string) => void;
}) {
  if (rows.length === 0) return <p className="text-2xs text-ink-faint">{empty}</p>;
  return (
    <div className="flex flex-col">
      {rows.map((pair) => (
        <div key={pair.key} className="flex items-center gap-2 border-b border-line">
          <span className="w-44 shrink-0 truncate font-mono text-xs text-ink-dim">{pair.key}</span>
          <div className="min-w-0 flex-1">
            <CellField
              key={`${pair.key}:${pair.value}`}
              defaultValue={pair.value}
              aria-label={pair.key}
              onBlur={(event) => {
                if (event.currentTarget.value !== pair.value) onCommit(pair.key, event.currentTarget.value);
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const MESSAGE_HINT = "The request message, as JSON. {{tokens}} interpolate before the call.";
const REPLACE_MESSAGE_WARNING =
  "The example is generated from the proto, so whatever is in the message now is replaced. Nothing is written to disk until you save.";

/**
 * The gRPC request message, and the button that writes one for you.
 *
 * Generating is the highest-value thing in this pane: the engine walks the descriptor and emits
 * every field with a zero value, and puts `{{token}}` wherever a string field is named after a
 * variable that exists. That last part is what makes it a starting point rather than a form to
 * fill in twice.
 *
 * Replacing a non-empty message asks first. It is the one destructive edit this pane makes, and
 * the message is often the only hand-written part of a request.
 */
function MessagePane({
  data,
  apply,
  onAsk,
  onFail,
}: {
  readonly data: unknown;
  readonly apply: Apply;
  readonly onAsk: (ask: Ask) => void;
  readonly onFail: (failure: Failure | null) => void;
}) {
  const methodPath = readText(data, FIELD.methodPath);
  const message = readText(data, FIELD.message);

  function generate(): void {
    void messageSkeleton(methodPath).then((result) => {
      if (result.ok) apply([edit(FIELD.message, result.value)]);
      else onFail(result.failure);
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-gutter">
        <Button
          disabled={methodPath.length === 0}
          onClick={() => {
            if (message.trim().length === 0) {
              generate();
              return;
            }
            onAsk({
              kind: "confirm",
              title: "Replace the message with an example?",
              body: REPLACE_MESSAGE_WARNING,
              submit: "Replace",
              onConfirm: generate,
            });
          }}
        >
          <GenerateIcon />
          Generate example
        </Button>
        {methodPath.length === 0 && (
          <span className="text-2xs text-ink-faint">Set a method path first: the example comes from its proto.</span>
        )}
      </div>
      <CodeEditor
        value={message}
        language="json"
        placeholder={MESSAGE_HINT}
        onCommit={(next) => {
          if (next !== message) apply([edit(FIELD.message, next)]);
        }}
      />
    </div>
  );
}

const RAW_LANGUAGE: CodeLanguage = "json";

function BodyPane({ data, apply }: { readonly data: unknown; readonly apply: Apply }) {
  const type = readBodyType(data);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-bar shrink-0 items-center gap-2 border-b border-line px-gutter">
        <Select
          value={type}
          aria-label="Body type"
          onValueChange={(value) => {
            const next = value as BodyType;
            apply([edit(FIELD.bodyType, next === NO_BODY ? undefined : next)]);
          }}
        >
          {BODY_TYPES.map((candidate) => (
            <SelectOption key={candidate} value={candidate}>
              {candidate}
            </SelectOption>
          ))}
        </Select>
      </div>
      <BodyContent type={type} data={data} apply={apply} />
    </div>
  );
}

function BodyContent({
  type,
  data,
  apply,
}: {
  readonly type: BodyType;
  readonly data: unknown;
  readonly apply: Apply;
}) {
  if (type === NO_BODY) return <Notice message="No body is sent." />;

  if (type === "urlencoded" || type === "formdata") {
    const field = type === "urlencoded" ? "urlencoded" : "formdata";
    return <NestedPairPane parent={URLENCODED_FIELD} field={field} noun="field" data={data} apply={apply} />;
  }

  if (type === "file") {
    return (
      <div className="p-gutter">
        <Labelled label="File" htmlFor="body-file" hint="Relative to the workspace root.">
          <Field
            id="body-file"
            key={readText(data, FIELD.fileSrc)}
            mono
            defaultValue={readText(data, FIELD.fileSrc)}
            placeholder="upload/receipt.txt"
            onBlur={(event) => {
              const next = event.currentTarget.value;
              if (next !== readText(data, FIELD.fileSrc)) apply([edit(FIELD.fileSrc, next)]);
            }}
          />
        </Labelled>
      </div>
    );
  }

  if (type === "graphql") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <SectionLabel>Query</SectionLabel>
        <CodeEditor
          value={readText(data, FIELD.graphqlQuery)}
          language="text"
          onCommit={(next) => {
            if (next !== readText(data, FIELD.graphqlQuery)) apply([edit(FIELD.graphqlQuery, next)]);
          }}
        />
        <SectionLabel>Variables</SectionLabel>
        <CodeEditor
          value={readText(data, FIELD.graphqlVariables)}
          language="json"
          onCommit={(next) => {
            if (next !== readText(data, FIELD.graphqlVariables)) apply([edit(FIELD.graphqlVariables, next)]);
          }}
        />
      </div>
    );
  }

  const raw = readText(data, FIELD.bodyContent);
  return (
    <CodeEditor
      value={raw}
      language={RAW_LANGUAGE}
      onCommit={(next) => {
        if (next !== raw) apply([edit(FIELD.bodyContent, next)]);
      }}
    />
  );
}

/** `body.urlencoded` and `body.formdata` are pair lists one level down. */
function NestedPairPane({
  parent,
  field,
  noun,
  data,
  apply,
}: {
  readonly parent: string;
  readonly field: string;
  readonly noun: string;
  readonly data: unknown;
  readonly apply: Apply;
}) {
  const holder = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[parent] : undefined;
  const list = readPairs(holder, field);
  const path = [parent, field];

  return (
    <KeyValueGrid
      list={list}
      noun={noun}
      onToggle={(pair, disabled) => {
        apply(editPairEnabled(field, list, pair, disabled).map((change) => rebase(change, path)));
      }}
      onKeyChange={(pair, key) => {
        apply(editPairKey(field, list, pair, key).map((change) => rebase(change, path)));
      }}
      onValueChange={(pair, value) => {
        apply([rebase(editPairValue(field, list, pair, value), path)]);
      }}
      onRemove={(pair) => {
        apply(editPairRemoved(field, list, pair).map((change) => rebase(change, path)));
      }}
      onAdd={(key, value) => {
        apply(editPairAdded(field, list, key, value).map((change) => rebase(change, path)));
      }}
      onBulk={(entries) => {
        apply([edit(path, entries)]);
      }}
    />
  );
}

/** Re-root an edit the model produced at the top level onto a nested path. */
function rebase(change: FieldEdit, path: readonly string[]): FieldEdit {
  return { path: [...path, ...change.path.slice(1)], value: change.value };
}

function ScriptsPane({ data, grpc, apply }: { readonly data: unknown; readonly grpc: boolean; readonly apply: Apply }) {
  const slots = readScripts(data, grpc ? GRPC_SCRIPT_TYPES : HTTP_SCRIPT_TYPES);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {slots.map((slot) => (
        <ScriptSlotPane key={slot.type} slot={slot} data={data} apply={apply} />
      ))}
    </div>
  );
}

function ScriptSlotPane({
  slot,
  data,
  apply,
}: {
  readonly slot: ScriptSlot;
  readonly data: unknown;
  readonly apply: Apply;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SectionLabel>{slot.type}</SectionLabel>
      <CodeEditor
        value={slot.code}
        language="javascript"
        placeholder={`pm.test("it works", () => { ... })`}
        onCommit={(next) => {
          if (next !== slot.code) apply(editScript(data, slot, next));
        }}
      />
    </div>
  );
}

function SettingsPane({
  data,
  grpc,
  apply,
}: {
  readonly data: unknown;
  readonly grpc: boolean;
  readonly apply: Apply;
}) {
  const settings = readSettings(data);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-gutter">
      <Labelled label="Name" htmlFor="request-name" hint="Renaming here does not rename the file.">
        <div className="w-72">
          <Field
            id="request-name"
            key={readText(data, FIELD.name)}
            defaultValue={readText(data, FIELD.name)}
            onBlur={(event) => {
              const next = event.currentTarget.value;
              if (next !== readText(data, FIELD.name)) apply([edit(FIELD.name, next)]);
            }}
          />
        </div>
      </Labelled>

      <Labelled label="Description" htmlFor="request-description" hint="Markdown, kept as written.">
        <textarea
          id="request-description"
          key={readText(data, FIELD.description)}
          defaultValue={readText(data, FIELD.description)}
          rows={5}
          spellCheck={false}
          className="w-full resize-y rounded-sm border border-line-strong bg-control px-2 py-1.5 text-xs text-ink focus:outline-none"
          onBlur={(event) => {
            const next = event.currentTarget.value;
            if (next !== readText(data, FIELD.description)) apply([edit(FIELD.description, next)]);
          }}
        />
      </Labelled>

      {grpc ? <SchemaFields data={data} apply={apply} /> : null}

      <div>
        <p className="mb-1 text-2xs font-medium tracking-wide text-ink-faint uppercase">Settings</p>
        <FieldRows
          rows={settings}
          empty="None set, so core applies its defaults."
          onCommit={(key, value) => {
            apply([edit(["settings", key], value)]);
          }}
        />
      </div>
    </div>
  );
}

/**
 * Decision 7: the app never regenerates `methodDescriptor`, so the descriptor is reported
 * and never offered as an editable field. Changing method means editing `methodPath` and
 * `schema.location`, which is exactly what these two fields are.
 */
function SchemaFields({ data, apply }: { readonly data: unknown; readonly apply: Apply }) {
  return (
    <div className="flex flex-col gap-3">
      <Labelled label="Proto file" htmlFor="schema-location" hint="Relative to this request file.">
        <Field
          id="schema-location"
          key={readText(data, FIELD.schemaLocation)}
          mono
          defaultValue={readText(data, FIELD.schemaLocation)}
          placeholder="../../proto/service.proto"
          onBlur={(event) => {
            const next = event.currentTarget.value;
            if (next !== readText(data, FIELD.schemaLocation)) apply([edit(FIELD.schemaLocation, next)]);
          }}
        />
      </Labelled>
      <p className="text-2xs text-ink-faint">
        {hasDescriptor(data)
          ? "This request carries an embedded descriptor, so it runs without the proto file. preman never rewrites it."
          : "No embedded descriptor. The proto file above is how this method is resolved."}
      </p>
    </div>
  );
}

function SectionLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="shrink-0 border-y border-line bg-panel px-gutter py-1 font-mono text-2xs text-ink-dim">{children}</p>
  );
}

function ConflictBanner({ nodeId }: { readonly nodeId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-warn/40 bg-warn/10 px-gutter py-1.5">
      <WarningIcon className="shrink-0 text-warn" />
      <span className="text-xs text-ink">This file changed on disk while you were editing it.</span>
      <div className="ml-auto flex gap-1.5">
        <Button
          onClick={() => {
            // Discard first, so the re-read is not itself treated as a conflict.
            useTabsStore.getState().discard(nodeId);
            void loadTab(nodeId);
          }}
        >
          Take theirs
        </Button>
        <Button
          onClick={() => {
            useTabsStore.getState().keepMine(nodeId);
          }}
        >
          Keep mine
        </Button>
      </div>
    </div>
  );
}

function Banner({
  tone,
  message,
  detail,
}: {
  readonly tone: "danger" | "warn";
  readonly message: string;
  readonly detail?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b px-gutter py-1.5",
        tone === "danger" ? "border-danger/40 bg-danger/10" : "border-warn/40 bg-warn/10",
      )}
    >
      <WarningIcon className={cn("shrink-0", tone === "danger" ? "text-danger" : "text-warn")} />
      <span className="text-xs text-ink">{message}</span>
      {detail === undefined ? null : <span className="truncate font-mono text-2xs text-ink-faint">{detail}</span>}
    </div>
  );
}

function Notice({ message }: { readonly message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-gutter">
      <p className="text-xs text-ink-faint">{message}</p>
    </div>
  );
}

function Failure({ title, details }: { readonly title: string; readonly details: readonly string[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-gutter">
      <p className="text-xs text-danger">{title}</p>
      {details.map((line) => (
        <p key={line} className="font-mono text-2xs text-ink-dim">
          {line}
        </p>
      ))}
    </div>
  );
}
