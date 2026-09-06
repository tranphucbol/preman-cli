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
import type { CatalogNode, FieldEdit, MethodChoice } from "@preman/desktop/engine/protocol.js";
import {
  API_KEY_IN_HEADER,
  API_KEY_IN_QUERY,
  AUTH_SCHEMES,
  type AuthChoice,
  type AuthScheme,
  CREDENTIAL_FIELDS,
  type CredentialField,
  INHERIT,
  INHERIT_LABEL,
  INHERIT_VALUE,
  SCHEME_LABELS,
  authOverride,
  credentialValue,
  editAuthChoice,
  editCredential,
  editCredentialRemoved,
  hasCredentials,
  inheritedAuth,
  readAuth,
  schemeLabel,
} from "@preman/desktop/renderer/model/auth.js";
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
  editGrpcAuthority,
  editGrpcTls,
  editScript,
  hasDescriptor,
  isGrpc,
  project,
  readBodyType,
  readKind,
  readMethod,
  readPairs,
  readGrpcUrl,
  readScripts,
  readSettings,
  readText,
} from "@preman/desktop/renderer/model/request.js";
import { listMethods, messageSkeleton, openNode, type Failure } from "@preman/desktop/renderer/actions.js";
import { formatJsonTemplate } from "@preman/desktop/renderer/model/format.js";
import type { PaletteItem } from "@preman/desktop/renderer/model/palette.js";
import { flushPending } from "@preman/desktop/renderer/pending.js";
import { useAncestors } from "@preman/desktop/renderer/stores/catalog.js";
import { useAsideStore } from "@preman/desktop/renderer/stores/aside.js";
import { useOverlayStore } from "@preman/desktop/renderer/stores/overlay.js";
import {
  BODY_VIEWS,
  DEFAULT_BODY_VIEW,
  type BodyView,
  type SubTab,
  type SubTabEntry,
  type Tab,
  isDirty,
  resolveSubTab,
  useTabsStore,
} from "@preman/desktop/renderer/stores/tabs.js";
import type { Ask } from "@preman/desktop/renderer/ui/Dialog.js";
import { CodeEditor, type CodeLanguage } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { NOTHING_ASKED, type TokenReporter, type UnresolvedNames } from "@preman/desktop/renderer/ui/template.js";
import { TokenBox, useTokenBox } from "@preman/desktop/renderer/ui/TokenBox.js";
import {
  Button,
  CellField,
  Field,
  FIELD_LEAD_BUTTON_CLASS,
  IconButton,
  Labelled,
  Select,
  SelectOption,
  Tooltip,
} from "@preman/desktop/renderer/ui/Controls.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { TabTrigger, useTabUnderline } from "@preman/desktop/renderer/ui/Tabs.js";
import {
  CancelIcon,
  CommandIcon,
  DeleteIcon,
  FormatIcon,
  GenerateIcon,
  InsecureIcon,
  LinkIcon,
  PickerIcon,
  SaveIcon,
  SecureIcon,
  SendIcon,
} from "@preman/desktop/renderer/ui/icons.js";
import { commandTitle, formatForKind, HIDE_LABEL } from "@preman/desktop/renderer/model/command.js";
import { methodClass } from "@preman/desktop/renderer/ui/method.js";
import { BANNER_MOTION, Banner } from "@preman/desktop/renderer/ui/Banner.js";
import { AnimatePresence, m } from "@preman/desktop/renderer/ui/motion.js";
import { BodyPreview } from "@preman/desktop/renderer/panes/BodyPreview.js";
import { DocumentChrome, LoadFailure, Notice, SubTabPane } from "@preman/desktop/renderer/panes/DocumentChrome.js";
import { CommandPalette } from "@preman/desktop/renderer/panes/CommandPalette.js";
import { KeyValueGrid } from "@preman/desktop/renderer/panes/KeyValueGrid.js";

const HEADERS_FIELD = "headers";
const PARAMS_FIELD = "queryParams";
const METADATA_FIELD = "metadata";
const URLENCODED_FIELD = "body";

/** `noauth` as the catalog spells it; the pane only ever compares against it. */
const NO_AUTH_TYPE = "noauth";
const SECTION_HEADING_CLASS = "text-2xs font-medium tracking-wide text-ink-dim uppercase";
const AUTH_TYPE_HINT = "Inheriting means the nearest parent that declares auth supplies it.";
const DELETE_AUTH_WARNING =
  "Inheriting is the absence of an auth block, so the credentials below are removed. Save to write it.";
const EXTRA_HEADING = "Other credentials in this file";
const EXTRA_NOTE = "Kept and written back untouched. This scheme does not read them.";
const NO_INHERITED_AUTH = "No parent declares auth, so this request is sent unauthenticated.";
const PARENT_OPTED_OUT = "That parent opted out, so this request is sent unauthenticated.";
/** What the row below says, so the banner can show the value that is not being sent. */
const AUTHORED_PREFIX = "Not sent: ";
const OVERRIDE_REMEDY = "Set Type to Inherit from parent on the Auth tab to send this header instead.";
const OVERRIDE_REMEDY_INHERITED = "Set Type to No Auth on the Auth tab to send this header instead.";

