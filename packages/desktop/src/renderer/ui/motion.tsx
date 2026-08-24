/**
 * The one door Motion comes through. Everything else in this app moves in CSS; two surfaces
 * cannot, because they are conditional renders and a element that has been unmounted has no
 * transition left to run. Those two get a JS runtime, and this module is the whole of it.
 *
 * `LazyMotion strict` is the point, not a nicety: it throws if a full `motion.*` component is
 * rendered inside, so the library cannot grow a second entrance. `m` is re-exported here so no
 * other module names it and the ESLint fence has exactly one file to exempt. Decision 26.
 *
 * `domMax` rather than `domAnimation`, and it is not free: measured at +46,815 bytes of built
 * renderer chunk, 1,269,059 -> 1,315,874. Decision 26 priced the projection engine at "another
 * 10 kB" and refused it on that basis; that figure was gzipped and from an older major, and
 * Electron loads this chunk over `file://`, so raw is the only honest number. It is here for one
 * thing - the tab underline's `layoutId` in `Tabs.tsx` - and `motion.test.ts` asserts it stays
 * that one thing.
 *
 * When animating, animate `opacity` and a composed `transform` string - never `x`, `y`, `scale`
 * or `rotate`. Those shorthands are excluded from Motion's compositor path, so they animate on
 * the main thread, which is precisely the thing the interaction budgets in decision 17 measure.
 * `layoutId` is the one exception: projection composes its own `transform` matrix from two
 * measured boxes, so it never touches those shorthands.
 */
import type { ReactElement, ReactNode } from "react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";

export { AnimatePresence } from "motion/react";

/* `export * as m` rather than a named re-export: `motion/react-m` publishes one export per tag, and
 * the `m` object on `motion/react` is the whole tag table in a single binding, which is the thing
 * that does not tree-shake. The namespace form is what makes `<m.div>` cost one component. */
export * as m from "motion/react-m";

export function MotionRoot({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    /* `reducedMotion="user"` is the JS half of decision 10. The CSS half is the
     * `prefers-reduced-motion` block in `app.css`; neither covers the other, so the preference is
     * honoured twice on purpose. */
    <MotionConfig reducedMotion="user">
      {/* `features` synchronously rather than the async loader: an async feature import over
       * `file://` would put a second round trip in front of the first banner, and the renderer is
       * one chunk already, so there is nothing to defer to. */}
      <LazyMotion features={domMax} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
