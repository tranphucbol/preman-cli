/**
 * What the command aside decides, asserted where those decisions live rather than through a
 * component nothing here can render - the same split `import.pane.test.ts` makes. The suite runs
 * on `environment: "node"`, so the cases whose names say "on screen" are pinned as the pane's
 * source mapping the arrays it was handed, which is the honest version of that claim here.
 *
 * That the draft actually reaches core, and actually changes the command, is checked over a real
 * port in `desktop.protocol.test.ts` and against a real workspace in `command.curl.test.ts`. What
 * is left for here is that this pane is the thing that sends it.
 *
 * The last case is the whole reason the button exists as a button. A pane that copied on open
 * would put a bearer token on the clipboard of someone who opened it to read what the request
 * would send, so `writeText` appearing exactly once, inside a press handler, is decision 18 in
 * the only form this suite can check it.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CommandPlan, Revealed, Unexpressed } from "@preman/desktop/engine/protocol.js";
import {
  canCopy,
  COPIED_LABEL,
  commandTitle,
  COPY_LABEL,
  dialectTitle,
  formatForKind,
  NOT_EXPRESSED_TITLE,
  PLANNING,
  REVEALED_TITLE,
  revealedLabel,
  revealedOrder,
  type Preview,
} from "@preman/desktop/renderer/model/command.js";
import { shellCommand } from "@preman/desktop/renderer/ui/shell.js";

const RENDERER_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../packages/desktop/src/renderer");
const PANE_SOURCE = readFileSync(join(RENDERER_DIR, "panes/CommandPane.tsx"), "utf8");
/* The aside's currency is a property of how a `Field` commits, so the contract is pinned there. */
const CONTROLS_SOURCE = readFileSync(join(RENDERER_DIR, "ui/Controls.tsx"), "utf8");

const CURL_COMMAND = "curl -H 'accept: application/json' https://api.example.test/v1/orders";
const GRPCURL_COMMAND = "grpcurl -plaintext 127.0.0.1:50051 test.echo.EchoService/Ping";

function plan(over: Partial<CommandPlan> = {}): CommandPlan {
  return {
    format: "curl",
    kind: "http-request",
    words: ["curl", "https://api.example.test/v1/orders"],
    command: CURL_COMMAND,
    unexpressed: [],
    revealed: [],
    warnings: [],
    ...over,
  };
}

function planned(over: Partial<CommandPlan> = {}): Preview {
  return { kind: "planned", plan: plan(over) };
}