/** Sub-tab order matches Postman's, so muscle memory lands on the right one. */
const HTTP_SUB_TABS: readonly SubTabEntry[] = [
  { id: "params", label: "Params" },
  { id: "auth", label: "Auth" },
  { id: "headers", label: "Headers" },
  { id: "body", label: "Body" },
  { id: "scripts", label: "Scripts" },
  { id: "settings", label: "Settings" },
  { id: "yaml", label: "YAML" },
];

/**
 * gRPC's list: fewer tabs, and the two it shares are called what the format calls them.
 *
 * `Headers` used to be here and rendered a notice pointing at `Params` - a tab whose whole content
 * was the news that it was the wrong tab. Calling the pair list `Metadata` is what removes the
 * need for the signpost, so those two changes are one change. `Body` is `Message` because the field
 * is `message.content` and the pane is `MessagePane`; "body" was the HTTP word leaking across.
 *
 * The ids are unchanged - `params`, `body` - because they are what `main/store.ts` has already
 * persisted for every open tab, and a label is not an identity.
 *
 * `Auth` is gone, and unlike Headers it was not dead: `core/src/grpc/auth.ts` renders an `auth:`
 * block into the metadata map and `runner.ts` calls it. So gRPC auth still runs, and is now
 * editable only as YAML. That is a deliberate trade, not an oversight.
 */
const GRPC_SUB_TABS: readonly SubTabEntry[] = [
  { id: "params", label: "Metadata" },
  { id: "body", label: "Message" },
  { id: "scripts", label: "Scripts" },
  { id: "settings", label: "Settings" },
  { id: "yaml", label: "YAML" },
];

/**
 * The Edit/Preview switch's labels. Read out loud rather than stored: `BODY_VIEWS` is the
 * declaration and this is only how it is spelled.
 */
const BODY_VIEW_LABELS: Record<BodyView, string> = {
  edit: "Edit",
  preview: "Preview",
};

/**
 * The body types with authored text behind them, and therefore the only ones the Preview switch
 * appears on. `urlencoded`, `formdata`, `file` and `none` hide it rather than disabling it: a
 * disabled control says the state is reachable.
 */
const PREVIEWABLE_BODY_TYPES: ReadonlySet<BodyType> = new Set<BodyType>(["raw", "graphql"]);

/** The one body type that is a single authored document, and so the only one Beautify acts on. */
const RAW_BODY: BodyType = "raw";

/**
 * What each script phase is called in the interface. The `scripts` entry's `type` is what the file
 * says and what core matches on; this is only how it is read out loud. `test` is one label for
 * both protocols because it is the same moment in both.
 */
const SCRIPT_LABELS: Record<string, string> = {
  prerequest: "Pre-request",
  beforeInvoke: "Before invoke",
  test: "After response",
};

/**
 * The phase rail is a vertical selection list, so it takes the row tier and the sidebar's selected
 * paint rather than the horizontal sub-tab's underline. Two things claiming to be the current
 * thing in two different visual languages, a few hundred pixels apart, is the confusion.
 *
 * No baked text colour: whether a phase has code is the label's own tone (`PHASE_LABEL_CLASS`
 * below), not the trigger's, so `group-hover`/`group-data` are how the trigger's interaction
 * states still brighten it.
 */
const PHASE_CLASS =
  "group flex h-row shrink-0 items-center gap-2 px-gutter text-left text-xs hover:bg-hover data-[state=active]:bg-selected focus:outline-none";

/** The label's tone: dim for an empty phase, full ink for one with code, either way brightened
 * by hover or selection on the trigger it lives in. */
const PHASE_LABEL_CLASS = "truncate group-hover:text-ink group-data-[state=active]:text-ink";

const FIRST_SLOT = 0;
const EMPTY_SCRIPT = "";

/**
 * What the lock says in each of its two states. The lock *is* `grpcs://`, so both strings name the
 * scheme rather than describing a mood: it is a segment of the url, and the field beside it no
 * longer shows that segment.
 */
