export { default as Toaster } from "./Toaster.vue";
export { default as Toast } from "./Toast.vue";
export { default as ToastViewport } from "./ToastViewport.vue";
export { default as ToastAction } from "./ToastAction.vue";
export { default as ToastClose } from "./ToastClose.vue";
export { default as ToastTitle } from "./ToastTitle.vue";
export { default as ToastDescription } from "./ToastDescription.vue";
export { default as ToastProvider } from "./ToastProvider.vue";
export { toast, useToast } from "./use-toast";

import { cva } from "class-variance-authority";

/**
 * Compact neutral card; the variant shows as a 3px accent stripe on the
 * leading edge plus a matching icon (rendered by Toaster).
 */
export const toastVariants = cva(
  [
    "group pointer-events-auto relative flex w-full items-start gap-3 overflow-hidden rounded-lg border bg-popover py-3 pl-4 pr-9 text-popover-foreground shadow-lg",
    "before:absolute before:inset-y-0 before:left-0 before:w-[3px]",
    "transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none",
    "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2 data-[state=open]:zoom-in-[0.98] data-[state=open]:duration-200 data-[state=open]:ease-out",
    "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right-1/2 data-[state=closed]:duration-150 data-[swipe=end]:animate-out",
  ],
  {
    variants: {
      variant: {
        default: "before:bg-border-strong",
        destructive: "destructive before:bg-destructive",
        success: "success before:bg-success",
        warning: "warning before:bg-warning",
        info: "info before:bg-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);
