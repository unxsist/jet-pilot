# JET Pilot design system

A calm, dense, pro-tool look (Linear / Raycast / Vercel): neutral zinc
surfaces, one indigo accent, hairline borders, soft layered shadows, quick
motion. Dark is the primary theme; light is equally supported.

Sources of truth:

- Tokens: `src/assets/main.postcss` (`:root` = light, `.dark` = dark)
- Tailwind wiring: `tailwind.config.js`
- Primitives: `src/components/ui/**`

Theme switching: `ThemeProvider` (`useTheme()`) keeps `class="dark"` /
`"light"` on `<html>` through VueUse `useColorMode` (Tailwind
`darkMode: "class"`); the class follows the painted theme's appearance.
Themes other than JET override the tokens as inline custom properties on
`<html>`, so anything styled through tokens follows every theme. Always
style through tokens. Avoid raw palette colours
like `text-red-500`, `bg-gray-800` or `bg-white`. They don't adapt to the
theme and skip the contrast checks.

## Colour tokens

Every colour is an HSL triplet wired with `<alpha-value>`, so opacity
modifiers work everywhere (`bg-success/10`, `border-border/60`).

### Surfaces (elevation ladder)

| Token / class                    | Use for                                                          | Dark          | Light         |
| -------------------------------- | ---------------------------------------------------------------- | ------------- | ------------- |
| `bg-background`                  | Canvas behind content: tables, editors, main view                | `#101011`     | `#ffffff`     |
| `bg-surface-1` / `bg-sidebar`    | App chrome: navigation, tab bar, toolbars, status bar            | `#151517`     | `#f6f6f7`     |
| `bg-surface-2` / `bg-card`       | Panels: side panel, cards, grouped settings, sticky table header | `#18181b`     | `#ffffff`     |
| `bg-surface-3` / `bg-popover`    | Overlays: menus, popovers, dialogs, command palette, toasts      | `#1c1c1f`     | `#ffffff`     |
| `bg-muted`                       | Quiet fills: skeletons, tracks, segmented-control bg, code       | `#222225`     | `#f4f4f5`     |
| `bg-accent`                      | Hover / highlighted row / open trigger (neutral)                 | `#252528`     | `#efeff1`     |
| `bg-overlay`                     | Modal backdrop (alpha is baked into the token)                   | black / 50%   | ink / 28%     |

In dark mode each surface step is slightly lighter than the one below it.
In light mode, content and overlays are white and the chrome is a cool
grey. Elevation then comes from borders and shadows. So a panel always
gets `bg-card border` (plus `shadow-xs` if it floats), never just a
background colour.

The app root (`App.vue`) is `bg-sidebar`. Views draw their content area
on `bg-background`.

### Text

| Class                   | Use                                                         | Contrast (dark / light, on canvas) |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------- |
| `text-foreground`       | Primary text                                                | 16.1 / 18.7                        |
| `text-muted-foreground` | Secondary text, labels, table headers, timestamps           | 6.7 / 5.6                          |
| `text-sidebar-foreground` | Navigation labels                                         | AA                                 |
| `text-link`             | Inline accent text: links, highlighted matches, active nav  | 6.5 / 7.8                          |

`text-primary` uses the fill-grade indigo. Use it for icons, indicators
and large text only: it is 3.8:1 on the dark canvas. For small accent text,
use `text-link`.

### Accent

`primary` is indigo. Dark: `hsl(243 80% 64%)` `#615aed`. Light:
`hsl(243 75% 59%)` `#5048e5`. White text on it passes AA (5.0 / 6.2).
Use it for:

- One primary action per view (`<Button>`)
- Selection: `data-[state=selected]:bg-primary/10`
- Focus rings (`ring-ring`), switches, checkboxes, progress, the active
  tab underline

Don't use it as a decorative colour.

### Status