const TLS_PINNED_LABEL = "grpcs:// - TLS pinned on. Click to let the target decide.";
const TLS_UNPINNED_LABEL = "No scheme - TLS decided by the target (:443, or a known TLS host). Click to pin grpcs://.";

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
  const sectionUnderline = useTabUnderline();

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
  const showProtos = useOverlayStore((state) => state.showProtos);
  // Read from the store rather than taken as a prop: the aside is a sibling of this pane, not a
  // child, and the palette and the File menu open it from above. A callback threaded down here
  // and a flag threaded back would name the same boolean in four signatures to hold it in one.
  const commandOpen = useAsideStore((state) => state.command);
  const onToggleCommand = useAsideStore((state) => state.toggleCommand);
  // The target row is the one part of this pane that is on screen whatever the sub-tab is, so it
  // owns its own box rather than borrowing one from a pane that may be unmounted.
  const box = useTokenBox();

  if (tab.loading) return <Notice message="Loading." />;
  if (tab.error !== null) return <LoadFailure title={tab.error.message} details={tab.error.details} />;
  if (saved === null) return <Notice message="Nothing loaded." />;

  const subTabs = grpc ? GRPC_SUB_TABS : HTTP_SUB_TABS;
  const subTab = resolveSubTab(subTabs, tab.subTab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DocumentChrome tab={tab} />

      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-gutter py-2">
        {grpc ? null : (
          <Select
            mono
            value={readMethod(data)}
            aria-label="Method"
            onValueChange={(next) => {
              apply([edit(FIELD.method, next)]);
            }}
          >
            {/* Coloured in the option, not on the trigger: Radix portals an `ItemText`'s children
                into the closed control, so one span paints the list and the trigger the same
                green the sidebar and the tab strip use. */}
            {HTTP_METHODS.map((verb) => (
              <SelectOption key={verb} value={verb}>
                <span className={methodClass(verb)}>{verb}</span>
              </SelectOption>
            ))}
          </Select>
        )}
        {/* The target is secondary for gRPC, where the method path is the identity, and primary
            for HTTP, where the URL is. Hence the two widths rather than one shared bar. It still
            comes first in both: it is what the request is addressed to, and reading "where" before
            "what" is the order the two fields are actually filled in. */}
        <div className={grpc ? "w-72 shrink-0" : "min-w-0 flex-1"}>
          {grpc ? (
            <Field
              // Keyed on the whole stored url, not the authority: the lock and the field write the
              // same YAML string, so this is what has to remount the input when either of them,
              // or a change on disk, moves it.
              key={readText(data, FIELD.url)}
              mono
              defaultValue={readGrpcUrl(data).authority}
              placeholder="{{grpc_host}}"
              aria-label="Target authority"
              onToken={box.report}
              // The scheme is the lock's, so it is drawn inside the box and the field shows the
              // authority alone - which is all a gRPC url ever is.
              lead={<TlsToggle data={data} apply={apply} />}
              onBlur={(event) => {
                const typed = event.currentTarget.value;
                if (typed !== readGrpcUrl(data).authority) apply(editGrpcAuthority(data, typed));
              }}
            />
          ) : (
            <Field
              key={readText(data, FIELD.url)}
              mono
              defaultValue={readText(data, FIELD.url)}
              placeholder="{{base_url}}/path"
              aria-label="URL"
              onToken={box.report}
              onBlur={(event) => {
                commit(FIELD.url, readText(data, FIELD.url), event.currentTarget.value);
              }}
            />
          )}
        </div>
        {grpc ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <div className="min-w-0 flex-1">
              <Field
                key={readText(data, FIELD.methodPath)}
                mono
                defaultValue={readText(data, FIELD.methodPath)}
                placeholder="package.Service/Method"
                aria-label="Method path"
                onToken={box.report}
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
            {/* The other half of the same sentence. A method missing from the picker means its
                proto is not declared here, and this is the door to declaring it - reachable
                without knowing that "Protos" is a command. */}
            <IconButton label="Manage protos" onClick={showProtos}>
              <LinkIcon />
            </IconButton>
          </div>
        ) : null}
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
        {/*
          One glyph, no menu. A menu is for a choice, and there is none to make here: the request's
          kind already decided whether this is a curl or a grpcurl, so a menu would have been a
          click spent revealing an answer the app already had. The caption names the dialect for
          the same reason — the tooltip is where that answer gets given.

          It toggles rather than opens, and says so while the aside is up. A control that only ever
          opens leaves the panel with the sole way to shut it, which is how a panel becomes
          something you close and stop reopening.
        */}
        <IconButton
          label={commandOpen ? HIDE_LABEL : commandTitle(formatForKind(readKind(data)))}
          active={commandOpen}
          onClick={onToggleCommand}
        >
          <CommandIcon />
        </IconButton>
      </div>

      <Tabs.Root
        value={subTab}
        onValueChange={(next) => {
          useTabsStore.getState().setSubTab(tab.nodeId, next as SubTab);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List className="flex shrink-0 items-center border-b border-line px-gutter" aria-label="Request sections">
          {subTabs.map((entry) => (
            <TabTrigger key={entry.id} value={entry.id} active={entry.id === subTab} underline={sectionUnderline}>
              {entry.label}
            </TabTrigger>
          ))}
        </Tabs.List>

        <SubTabPane value="params">
          {grpc ? (
            <PairPane field={METADATA_FIELD} noun="metadata entry" data={data} apply={apply} />
          ) : (
            <PairPane field={PARAMS_FIELD} noun="param" data={data} apply={apply} />
          )}
        </SubTabPane>

        {/* Same rule as Headers below: no trigger, so no content. gRPC's `auth:` block still runs,
            it is just YAML-only now. */}
        {grpc ? null : (
          <SubTabPane value="auth">
            <AuthPane nodeId={tab.nodeId} data={data} apply={apply} onAsk={onAsk} />
          </SubTabPane>
        )}

        {/* Not rendered at all for gRPC rather than rendered empty: a `Tabs.Content` with no
            trigger is a pane nothing can reach, and the trigger it used to have was a signpost. */}
        {grpc ? null : (
          <SubTabPane value="headers">
            <HeadersPane nodeId={tab.nodeId} data={data} apply={apply} />
          </SubTabPane>
        )}

        <SubTabPane value="body">
          {grpc ? (
            <MessagePane
              nodeId={tab.nodeId}
              view={tab.bodyView}
              data={data}
              apply={apply}
              onAsk={onAsk}
              onFail={onFail}
            />
          ) : (
            <BodyPane nodeId={tab.nodeId} view={tab.bodyView} data={data} apply={apply} onFail={onFail} />
          )}
        </SubTabPane>

        <SubTabPane value="scripts">
          <ScriptsPane tab={tab} data={data} grpc={grpc} apply={apply} />
        </SubTabPane>

        <SubTabPane value="settings">
          <SettingsPane data={data} grpc={grpc} apply={apply} />
        </SubTabPane>

        <SubTabPane value="yaml">
          <CodeEditor
            value={tab.text ?? saved.text}
            language="yaml"
            onCommit={(next) => {
              if (next !== (tab.text ?? saved.text)) useTabsStore.getState().setText(tab.nodeId, next);
            }}
          />
        </SubTabPane>
      </Tabs.Root>

      <CommandPalette
        open={picker.open}
        items={picker.items}
        label="Pick a gRPC method"
        placeholder="Filter methods"
        onDismiss={picker.dismiss}
        onChoose={picker.choose}
      />

      {box.clicked !== null && (
        <TokenBox key={box.clicked.name} name={box.clicked.name} at={box.clicked.at} onDismiss={box.dismiss} />
      )}
    </div>
  );
}

