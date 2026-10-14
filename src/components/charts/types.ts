/* The data of a TimeSeriesChart: values on a shared timeline (one slot per point). */

export type Values = (number | null)[];

/** Series colours come from theme tokens. */
export type SeriesTone = "primary" | "info" | "neutral";

export const TONE_COLORS: Record<SeriesTone, string> = {
  primary: "hsl(var(--primary))",
  info: "hsl(var(--info))",
  neutral: "hsl(var(--muted-foreground))",
};

export interface ChartSeries {
  id: string;
  label: string;
  values: Values;
  tone: SeriesTone;
  /** A soft gradient under the line. */
  fill?: boolean;
}

/** A faint reference line: a request, a limit, a node's allocatable. */
export interface ChartReference {
  id: "request" | "limit" | "allocatable";
  label: string;
  /** A constant, or a series (it changes over time, drawn stepped). */
  values: Values | number;
}

/** Something that happened at a point in time (a container restart). */
export interface ChartMarker {
  /** Slot index on the timeline. */
  index: number;
  label: string;
  detail?: string;
}
