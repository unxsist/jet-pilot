import { cva, type VariantProps } from "class-variance-authority";

export { default as Kbd } from "./Kbd.vue";

export const kbdVariants = cva(
  "pointer-events-none inline-flex select-none items-center justify-center gap-0.5 rounded-[4px] font-sans font-medium tabular-nums leading-none",
  {
    variants: {
      variant: {
        // Raised keycap on any surface
        default:
          "border border-border bg-surface-2 text-muted-foreground shadow-[inset_0_-1px_0_0_hsl(var(--border))]",
        // Flat, for use inside highlighted rows / tooltips
        ghost: "bg-foreground/[0.07] text-current opacity-80",
      },
      size: {
        default: "h-5 min-w-[1.25rem] px-1 text-xs",
        sm: "h-4 min-w-[1rem] px-0.5 text-2xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export type KbdVariants = VariantProps<typeof kbdVariants>;