type Apply = (edits: readonly FieldEdit[]) => void;

/**
 * The lock's two inks, as a closed set because `FIELD_LEAD_BUTTON_CLASS` carries none.
 *
 * Pinned reads as a status, not as the thing you came here to press - that is Send, and the accent
 * is a fill exactly once per pane. Unpinned takes the ordinary affordance tone: letting the target
 * decide is a choice, not a fault, and `text-warn` there would nag on every localhost request.
 */
const TLS_PINNED_INK = "text-ok";
const TLS_UNPINNED_INK = "text-ink-dim hover:text-ink";

/**
 * The `grpcs://` scheme, drawn as a lock inside the authority field.
 *
 * The lock *is* the scheme - the one place a gRPC request can say TLS, since `grpc/target.ts`
 * otherwise guesses from `:443` and a known host suffix. So it lives inside the field's box and the
 * field shows the authority alone: two controls, one YAML string, and the segment each of them owns
 * is the segment it draws.
 *
 * gRPC only. HTTP has no lock because `http://` and `https://` are not a segment to hide - there
 * `tls` is exactly `url.protocol === "https:"`, and the url text already says which.
 */
function TlsToggle({ data, apply }: { readonly data: unknown; readonly apply: Apply }) {
  const { tls } = readGrpcUrl(data);
  const label = tls ? TLS_PINNED_LABEL : TLS_UNPINNED_LABEL;

  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={tls}
        className={cn(FIELD_LEAD_BUTTON_CLASS, tls ? TLS_PINNED_INK : TLS_UNPINNED_INK)}
        onClick={() => {
          apply(editGrpcTls(data, !tls));
        }}
      >
        {tls ? <SecureIcon /> : <InsecureIcon />}
      </button>
    </Tooltip>
  );
}

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
 * The headers, and a word about the one the auth block is going to take.
 *
 * `applyAuth` deletes a colliding header and sends the block's value instead, so the grid can
 * show a row that will never leave the machine - which is exactly the confusion that sent
 * `Bearer $KEY` at a live endpoint for weeks. Postman answers this here, marking the entry that
 * loses, rather than on the Authorization tab, so this is read here too.
 *
 * A banner rather than a marker on the row: `KeyValueGrid` is a four-column grid with no room for
 * a fifth, and the sentence needs to name both the scheme and where it came from.
 */
function HeadersPane({
  nodeId,
  data,
  apply,
}: {
  readonly nodeId: string;
  readonly data: unknown;
  readonly apply: Apply;
}) {
  const ancestors = useAncestors(nodeId);
  const override = authOverride(data, ancestors);

  return (
    <>
      <AnimatePresence initial={false}>
        {override !== null && (
          <m.div key="auth-override" {...BANNER_MOTION}>
            <Banner
              tone="warn"
              message={`${override.type} auth replaces the "${override.name}" header ${override.origin === null ? "below" : `inherited from ${override.origin.label}`}.`}
              details={[
                ...override.displaced.map((value) => `${AUTHORED_PREFIX}${value}`),
                override.origin === null ? OVERRIDE_REMEDY : OVERRIDE_REMEDY_INHERITED,
              ]}
            />
          </m.div>
        )}
      </AnimatePresence>
      <PairPane field={HEADERS_FIELD} noun="header" data={data} apply={apply} />
    </>
  );
}

/**
 * Auth: a type picker, the credentials that type reads, and whatever else the file carries.
 *
 * This pane used to show the type as free text and only the credential keys the file already
 * had, on the stated grounds that it would not "pretend to know the shape of nine auth schemes".
 * There are four, `renderAuth` names each one's keys, and the cost of not naming them was that a
 * new request could not be given auth at all and a migrated one - whose credentials are an array,
 * which the old reader rejected - showed an empty tab while authenticating fine on the wire.
 *
 * Shared with the group editor, unchanged: that a folder and a request both carry `auth:` is why
 * inheritance exists, so one editor for it is that fact expressed once rather than twice.
 */
