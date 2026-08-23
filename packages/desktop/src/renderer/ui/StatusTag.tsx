/**
 * A response status worn as a tag: `200`, `404`, `OK`, `NOT_FOUND`.
 *
 * One component for both transports on purpose. A `404` and a `NOT_FOUND` are the same
 * event and the reader should not have to learn two visual languages to see that; the
 * mapping that makes them the same colour lives in `statusTone`.
 *
 * The tone is decided in `model/response.ts` and only painted here, which is why this
 * takes a status rather than a colour.
 */
import type { ReactElement } from "react";

import { statusText, statusTone, toneTagClass } from "@preman/desktop/renderer/model/response.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";

/**
 * Deliberately not a control height. This is a label inside a row, so it is sized by its
 * own text and must not push out the `h-tab` chrome row it usually sits in.
 */
const TAG_CLASS = "shrink-0 rounded-sm px-1.5 py-px font-mono text-2xs";

export function StatusTag({ status }: { readonly status: number | string }): ReactElement {
  return <span className={cn(TAG_CLASS, toneTagClass(statusTone(status)))}>{statusText(status)}</span>;
}