| Tone          | Dark                 | Light                | Meaning                                        |
| ------------- | -------------------- | -------------------- | ---------------------------------------------- |
| `success`     | `#36c984`            | `#117948`            | Running, Ready, Bound, deployed                |
| `warning`     | `#f6ae31`            | `#aa5409`            | Pending, ContainerCreating, Terminating, Init  |
| `destructive` | `#f26464`            | `#ca2121`            | Failed, CrashLoopBackOff, Error, OOMKilled     |
| `info`        | `#54a0f8`            | `#1160d0`            | Informational, syncing                         |
| muted         | `muted-foreground`   | `muted-foreground`   | Completed, Succeeded, Unknown                  |

The `DEFAULT` of each status colour is text-grade. It passes WCAG AA as
text on the canvas and on its own 10% tint in both themes. Approved
patterns:

- Status text in a table cell: `text-success`
- Soft pill: `border-success/20 bg-success/10 text-success`, or just
  `<Badge variant="success">` / `<StatusBadge>`
- Dot: `bg-success`, or `<StatusDot tone="success">`
- Solid fill (rare): `bg-success text-success-foreground`. In dark mode the
  foreground is a dark ink.

Use tints of 10% or less behind status text. At 15% and above, light-mode
warning text drops below AA.

For Kubernetes states, use `statusTone(phaseOrReason)` from
`@/components/ui/status`. Then map the tone to classes with
`statusTextClass`, `statusDotClass` or `statusSoftClass`. This also works
inside a column's `meta.class` callback.

### Lines

| Class                  | Use                                                        |
| ---------------------- | ---------------------------------------------------------- |
| `border` (default)     | Hairline borders on panels, inputs, overlays               |
| `border-border-subtle` | Row dividers, dividers inside a card                       |
| `border-border-strong` | Hover border on inputs/outline buttons, tooltip edge (dark) |
| `border-input`         | Form control borders                                       |

Borders are opaque. They are tuned to read like a roughly 8% alpha
hairline on the surfaces above. When a border sits on arbitrary content
(images, coloured banners), use `border-foreground/10` instead.

## Shape, depth, motion

- **Radius** (`--radius` = 8px): `rounded-sm` 4px for badges and kbd,
  `rounded-md` 6px for buttons and inputs, `rounded-[5px]` for menu rows,
  `rounded-lg` 8px for cards and menus, `rounded-xl` 12px for dialogs and
  the palette.
- **Shadows**: `shadow-xs` for buttons, inputs and cards; `shadow-sm` for
  the active segmented tab; `shadow-md` for menus, popovers and tooltips;
  `shadow-lg` for dialogs and toasts; `shadow-xl` for the command palette.
  `shadow-button` adds a top highlight to solid buttons. Dark shadows are
  deeper and include a faint inset top highlight.
- **Motion**: `duration-fast` 120ms for hover and colour changes,
  `duration-base` 160ms, `duration-slow` 200ms. Easing: `ease-out`
  (expo-out) for anything entering; `ease-in` for exits. Overlays fade and
  scale from 0.97 in 150–200ms and exit in 100–150ms. Keyframes
  `animate-scale-in/out`, `fade-in/out`, `slide-up-fade`, `shimmer` and
  `status-ping` are available. `prefers-reduced-motion` disables motion
  globally, but spinners keep spinning.
- **Focus**: every interactive element shows a 2px accent ring with a 2px
  offset (`.focus-ring`, or the classes in `buttonVariants`). Text fields
  instead use an accent border plus a 3px soft halo (`fieldBase` in
  `ui/input`). A global `:focus-visible` outline covers bare buttons and
  links. Don't remove it without replacing it.

## Typography

Fonts are bundled locally (no CDN): Inter Variable for UI text (`font-sans`,
features `cv11` and `ss01`) and JetBrains Mono Variable (`font-mono`) for
code, logs, YAML, IDs and kbd. The `rem` stays 16px, so the spacing scale
is unchanged. UI text is 13px.