export function AuthPane({
  nodeId,
  data,
  apply,
  onAsk,
}: {
  readonly nodeId: string;
  readonly data: unknown;
  readonly apply: Apply;
  readonly onAsk: (ask: Ask) => void;
}) {
  const block = readAuth(data);
  const ancestors = useAncestors(nodeId);
  const box = useTokenBox();
  const choice = block.choice;

  const choose = (next: AuthChoice): void => {
    // The one edit in this pane that deletes user data: the absence of the key is the only way
    // the format says "inherit", so there is no non-destructive spelling of it. Asked about only
    // when there is something to lose, or the dialog becomes the thing you click through.
    if (next.kind === "inherit" && hasCredentials(block)) {
      onAsk({
        kind: "confirm",
        title: "Delete this auth block?",
        body: DELETE_AUTH_WARNING,
        submit: "Delete",
        onConfirm: () => {
          apply(editAuthChoice(next));
        },
      });
      return;
    }
    apply(editAuthChoice(next));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-gutter">
      <Labelled label="Type" htmlFor="auth-type" hint={AUTH_TYPE_HINT}>
        <div className="w-56">
          <Select
            id="auth-type"
            aria-label="Auth type"
            full
            value={choice.kind === "inherit" ? INHERIT_VALUE : choice.kind === "scheme" ? choice.scheme : block.type}
            onValueChange={(next) => {
              choose(
                next === INHERIT_VALUE
                  ? INHERIT
                  : AUTH_SCHEMES.includes(next as AuthScheme)
                    ? { kind: "scheme", scheme: next as AuthScheme }
                    : { kind: "unsupported", type: next },
              );
            }}
          >
            <SelectOption value={INHERIT_VALUE}>{INHERIT_LABEL}</SelectOption>
            {AUTH_SCHEMES.map((scheme) => (
              <SelectOption key={scheme} value={scheme}>
                {SCHEME_LABELS[scheme]}
              </SelectOption>
            ))}
            {/* The file's own value, so a type this app cannot render is still the one on screen.
                Radix shows nothing for a value that is not an item, which would hide it. */}
            {choice.kind === "unsupported" && <SelectOption value={block.type}>{block.type}</SelectOption>}
          </Select>
        </div>
      </Labelled>

      {choice.kind === "unsupported" && (
        <Banner
          tone="danger"
          message={`This app cannot render auth type "${block.type}".`}
          detail={`Sending it fails with: supported types: ${AUTH_SCHEMES.join(", ")}. Edit the block on the YAML tab.`}
        />
      )}

      {choice.kind === "inherit" && <InheritedAuth ancestors={ancestors} />}

      {choice.kind === "scheme" && CREDENTIAL_FIELDS[choice.scheme].length > 0 && (
        <div className="flex flex-col gap-3">
          {CREDENTIAL_FIELDS[choice.scheme].map((field) => (
            <CredentialRow
              key={field.key}
              field={field}
              value={credentialValue(block, field.key)}
              onToken={box.report}
              onCommit={(value) => {
                apply(editCredential(block, field.key, value));
              }}
            />
          ))}
        </div>
      )}

      {block.extra.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className={SECTION_HEADING_CLASS}>{EXTRA_HEADING}</p>
          <p className="text-2xs text-ink-faint">{EXTRA_NOTE}</p>
          {block.extra.map((pair) => (
            <div key={String(pair.at)} className="flex items-center gap-2 border-b border-line">
              <span className="w-44 shrink-0 truncate font-mono text-xs text-ink-dim">{pair.key}</span>
              <div className="min-w-0 flex-1">
                <CellField
                  key={`${pair.key}:${pair.value}`}
                  defaultValue={pair.value}
                  aria-label={pair.key}
                  onToken={box.report}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== pair.value) {
                      apply(editCredential(block, pair.key, event.currentTarget.value));
                    }
                  }}
                />
              </div>
              <IconButton
                label={`Remove ${pair.key}`}
                onClick={() => {
                  apply(editCredentialRemoved(block, pair));
                }}
              >
                <DeleteIcon />
              </IconButton>
            </div>
          ))}
        </div>
      )}

      {box.clicked !== null && (
        <TokenBox key={box.clicked.name} name={box.clicked.name} at={box.clicked.at} onDismiss={box.dismiss} />
      )}
    </div>
  );
}

