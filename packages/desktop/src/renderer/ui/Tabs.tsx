/**
 * The tab trigger, and the one underline that travels between them.
 *
 * Four groups render this: the request editor's section tabs, its Edit/Preview switch, the response
 * tabs, and the settings pane's Appearance/Diagnostics switch. The first three used to declare the
 * same class string - twice, in two files - which is how controls that are one visual idea drift
 * apart. They share it here instead, and the fourth was written against it rather than beside it.
 *
 * The underline is an element rather than the trigger's own bottom border, because a border cannot
 * travel. Motion projects the outgoing element's box onto the incoming one, so the accent bar
 * slides from Params to Auth instead of blinking. That is `layoutId`, which is the projection
 * engine `motion.tsx` pays 46,815 bytes for, and this is the only place in the app that uses it.
 * Decision 26, as corrected by plan 019.
 *
 * `active` is a prop rather than something read off Radix: `Tabs.Trigger` publishes its state as a
 * `data-state` attribute for CSS and not to its own children, and every call site already holds
 * the current value, which is what it passes to `Tabs.Root`.
 */
import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { useId } from "react";

import { m } from "./motion.js";

/**
 * `border-b-2 border-transparent` stays even though the accent border is gone: it reserves the
 * underline's 2px lane, so the label sits exactly where it sat before the underline became an
 * element. Removing it would move every tab label in the app up by a pixel.
 *
 * The colour transition is the same one every other control got: a trigger whose text snaps
 * between dim and ink, beside buttons that fade, reads as a different kind of control.
 */
const TAB_TRIGGER_CLASS =
  "relative h-tab shrink-0 border-b-2 border-transparent px-2.5 text-xs text-ink-dim transition-[color] duration-(--duration-press) ease-out hover:text-ink data-[state=active]:text-ink";

/**
 * `-bottom-0.5` rather than `bottom-0`, because an absolutely positioned child is placed against
 * its ancestor's padding box - which stops 2px short of the border lane the underline is meant to
 * fill. The negative offset is what puts it back on the pixels `border-b-2` used to paint.
 */
const UNDERLINE_CLASS = "absolute inset-x-0 -bottom-0.5 h-0.5 bg-accent";

/**
 * 150ms is `--duration-menu`: this is a small indicator answering a discrete choice, the same
 * class of movement as a surface arriving. Restated rather than read from the token because a
 * custom property is not readable from a Motion transition; the curve is `--ease-out`, and
 * `motion.test.ts` is what keeps every restatement of it identical.
 */
const UNDERLINE_TIMING = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

/**
 * One call per `Tabs.List`. Not a module constant: two `ResponseView`s can be mounted at once -
 * the collection runner holds its own - and two mounted groups sharing a `layoutId` make the
 * underline fly across the window from one pane to the other.
 */
export function useTabUnderline(): string {
  return useId();
}

export function TabTrigger({
  value,
  active,
  underline,
  children,
}: {
  readonly value: string;
  readonly active: boolean;
  readonly underline: string;
  readonly children: ReactNode;
}) {
  return (
    <TabsPrimitive.Trigger value={value} className={TAB_TRIGGER_CLASS}>
      {children}
      {active && <m.span layoutId={underline} className={UNDERLINE_CLASS} transition={UNDERLINE_TIMING} />}
    </TabsPrimitive.Trigger>
  );
}
