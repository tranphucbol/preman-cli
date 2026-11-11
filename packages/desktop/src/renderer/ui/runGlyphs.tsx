/**
 * Run, Run All and Stop, as table-craft draws them, copied rather than redrawn so the two apps keep
 * one shape for one verb. They sit on Phosphor's `IconBase`, so `IconContext`, `size`, `className`
 * and `color` reach them exactly as they reach every other glyph.
 */
import { IconBase, type Icon, type IconWeight } from "@phosphor-icons/react";
import { forwardRef, type ReactElement } from "react";

/**
 * Corner radius in the 256-unit view box, about 2px at 16px. Phosphor's own Play and Stop round by
 * 16 units, which reads sharp at that size.
 */
const CORNER = 24;
/** The square's radius, a little larger so it reads as round as the triangles' corners. */
const STOP_CORNER = 32;
/** No per-weight drawings: the shapes are solid at every weight, so the weight prop is ignored. */
const NO_WEIGHTS = new Map<IconWeight, ReactElement>();

function RoundedPolygon({ points }: { readonly points: string }) {
  return <polygon points={points} stroke="currentColor" strokeWidth={CORNER * 2} strokeLinejoin="round" />;
}

/** A solid triangle with soft corners. */
export const RunGlyph: Icon = forwardRef(function RunGlyph(props, ref) {
  return (
    <IconBase ref={ref} {...props} weights={NO_WEIGHTS}>
      <RoundedPolygon points="84,58 84,198 193,128" />
    </IconBase>
  );
});

/** Two soft triangles: run everything under this node. */
export const RunAllGlyph: Icon = forwardRef(function RunAllGlyph(props, ref) {
  return (
    <IconBase ref={ref} {...props} weights={NO_WEIGHTS}>
      <RoundedPolygon points="43,80 43,176 113,128" />
      <RoundedPolygon points="143,80 143,176 213,128" />
    </IconBase>
  );
});

/** A solid square with soft corners. */
export const StopGlyph: Icon = forwardRef(function StopGlyph(props, ref) {
  return (
    <IconBase ref={ref} {...props} weights={NO_WEIGHTS}>
      <rect x={40} y={40} width={176} height={176} rx={STOP_CORNER} />
    </IconBase>
  );
});
