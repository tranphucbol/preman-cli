/**
 * Turning a request's message body into the value that goes on the wire.
 *
 * A gRPC message has to be parsed to be built into a protobuf at all, which is what puts it on the
 * side of the line where a comment is unambiguously not data. Decision 047 draws that line and
 * `@preman/core/json/comments.js` holds the mechanism; this module is the gRPC end of it.
 */
import { PremanError } from "@preman/core/errors.js";
import { maskComments, offendingLine } from "@preman/core/json/comments.js";

const NOTHING_TO_PARSE = "";

/**
 * Parse a message body, or throw a {@link PremanError} that says where to look.
 *
 * An empty body is an empty message rather than an error: a unary method whose request type has
 * no required field is legitimately called with `{}`, and making the author type it would be
 * ceremony. A body that is nothing but comments is empty by the same reading.
 */
export function parseMessageBody(raw: string, label: string): unknown {
  if (raw.trim().length === NOTHING_TO_PARSE.length) return {};
  const source = maskComments(raw);
  if (source.trim().length === NOTHING_TO_PARSE.length) return {};
  try {
    return JSON.parse(source);
  } catch (cause) {
    const message = (cause as Error).message;
    throw new PremanError(`${label}: ${message}`, { details: offendingLine(raw, message) });
  }
}
