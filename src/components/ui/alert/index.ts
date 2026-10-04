import { cva } from 'class-variance-authority'

export { default as Alert } from './Alert.vue'
export { default as AlertTitle } from './AlertTitle.vue'
export { default as AlertDescription } from './AlertDescription.vue'

export const alertVariants = cva(
  'relative w-full rounded-lg border px-3.5 py-3 text-sm [&>svg]:absolute [&>svg]:left-3.5 [&>svg]:top-3.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-foreground [&>svg~*]:pl-6',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground [&>svg]:text-muted-foreground',
        destructive:
          'border-destructive/25 bg-destructive/[0.06] text-destructive [&>svg]:text-destructive',
        success:
          'border-success/25 bg-success/[0.06] text-success [&>svg]:text-success',
        warning:
          'border-warning/25 bg-warning/[0.06] text-warning [&>svg]:text-warning',
        info: 'border-info/25 bg-info/[0.06] text-info [&>svg]:text-info',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)
