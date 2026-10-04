const animate = require("tailwindcss-animate");
const defaultTheme = require("tailwindcss/defaultTheme");

/**
 * JET Pilot design system — see docs/design-system.md.
 *
 * All colours are HSL channel triplets defined as CSS variables in
 * src/assets/main.postcss (light on :root, dark on .dark). They are wired
 * here with `<alpha-value>` so opacity modifiers (`bg-success/10`,
 * `border-border/60`, `ring-ring/30`) work for every token.
 */
const token = (name) => `hsl(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],

  content: [
    "./pages/**/*.{ts,tsx,vue}",
    "./components/**/*.{ts,tsx,vue}",
    "./app/**/*.{ts,tsx,vue}",
    "./src/**/*.{ts,tsx,vue}",
  ],

  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: ["Inter Variable", "Inter", ...defaultTheme.fontFamily.sans],
        mono: [
          "JetBrains Mono Variable",
          "JetBrains Mono",
          ...defaultTheme.fontFamily.mono,
        ],
      },
      // Desktop-density type scale. 13px (`text-sm`) is the base UI size.
      fontSize: {
        xxs: ["0.625rem", { lineHeight: "0.875rem" }], // 10 / 14
        "2xs": ["0.625rem", { lineHeight: "0.875rem" }], // 10 / 14
        xs: ["0.6875rem", { lineHeight: "1rem" }], // 11 / 16
        sm: ["0.8125rem", { lineHeight: "1.25rem" }], // 13 / 20 (base UI)
        base: ["0.875rem", { lineHeight: "1.375rem" }], // 14 / 22
        lg: ["1rem", { lineHeight: "1.5rem", letterSpacing: "-0.006em" }], // 16 / 24
        xl: ["1.125rem", { lineHeight: "1.625rem", letterSpacing: "-0.011em" }], // 18 / 26
        "2xl": ["1.375rem", { lineHeight: "1.75rem", letterSpacing: "-0.017em" }], // 22 / 28
        "3xl": ["1.75rem", { lineHeight: "2.125rem", letterSpacing: "-0.021em" }], // 28 / 34
        "4xl": ["2.25rem", { lineHeight: "2.5rem", letterSpacing: "-0.022em" }], // 36 / 40
      },
      rotate: {
        270: "270deg",
      },
      // Finer steps for tints/hover states (Tailwind 3.3 lacks these)
      opacity: {
        3: "0.03",
        4: "0.04",
        6: "0.06",
        8: "0.08",
        12: "0.12",
        15: "0.15",
        35: "0.35",
        85: "0.85",
      },
      backdropBlur: {
        xxs: "1px",
      },
      colors: {
        border: {
          DEFAULT: token("border"),
          subtle: token("border-subtle"),
          strong: token("border-strong"),
        },
        input: token("input"),
        ring: token("ring"),
        background: token("background"),
        foreground: token("foreground"),
        surface: {
          DEFAULT: token("surface-2"),
          1: token("surface-1"),
          2: token("surface-2"),
          3: token("surface-3"),
        },
        sidebar: {
          DEFAULT: token("sidebar"),
          foreground: token("sidebar-foreground"),
        },
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
        },
        link: token("link"),
        secondary: {
          DEFAULT: token("secondary"),
          foreground: token("secondary-foreground"),
        },
        destructive: {
          DEFAULT: token("destructive"),
          foreground: token("destructive-foreground"),
        },
        success: {
          DEFAULT: token("success"),
          foreground: token("success-foreground"),
        },
        warning: {
          DEFAULT: token("warning"),
          foreground: token("warning-foreground"),
        },
        info: {
          DEFAULT: token("info"),
          foreground: token("info-foreground"),
        },
        muted: {
          DEFAULT: token("muted"),
          foreground: token("muted-foreground"),
        },
        accent: {
          DEFAULT: token("accent"),
          foreground: token("accent-foreground"),
        },
        popover: {
          DEFAULT: token("popover"),
          foreground: token("popover-foreground"),
        },
        card: {
          DEFAULT: token("card"),
          foreground: token("card-foreground"),
        },
        overlay: "hsl(var(--overlay) / var(--overlay-alpha))",
        tooltip: {
          DEFAULT: token("tooltip"),
          foreground: token("tooltip-foreground"),
        },
      },
      borderRadius: {
        xs: "calc(var(--radius) - 6px)", // 2px
        sm: "calc(var(--radius) - 4px)", // 4px
        md: "calc(var(--radius) - 2px)", // 6px
        lg: "var(--radius)", // 8px
        xl: "calc(var(--radius) + 4px)", // 12px
        "2xl": "calc(var(--radius) + 8px)", // 16px
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        DEFAULT: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        popover: "var(--shadow-md)",
        dialog: "var(--shadow-lg)",
        highlight: "var(--shadow-highlight)",
        button: "var(--shadow-highlight), var(--shadow-xs)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
        fast: "120ms",
        base: "160ms",
        slow: "200ms",
      },
      transitionTimingFunction: {
        DEFAULT: "cubic-bezier(0.2, 0, 0, 1)",
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
        in: "cubic-bezier(0.4, 0, 1, 1)",
        "in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
        "collapsible-down": {
          from: { height: 0 },
          to: { height: "var(--radix-collapsible-content-height)" },
        },
        "collapsible-up": {
          from: { height: "var(--radix-collapsible-content-height)" },
          to: { height: 0 },
        },
        "pulse-highlight": {
          "0%": { backgroundColor: "hsla(var(--primary) / 0%)" },
          "50%": { backgroundColor: "hsl(var(--primary))" },
        },
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "fade-out": { from: { opacity: 1 }, to: { opacity: 0 } },
        "scale-in": {
          from: { opacity: 0, transform: "scale(0.97)" },
          to: { opacity: 1, transform: "scale(1)" },
        },
        "scale-out": {
          from: { opacity: 1, transform: "scale(1)" },
          to: { opacity: 0, transform: "scale(0.97)" },
        },
        "slide-up-fade": {
          from: { opacity: 0, transform: "translateY(4px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "status-ping": {
          "75%, 100%": { transform: "scale(2.2)", opacity: 0 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s cubic-bezier(0.16, 1, 0.3, 1)",
        "accordion-up": "accordion-up 0.16s cubic-bezier(0.16, 1, 0.3, 1)",
        "collapsible-down": "collapsible-down 0.2s ease-in-out",
        "collapsible-up": "collapsible-up 0.2s ease-in-out",
        "spin-fast": "spin .5s linear infinite",
        "pulse-highlight-once": "pulse-highlight .5s 2 linear",
        "fade-in": "fade-in 160ms cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-out": "fade-out 120ms cubic-bezier(0.4, 0, 1, 1)",
        "scale-in": "scale-in 180ms cubic-bezier(0.16, 1, 0.3, 1)",
        "scale-out": "scale-out 120ms cubic-bezier(0.4, 0, 1, 1)",
        "slide-up-fade": "slide-up-fade 200ms cubic-bezier(0.16, 1, 0.3, 1)",
        shimmer: "shimmer 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        "status-ping": "status-ping 1.6s cubic-bezier(0, 0, 0.2, 1) infinite",
      },
    },
  },
  plugins: [animate],
};