describe("the command pane", () => {
  it("givenAnHttpRequest_whenThePaneOpens_thenTheTitleSaysCurl", () => {
    expect(formatForKind("http-request")).toBe("curl");
    expect(commandTitle("curl")).toBe("Copy as cURL");
    // The tool's own capitalisation, which the File menu's import item already uses.
    expect(commandTitle("curl")).toContain("cURL");
  });

  it("givenAGrpcRequest_whenThePaneOpens_thenTheTitleSaysGrpcurl", () => {
    expect(formatForKind("grpc-request")).toBe("grpcurl");
    expect(commandTitle("grpcurl")).toBe("Copy as grpcurl");
    // Lowercase, because that is how the binary spells itself.
    expect(commandTitle("grpcurl")).not.toContain("gRPC");
  });

  it("givenAPlanWithUnexpressedFields_whenRendered_thenEachOneAndItsReasonIsOnScreen", () => {
    const unexpressed: Unexpressed[] = [
      { field: "prerequest", reason: "not run; a script that sets a header is not in this command" },
      { field: "cookie jar", reason: "populated by earlier responses in a run" },
    ];
    const preview = planned({ unexpressed });
    expect(preview.kind === "planned" && preview.plan.unexpressed).toEqual(unexpressed);
    // Both halves of every row are drawn, and the heading names the section the CLI names.
    expect(PANE_SOURCE).toContain("plan.unexpressed.map");
    expect(PANE_SOURCE).toContain("entry.field");
    expect(PANE_SOURCE).toContain("entry.reason");
    expect(NOT_EXPRESSED_TITLE).toBe("Not in this command");
  });

  it("givenAPlanWithRevealedVariables_whenRendered_thenEachNameAndScopeIsOnScreen", () => {
    const revealed: Revealed[] = [
      { name: "token", scope: "environment" },
      { name: "http_url", scope: "globals" },
    ];
    // A variable says its scope, because that is the file the reader would go and edit.
    expect(revealed.map(revealedLabel)).toEqual(["environment", "globals"]);
    expect(revealedOrder(revealed)).toEqual(revealed);
    expect(PANE_SOURCE).toContain("revealedOrder(plan.revealed).map");
    expect(PANE_SOURCE).toContain("revealedLabel(entry)");
    expect(REVEALED_TITLE).toBe("In cleartext");
  });

  it("givenAPlanWithAnInheritedCredential_whenRendered_thenTheOriginIsNamed", () => {
    const inherited: Revealed = { name: "auth", scope: "auth", origin: "collection payment" };
    expect(revealedLabel(inherited)).toBe("inherited from collection payment");
    // The request's own block says so plainly rather than naming itself twice.
    expect(revealedLabel({ name: "auth", scope: "auth", origin: "request" })).toBe("this request");
    expect(revealedLabel({ name: "auth", scope: "auth" })).toBe("this request");
    // And it sorts first: a token nobody typed into this request is the one entry someone reads
    // this list to find, and the one they would not have gone looking for.
    const revealed: Revealed[] = [{ name: "token", scope: "environment" }, inherited];
    expect(revealedOrder(revealed)[0]).toBe(inherited);
  });

  it("givenARefusal_whenRendered_thenTheBannerCarriesTheDetails", () => {
    const rejected: Preview = {
      kind: "rejected",
      message: '"payment" is a collection of 5 requests',
      details: ["copy one request at a time"],
    };
    // A refusal is a preview state, so nothing else in the pane can be showing a stale command.
    expect(canCopy(rejected)).toBe(false);
    expect(PANE_SOURCE).toContain("preview.details.map");
    expect(PANE_SOURCE).toContain("preview.message");
  });

  it("givenTheCopyButton_whenPressed_thenTheClipboardHoldsTheCommandAndTheLabelChanges", () => {
    expect(canCopy(planned({ format: "grpcurl", kind: "grpc-request", command: GRPCURL_COMMAND }))).toBe(true);
    expect(COPY_LABEL).toBe("Copy");
    expect(COPIED_LABEL).toBe("Copied");
    // The command itself, not the words and not a re-quoted version of them: `plan.command` is
    // the one string the engine promised splits back into `plan.words`.
    expect(PANE_SOURCE).toContain("navigator.clipboard.writeText(command)");
    expect(PANE_SOURCE).toContain("preview.plan.command");
    // In the header beside Close, not in a band of its own: one action does not earn a footer.
    expect(PANE_SOURCE).toContain("<CopyButton preview={preview} />\n        <IconButton label={CLOSE_LABEL}");
    expect(PANE_SOURCE).not.toContain("h-bar");
  });

  it("givenACommandOnScreen_whenItIsDrawn_thenItIsTokenizedAndNotPlainText", () => {
    // `language="text"` installs no parser, which is why this read as one grey line. The four
    // parts a reader scans a command for are in `ui/shell.ts`; the pane only has to ask for them.
    expect(PANE_SOURCE).toContain('language="shell"');
  });

  it("givenTheAsideIsOpen_whenTheHeaderIsDrawn_thenItNamesTheDialectAndNotTheVerb", () => {
    // The glyph in the toolbar says what pressing it will do; the header labels what is already
    // on screen. Repeating "Copy as" over an open panel would make the panel read as a button.
    expect(dialectTitle("curl")).toBe("cURL");
    expect(dialectTitle("grpcurl")).toBe("grpcurl");
    expect(dialectTitle("curl")).not.toContain("Copy");
    expect(PANE_SOURCE).toContain("dialectTitle(preview.plan.format)");
  });

  it("givenAnEditedRequest_whenThePlanIsAsked_thenTheDraftTravelsAndNotTheFile", () => {
    // The whole reason this is an aside and not a dialog: it is open while the request is being
    // typed into, so what it shows has to be the draft. A panel showing the last-saved version
    // while the user edits is worse than no panel — it is confidently wrong.
    expect(PANE_SOURCE).toContain("planCommand(tab.nodeId, environment, draft)");
    // Both editors, picked the way `saveTab` picks them: raw YAML bytes win when there are any.
    expect(PANE_SOURCE).toContain("project(tab.saved?.data, tab.edits)");
    expect(PANE_SOURCE).toContain("{ text: tab.text }");
    // And it is debounced, because every plan resolves a proto and walks the ancestor chain.
    expect(PANE_SOURCE).toContain("REPLAN_MS");
  });

  it("givenAFieldStillFocused_whenItHasNotCommitted_thenTheAsideIsAsCurrentAsSave", () => {
    // The draft the aside plans is the tab's, not the caret's, and that is the guarantee worth
    // having: `Field` commits on blur, so the command matches what a save would write rather than
    // what is momentarily in an input. Verified live — typing in the url changes nothing until
    // focus leaves, and the Save button lights up at the same instant the command changes.
    // Pinned here because a future idle-commit on `Field` would silently change what this pane
    // shows, and this is the line that should have to be edited on purpose when it does.
    expect(CONTROLS_SOURCE).not.toContain("IDLE_COMMIT");
    expect(CONTROLS_SOURCE).toContain("onBlur={(event) => {");
    // The pane reads the store, never the DOM, so there is no second source to disagree.
    expect(PANE_SOURCE).not.toContain("document.");
    expect(PANE_SOURCE).not.toContain("querySelector");
    expect(PANE_SOURCE).not.toContain("HTMLInputElement");
  });

  it("givenThePaneIsOpening_whenNothingHasBeenPressed_thenTheClipboardIsUntouched", () => {
    // Nothing is copyable until a plan lands, so the opening frame has no press to make.
    expect(canCopy(PLANNING)).toBe(false);
    // And there is exactly one clipboard write in the whole pane, inside the button's handler.
    const writes = PANE_SOURCE.match(/clipboard\.writeText/g) ?? [];
    expect(writes.length).toBe(1);
    expect(PANE_SOURCE).not.toContain("clipboard.readText");
  });
});