/** One named credential: a `Field`, or a `Select` when the scheme's value is a fixed choice. */
function CredentialRow({
  field,
  value,
  onToken,
  onCommit,
}: {
  readonly field: CredentialField;
  readonly value: string;
  readonly onToken: TokenReporter;
  readonly onCommit: (value: string) => void;
}) {
  const id = `auth-credential-${field.key}`;
  if (field.choices !== undefined) {
    return (
      <Labelled label={field.label} htmlFor={id} {...(field.hint === undefined ? {} : { hint: field.hint })}>
        <div className="w-56">
          <Select
            id={id}
            aria-label={field.label}
            full
            // An absent `in` is a header, because that is what core makes of anything that is
            // not `query`. The control shows the effective value rather than an empty trigger.
            value={value.trim().toLowerCase() === API_KEY_IN_QUERY ? API_KEY_IN_QUERY : API_KEY_IN_HEADER}
            onValueChange={onCommit}
          >
            {field.choices.map((option) => (
              <SelectOption key={option.value} value={option.value}>
                {option.label}
              </SelectOption>
            ))}
          </Select>
        </div>
      </Labelled>
    );
  }
  return (
    <Labelled label={field.label} htmlFor={id} {...(field.hint === undefined ? {} : { hint: field.hint })}>
      <Field
        id={id}
        key={value}
        mono
        defaultValue={value}
        onToken={onToken}
        onBlur={(event) => {
          if (event.currentTarget.value !== value) onCommit(event.currentTarget.value);
        }}
      />
    </Labelled>
  );
}

/**
 * What an inheriting document will actually send, and where it comes from.
 *
 * The old pane said "Empty means inherit from the folder. Core resolves the chain." and showed
 * nothing else, so the one thing the user wanted - which folder, and which scheme - arrived as a
 * Console warning after a send. The origin is a button because this is the moment someone wants
 * that folder open.
 */
function InheritedAuth({ ancestors }: { readonly ancestors: readonly CatalogNode[] }) {
  const origin = inheritedAuth(ancestors);
  if (origin === null) return <p className="text-2xs text-ink-faint">{NO_INHERITED_AUTH}</p>;

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-2xs text-ink-dim">
        Inherited from{" "}
        <Button
          variant="quiet"
          onClick={() => {
            openNode(origin.nodeId);
          }}
        >
          {origin.kind} {origin.name}
        </Button>
      </p>
      <p className="text-sm text-ink">{schemeLabel(origin.type)}</p>
      {origin.type === NO_AUTH_TYPE && <p className="text-2xs text-ink-faint">{PARENT_OPTED_OUT}</p>}
    </div>
  );
}

/**
 * A fixed list of known keys with editable values. Distinct from `KeyValueGrid`, which
 * exists for lists the user grows and shrinks; here the keys come from the file.
 */
