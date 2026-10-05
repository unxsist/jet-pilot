/*
 * Classes shared by the calm dialogs (adding clusters, signing in, export,
 * cluster details): a column with WizardHeader, a scrolling body and a
 * WizardFooter, so every step and dialog has the same shape.
 */

/** On DialogContent. */
export const WIZARD_DIALOG =
  "flex max-h-[min(46rem,calc(100vh-4rem))] max-w-[37.5rem] flex-col gap-0 overflow-hidden p-0";

/** The scrolling body between the header and the footer. */
export const WIZARD_BODY = "min-h-0 flex-1 overflow-y-auto px-6 pb-6";

/** A list of calm rows inside the body: rows bleed into the padding so their text lines up with the title. */
export const WIZARD_LIST = "-mx-3";

/** A calm row: hover tint, no borders. */
export const WIZARD_ROW =
  "flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-fast hover:bg-accent/50";

/** A small heading over a group of rows. */
export const WIZARD_GROUP_LABEL = "text-xs font-medium text-muted-foreground";

/** An error under a form: a quiet tint, no border. */
export const WIZARD_ERROR =
  "flex items-start gap-2 whitespace-pre-line rounded-lg bg-destructive/[0.07] px-3 py-2.5 text-xs text-destructive";