/**
 * The tokenizer, run for real. It reaches nothing - no window, no theme, no store - which is the
 * same property `editorTheme.ts` was given and for the same reason: the claim "this is coloured"
 * is worth an assertion rather than a screenshot.
 *
 * Node names are the tag strings the stream parser returned, which is how `StreamLanguage` names
 * them, so asserting on them is asserting on what `HIGHLIGHT_STYLE` will be asked for.
 */
describe("the shell command language", () => {
  function tokens(command: string): { text: string; tag: string }[] {
    const tree = shellCommand.parser.parse(command);
    const found: { text: string; tag: string }[] = [];
    tree.iterate({
      enter: (node) => {
        if (node.name === "Document") return;
        found.push({ text: command.slice(node.from, node.to), tag: node.name });
      },
    });
    return found;
  }

  function tagOf(command: string, text: string): string | undefined {
    return tokens(command).find((token) => token.text === text)?.tag;
  }

  it("givenACurl_whenTokenized_thenTheToolTheFlagsTheQuotedWordsAndTheUrlAreEachTheirOwnThing", () => {
    expect(tagOf(CURL_COMMAND, "curl")).toBe("variableName.function");
    expect(tagOf(CURL_COMMAND, "-H")).toBe("attributeName");
    expect(tagOf(CURL_COMMAND, "'accept: application/json'")).toBe("string");
    expect(tagOf(CURL_COMMAND, "https://api.example.test/v1/orders")).toBe("url");
  });

  it("givenAGrpcurl_whenTokenized_thenTheAuthorityIsATargetAndTheMethodIsNot", () => {
    expect(tagOf(GRPCURL_COMMAND, "grpcurl")).toBe("variableName.function");
    // `host:port` is a place, so it underlines with the urls. The method is a name and is not.
    expect(tagOf(GRPCURL_COMMAND, "127.0.0.1:50051")).toBe("url");
    expect(tagOf(GRPCURL_COMMAND, "test.echo.EchoService/Ping")).toBeUndefined();
  });

  it("givenAQuotedWordHoldingAQuote_whenTokenized_thenItIsOneStringAndNotThree", () => {
    // `quoteWords` writes an embedded `'` as `'\''`, which closes and reopens the string. A
    // tokenizer that stopped at the first close would end the token inside a header value.
    const command = String.raw`curl --data-raw 'it'\''s fine' https://api.example.test/x`;
    expect(tagOf(command, String.raw`'it'\''s fine'`)).toBe("string");
    expect(tagOf(command, "https://api.example.test/x")).toBe("url");
  });

  it("givenAGrpcurlLongFlag_whenTokenized_thenOneDashIsStillAFlag", () => {
    // grpcurl spells its long flags with a single dash, which a curl-shaped rule would miss.
    const command = "grpcurl -import-path /protos -proto a.proto 127.0.0.1:9090 pkg.S/M";
    expect(tagOf(command, "-import-path")).toBe("attributeName");
    expect(tagOf(command, "-proto")).toBe("attributeName");
    // Its value is an ordinary word: a path is not a target and colouring it would say it was.
    expect(tagOf(command, "/protos")).toBeUndefined();
  });
});
