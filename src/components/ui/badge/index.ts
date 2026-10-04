import { cva, type VariantProps } from "class-variance-authority";

export { default as Badge } from "./Badge.vue";

export const badgeVariants = cva(
  [
    "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border font-medium tabular-nums leading-none",
    "transition-colors duration-fast",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  ],
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        // Status tones: soft tint + text-grade colour (WCAG AA in both themes)
        success: "border-success/20 bg-success/10 text-success",
        warning: "border-warning/20 bg-warning/10 text-warning",
        destructive: "border-destructive/20 bg-destructive/10 text-destructive",
        info: "border-info/20 bg-info/10 text-info",
        muted: "border-border bg-muted text-muted-foreground",
        accent: "border-primary/20 bg-primary/10 text-link",
      },
      size: {
        default: "h-5 px-1.5 text-xs",
        sm: "h-4 rounded-[4px] px-1 text-2xs",
        lg: "h-6 px-2 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export type BadgeVariants = VariantProps<typeof badgeVariants>;
