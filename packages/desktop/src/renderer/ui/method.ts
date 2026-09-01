/**
 * The verb, in the one colour the whole app agrees on.
 *
 * `app.css` keys the method tokens by verb so that a row cannot invent a colour. This keys the
 * classes the same way so that three panes cannot disagree about which token that is: the sidebar,
 * the tab strip and the method picker all read this function, which is what makes "the same green"
 * a fact rather than a coincidence.
 *
 * `HEAD` and `OPTIONS` are deliberately absent. They are in `HTTP_METHODS` and they are in the
 * picker, but a colour is something the eye has to learn, and five is already the budget; the two
 * verbs nobody sends fall through to plain ink.
 */

const METHOD_CLASS: Record<string, string> = {
  GET: "text-method-get",
  POST: "text-method-post",
  PUT: "text-method-put",
  PATCH: "text-method-patch",
  DELETE: "text-method-delete",
};

/** An unkeyed verb reads as text rather than as an error: it is a method, just not a famous one. */
const UNKEYED_CLASS = "text-ink-dim";

/**
 * What stands in the verb's place when there is no verb.
 *
 * gRPC reads `gRPC` rather than the method tail, in the sidebar and in the tab strip both. The tail
 * can be any length, so it either truncates to nothing useful or it widens the column; and where an
 * HTTP row says which of five things it does, a gRPC row's tail says only what its own name already
 * said. The protocol is the part the eye cannot get anywhere else. The full path is one click away.
 */
export const GRPC_LABEL = "gRPC";

/** A kind preman cannot run still gets a slot, so the column does not shift under it. */
export const UNSUPPORTED_LABEL = "n/a";

export function methodClass(verb: string | undefined): string {
  if (verb === undefined) return UNKEYED_CLASS;
  return METHOD_CLASS[verb] ?? UNKEYED_CLASS;
}