| Class       | Size / line height | Use                                              |
| ----------- | ------------------ | ------------------------------------------------ |
| `text-2xs`  | 10 / 14            | Micro labels, small kbd (`text-xxs` is an alias) |
| `text-xs`   | 11 / 16            | Table headers, badges, captions, hints           |
| `text-sm`   | 13 / 20            | **Default UI text**: body, menus, inputs, cells  |
| `text-base` | 14 / 22            | Dialog titles, emphasized body                   |
| `text-lg`   | 16 / 24            | Section titles                                   |
| `text-xl`   | 18 / 26            | Page titles                                      |
| `text-2xl`  | 22 / 28            | Hero / empty-state headings (rare)               |

Weights: 400 for body, 500 (`font-medium`) for labels, buttons and titles,
600 (`font-semibold`) for page and dialog headings only. Larger sizes have
tighter tracking built in.

Numbers: use `tabular-nums` (or `.tnum`) for counts, ages, resources and
anything else in a column. In tables, use `<TableCell numeric>` and
`<TableHead numeric>`, which right-align and apply tabular numerals. Don't
put tabular numerals on name columns: hashes look letter-spaced.

## Spacing and density

The spacing scale is Tailwind's 4px grid. The density targets:

- Control heights: 24px (`xs`), 28px (`sm`, menu rows), 32px (default
  buttons and inputs, table header), 36px (`lg`, command items)
- Table rows: about 32–36px. Cells use `px-2.5 py-1.5`.
- Padding: 16px (`p-4`) in cards; 20px (`p-5`) in dialogs; 4px (`p-1`)
  in menus
- Gaps: 6–8px (`gap-1.5`/`gap-2`) between inline controls; 12–16px between
  groups

## Components (`@/components/ui/*`)

| Component | Notes |
| --- | --- |
| `Button` | variants `default` (primary), `secondary`, `outline`, `subtle`, `ghost`, `destructive`, `link`; sizes `xs`, `sm`, `default`, `lg`, `icon`, `icon-sm`, `icon-xs`. Destructive is solid red in light mode and soft red in dark mode. Size icons at the call site (`h-4` default, `h-3.5` sm, `h-3` xs). |
| `Badge` | variants `default`, `secondary`, `outline`, `accent`, `success`, `warning`, `destructive`, `info`, `muted`; sizes `sm`, `default`, `lg`. |
| `StatusBadge` / `StatusDot` (`ui/status`) | `<StatusBadge status="CrashLoopBackOff" />` infers the tone; `<StatusDot tone="warning" pulse />`. Also exports `statusTone()` and the class maps. |
| `Kbd` | `<Kbd>⌘</Kbd>` or `<Kbd :keys="['⌘','K']" />`. Variants `default` and `ghost` (for use inside tooltips and highlighted rows); sizes `default` and `sm`. |
| `EmptyState` | Props `icon`, `title`, `description`, `size="sm"`; slots `icon`, `title`, default, `action`. Use it for empty tables, panels and search results. |
| `Card` (+ `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`) | Panel surface with a hairline border. |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `TabsList variant="segmented"` (default, pill control) or `variant="line"` (underline, for panel sections). |
| `Input`, `Textarea`, `NumberField*`, `TagsInput*`, `Select*` | All share `fieldBase` (32px tall). Set `aria-invalid="true"` (or `invalid` on `SelectTrigger`) for the error state. |
| `Checkbox`, `Switch`, `Label`, `Form*` | Switch is new; it's an 18×32 track. |
| `Dialog*`, `AlertDialog*` | Blurred backdrop, `rounded-xl` popover surface. `DialogContent` accepts `closeable`, `position="center"\|"top"` and `overlayClass`. |
| `DropdownMenu*`, `ContextMenu*` | Compact rows. `*Item` accepts `variant="destructive"`. `*Shortcut` is a right-aligned muted hint. Recipes live in `ui/overlay-styles.ts`. |
| `Popover`, `Tooltip` | Tooltips are inverse-contrast `text-xs` with a 300ms delay. Put `Kbd variant="ghost" size="sm"` inside for shortcuts. |
| `Command*` | Palette is anchored 14vh from the top, with group headings, an accent rail on the highlighted item and a hint footer (`hints` prop). `CommandShortcut` renders as a kbd. |
| `Toast` / `toast()` | Variants `default`, `success`, `warning`, `info`, `destructive`. Each shows a coloured stripe and icon on a neutral card. |
| `Table*` | Compact header, subtle dividers, selected rows tinted `primary/10`, `numeric` prop. `TableHead sticky` stays opaque. |
| `Alert` | Variants `default`, `info`, `success`, `warning`, `destructive` (tinted). |
| `Skeleton`, `Progress`, `Separator`, `ScrollArea`, `Resizable*`, `Accordion*`, `Carousel*` | Restyled on tokens. |

