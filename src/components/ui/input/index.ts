export { default as Input } from "./Input.vue";

/**
 * Shared text-field styling (Input, Textarea, NumberFieldInput, TagsInput,
 * SelectTrigger). Focus uses the accent border + soft halo instead of an
 * offset ring so fields stay aligned in dense forms.
 */
export const fieldBase = [
  "w-full rounded-md border border-input bg-background text-sm text-foreground shadow-xs",
  "transition-[border-color,box-shadow,background-color] duration-fast ease-out",
  "placeholder:text-muted-foreground/80",
  "hover:border-border-strong",
  "focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/20",
].join(" ");