function FieldRows({
  rows,
  empty,
  onToken,
  onCommit,
}: {
  readonly rows: readonly Pair[];
  readonly empty: string;
  /** Absent for the settings block: core reads those itself and interpolates none of them. */
  readonly onToken?: TokenReporter;
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
              onToken={onToken}
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

/**
 * The `Edit` / `Preview` switch, in the chrome row the pane already has.
 *
 * A nested `Tabs.Root` rather than a pair of buttons, so the underline that says which one is
 * current is the app's one way of saying that, and so the two triggers are one arrow-key group.
 * No new row: a bar sized by a two-item switch is a tier `docs/design-system.md` does not have.
 *
 * It sets no alignment of its own. It used to pin itself right with `ml-auto`, which made it the
 * row's spacer and left no way to put an action group after it; where it sits is the caller's.
 */
function ViewSwitch({ nodeId, view }: { readonly nodeId: string; readonly view: BodyView }) {
  /* Its own identity, not the section tabs': one `layoutId` across both lists would send the
   * underline flying between the two rows every time either one changed. */
  const underline = useTabUnderline();
  return (
    <Tabs.Root
      value={view}
      onValueChange={(next) => {
        useTabsStore.getState().setBodyView(nodeId, next as BodyView);
      }}
    >
      <Tabs.List className="flex items-center" aria-label="Body view">
        {BODY_VIEWS.map((candidate) => (
          <TabTrigger key={candidate} value={candidate} active={candidate === view} underline={underline}>
            {BODY_VIEW_LABELS[candidate]}
          </TabTrigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}

/** The one language with `{{token}}` in it, and therefore the only one `TemplateEditor` uses. */
const TEMPLATE_LANGUAGE: CodeLanguage = "json-template";

/**
 * The same answer with one name taken out of it.
 *
 * Called after a write, so the underline under the name that was just defined goes away without
 * costing a second round trip. Everything else the preview said is still true.
 */
function withoutName(unresolved: UnresolvedNames, name: string): UnresolvedNames {
  if (unresolved === NOTHING_ASKED || !unresolved.names.has(name)) return unresolved;
  const names = new Set(unresolved.names);
  names.delete(name);
  return { ...unresolved, names };
}

/**
 * One authored text, in either of its two views, and the two pieces of state they share.
 *
 * The unresolved names come back from the preview and go straight into the editor's linter, so the
 * two views are one component rather than two siblings. It is also where the rule that an editor
 * whose Preview was never opened lints nothing lives: there is no other asker.
 *
 * The clicked token is held here rather than inside `CodeEditor` because the editor is a view over
 * a document and knows nothing about environments. It reports a name and a rect; what that name
 * means is a question for something that can talk to the engine.
 */
function TemplateEditor({
  view,
  value,
  hint,
  onCommit,
}: {
  readonly view: BodyView;
  readonly value: string;
  readonly hint?: string;
  readonly onCommit: (next: string) => void;
}) {
  const [unresolved, setUnresolved] = useState<UnresolvedNames>(NOTHING_ASKED);
  const box = useTokenBox();

  const clicked = box.clicked?.name;
  const wrote = useCallback(() => {
    if (clicked === undefined) return;
    setUnresolved((current) => withoutName(current, clicked));
  }, [clicked]);

  if (view === "preview") return <BodyPreview text={value} onResolved={setUnresolved} />;
  return (
    <>
      <CodeEditor
        value={value}
        language={TEMPLATE_LANGUAGE}
        placeholder={hint}
        unresolved={unresolved}
        onCommit={onCommit}
        onToken={box.report}
      />
      {box.clicked !== null && (
        <TokenBox
          key={box.clicked.name}
          name={box.clicked.name}
          at={box.clicked.at}
          onDismiss={box.dismiss}
          onWrite={wrote}
        />
      )}
    </>
  );
}

/**
 * The right-hand end of a toolbar that has actions in it.
 *
 * `gap-1` for adjacent glyphs inside the row's own `gap-2`, matching the pinned group in
 * `App.tsx`. `ml-auto` is here rather than on any one control so the row has exactly one spacer.
 */
const ACTION_GROUP_CLASS = "ml-auto flex shrink-0 items-center gap-1";

const BEAUTIFY_LABEL = "Beautify";
const BEAUTIFY_REFUSED = "Beautify left this body as it is.";

/**
 * Re-indent the text one of these editors is holding.
 *
 * Never `disabled`: a disabled button emits no pointer events, so it could not tell you why
 * (`docs/design-system.md:125-128`), and "not valid JSON" is a thing the author wants told rather
 * than greyed out. It is absent in `Preview`, where there is nothing to edit.
 *
 * The write goes through the store like every other edit, so it arrives as the whole-document
 * replacement in `CodeEditor` — which means `Cmd+Z` reverts a reformat, and which also means the
 * editor scrolls to the top. That trade is ADR 031's.
 */
function BeautifyButton({
  nodeId,
  path,
  onFail,
}: {
  readonly nodeId: string;
  readonly path: readonly string[];
  readonly onFail: (failure: Failure | null) => void;
}) {
  return (
    <IconButton
      label={BEAUTIFY_LABEL}
      onClick={() => {
        // The store is not the newest text while the caret is in the editor: `CodeEditor` commits
        // on blur and after a debounce. Asking for that commit now is the seam `Cmd+S` uses;
        // trusting mousedown to blur, blur to commit and React to flush before `click` is three
        // assumptions deep, and being wrong means dropping the last keystrokes.
        flushPending();
        const store = useTabsStore.getState();
        const tab = store.tabs.get(nodeId);
        if (tab === undefined) return;

        const current = readText(project(tab.saved?.data, tab.edits), path);
        const outcome = formatJsonTemplate(current);
        if (!outcome.ok) {
          onFail({ message: BEAUTIFY_REFUSED, details: [outcome.reason] });
          return;
        }
        // The same guard the commit callbacks use: reformatting formatted text is not an edit, and
        // should not dirty the tab.
        if (outcome.text !== current) store.setField(nodeId, path, outcome.text);
      }}
    >
      <FormatIcon />
    </IconButton>
  );
}

const MESSAGE_HINT = "The request message, as JSON. {{tokens}} interpolate before the call.";
const GENERATE_LABEL = "Generate example";
/** A span rather than the glyph's tooltip: a disabled button never opens one. */
const METHOD_PATH_HINT = "Set a method path first: the example comes from its proto.";
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
 *
 * That button is a glyph, in the action group at the row's right beside Beautify, so the switch
 * that says which view you are looking at can sit next to the pane it labels. The cost is real and
 * was accepted: generating is most valuable to whoever has never seen it, who is exactly the person
 * a tooltip does not reach. Restoring the label is one word of JSX. The method-path hint moved into
 * that group too — once the button is a glyph, the sentence explaining why it cannot be pressed has
 * to sit next to it rather than at the row's other end.
 */
function MessagePane({
  nodeId,
  view,
  data,
  apply,
  onAsk,
  onFail,
}: {
  readonly nodeId: string;
  readonly view: BodyView;
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
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <ViewSwitch nodeId={nodeId} view={view} />
        <div className={ACTION_GROUP_CLASS}>
          {methodPath.length === 0 && <span className="text-2xs text-ink-faint">{METHOD_PATH_HINT}</span>}
          <IconButton
            label={GENERATE_LABEL}
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
          </IconButton>
          {view !== "preview" && <BeautifyButton nodeId={nodeId} path={FIELD.message} onFail={onFail} />}
        </div>
      </div>
      <TemplateEditor
        view={view}
        value={message}
        hint={MESSAGE_HINT}
        onCommit={(next) => {
          if (next !== message) apply([edit(FIELD.message, next)]);
        }}
      />
    </div>
  );
}

function BodyPane({
  nodeId,
  view,
  data,
  apply,
  onFail,
}: {
  readonly nodeId: string;
  readonly view: BodyView;
  readonly data: unknown;
  readonly apply: Apply;
  readonly onFail: (failure: Failure | null) => void;
}) {
  const type = readBodyType(data);
  const previewable = PREVIEWABLE_BODY_TYPES.has(type);
  // Raw only. `graphql`'s toolbar sits above two editors, so one button here could not say which
  // of them it formats; the pair grids have no whitespace to fix.
  const beautifiable = type === RAW_BODY && view !== "preview";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <Select
          tier="chrome"
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
        {previewable && <ViewSwitch nodeId={nodeId} view={view} />}
        {beautifiable && (
          <div className={ACTION_GROUP_CLASS}>
            <BeautifyButton nodeId={nodeId} path={FIELD.bodyContent} onFail={onFail} />
          </div>
        )}
      </div>
      {/* A body type without text to preview falls back to `Edit` rather than showing an empty
          preview: the switch it was set from is not on screen any more. */}
      <BodyContent type={type} view={previewable ? view : DEFAULT_BODY_VIEW} data={data} apply={apply} />
    </div>
  );
}

function BodyContent({
  type,
  view,
  data,
  apply,
}: {
  readonly type: BodyType;
  readonly view: BodyView;
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
        {/* Only the variables are previewed: they are the half on `json-template`. The query is
            `text` because the runner does not interpolate it. */}
        <TemplateEditor
          view={view}
          value={readText(data, FIELD.graphqlVariables)}
          onCommit={(next) => {
            if (next !== readText(data, FIELD.graphqlVariables)) apply([edit(FIELD.graphqlVariables, next)]);
          }}
        />
      </div>
    );
  }

  const raw = readText(data, FIELD.bodyContent);
  return (
    <TemplateEditor
      view={view}
      value={raw}
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

/**
 * Whether this phase has an edit sitting in `tab.edits`.
 *
 * A phase with no slot in the file yet (`slot.at === null`) cannot have one: `editScript` cannot
 * have written a path for an index the document does not have, so there is nothing to match.
 * Once it does, the very first keystroke's edit replaces the whole entry at `["scripts", at]`
 * (there was no `code` field to patch) and every one after patches `["scripts", at, "code"]`;
 * matching on the shared `["scripts", at]` prefix rather than one exact path catches both.
 */
function hasPendingScriptEdit(tab: Tab, slot: ScriptSlot): boolean {
  if (slot.at === null) return false;
  return tab.edits.some((change) => change.path[0] === "scripts" && change.path[1] === slot.at);
}

/**
 * The phases down the side, one editor beside them.
 *
 * Showing both phases at once split the height between two editors that were each too short to
 * hold a test. A request is written one phase at a time, so only one of them needs the room.
 *
 * There is deliberately no `onMessage` row. Core recognises the type (`scripts/chain.ts`) but
 * preman only invokes unary, so the phase could never fire and the row would be a promise the
 * app does not keep.
 */
function ScriptsPane({
  tab,
  data,
  grpc,
  apply,
}: {
  readonly tab: Tab;
  readonly data: unknown;
  readonly grpc: boolean;
  readonly apply: Apply;
}) {
  const slots = readScripts(data, grpc ? GRPC_SCRIPT_TYPES : HTTP_SCRIPT_TYPES);
  const first = slots[FIRST_SLOT];
  if (first === undefined) return <Notice message="This request kind has no script phases." />;

  // A phase remembered from the other protocol names a slot this request does not have, so it is
  // resolved against the slots rather than trusted, and falls back to the first.
  const active = slots.find((slot) => slot.type === tab.scriptPhase)?.type ?? first.type;

  return (
    <Tabs.Root
      orientation="vertical"
      value={active}
      onValueChange={(next) => {
        useTabsStore.getState().setScriptPhase(tab.nodeId, next);
      }}
      className="flex min-h-0 flex-1"
    >
      <Tabs.List className="flex w-40 shrink-0 flex-col border-r border-line bg-panel" aria-label="Script phases">
        {slots.map((slot) => {
          const hasCode = slot.code.trim() !== EMPTY_SCRIPT;
          const unsaved = hasPendingScriptEdit(tab, slot);
          const label = SCRIPT_LABELS[slot.type] ?? slot.type;
          return (
            <Tabs.Trigger key={slot.type} value={slot.type} className={PHASE_CLASS}>
              <span className={cn(PHASE_LABEL_CLASS, hasCode ? "text-ink" : "text-ink-dim")}>{label}</span>
              {unsaved ? (
                <>
                  <span className="ml-auto size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                  <span className="sr-only">, unsaved</span>
                </>
              ) : null}
            </Tabs.Trigger>
          );
        })}
      </Tabs.List>

      {/* One `Content` per phase, so the inactive trigger's `aria-controls` points at something
          real. Radix mounts only the active one, and `CodeEditor` commits on teardown, so
          switching phase saves the last thing typed without depending on blur landing first. */}
      {slots.map((slot) => (
        <Tabs.Content key={slot.type} value={slot.type} className="flex min-h-0 flex-1 flex-col focus:outline-none">
          <CodeEditor
            value={slot.code}
            language="javascript"
            placeholder={`pm.test("it works", () => { ... })`}
            onCommit={(next) => {
              if (next !== slot.code) apply(editScript(data, slot, next));
            }}
          />
        </Tabs.Content>
      ))}
    </Tabs.Root>
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