## Guidance for screen work (phase 2)

1. Apply the surface ladder. Chrome (navigation, tab bar, toolbars) goes on
   `bg-sidebar`. Content goes on `bg-background`. The side panel uses
   `bg-card` with a left `border`. Separate regions with hairline borders,
   not with different greys stacked together.
2. Replace hard-coded colours in tables, for example `text-green-500` and
   `text-red-500` in `components/tables/pods.ts` and `helm-release.ts`,
   with `statusTextClass[statusTone(x)]` or a `StatusBadge` cell. Add
   `tnum`/`text-right` through `meta.class` for numeric columns.
3. Use `text-muted-foreground` for secondary information and keep
   `text-foreground` for the primary value. Avoid `opacity-*` for text
   hierarchy, because it breaks the contrast checks.
4. Use one primary button per surface. Other buttons should be `outline`,
   `ghost` or `subtle`, and toolbars should use `size="sm"`/`"icon-sm"`.
5. Empty and loading states: `EmptyState` and `Skeleton` instead of bare
   "No results." text.
6. Shortcut hints: `Kbd` in tooltips, menus and the palette.

## Screen patterns (phase 2)

Shared building blocks used across the screens:

| Building block | Where | Use |
| --- | --- | --- |
| `KindIcon` / `kindIcon()` | `components/KindIcon.vue`, `lib/kindIcons.ts` | One lucide icon per resource kind or surface (`pods`, `helm`, `logs`, ...). `NavigationItemIcon` and `TabIcon` wrap it. |
| `ContextAvatar` | `components/ContextAvatar.vue` | Cluster monogram with a name-derived hue and an optional status dot. Set `--avatar-ring` to the surface it sits on. |
| `statusCell`, `contextCell`, `mutedCell`, `monoCell` | `components/tables/cells.ts` | Table cells: dot + label for states, muted secondary text, monospace machine values. Column `meta.numeric` right-aligns with tabular numerals. |
| `actionIcon()`, `isDestructiveAction()` | `lib/actionIcons.ts` | Icons and destructive tone for row / context menu actions. |
| `PanelSection` | `components/generic/PanelSection.vue` | Collapsible side panel section (small caps heading, icon, count). |
| `SettingsSection` + `settingsRow` | `components/settings/` | Settings cards with label / description left and the control right. |

Layout rules the screens follow: the sidebar and tab strip are chrome
(`bg-sidebar` / `bg-surface-1`), content sits on an inset `bg-background`
canvas with a hairline border, the side panel is `bg-card`. Toolbars are
44px (`h-11`) with `size="sm"` controls; tables use ~34px rows.

## Visual QA harness

`npm run harness` serves the app in a browser with mocked Tauri IPC and
fixture data (`dev/harness/`). Query parameters `theme`, `os` and
`scenario` (`default`, `empty`, `error`, `nocontext`, `whatsnew`, `large`: a 2,000+ object cluster for the resource graph) switch
variants. `node dev/harness/shoot.mjs <prefix> [screen...]` screenshots the
key screens in dark and light with a local Chromium (needs
`playwright-core`, which is not a project dependency). Nothing in
`dev/harness` is part of the production build.
