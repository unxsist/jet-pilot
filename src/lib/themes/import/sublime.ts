/*
 * Import of Sublime Text colour schemes (.sublime-color-scheme, JSONC):
 * `variables` (also nested var()), Sublime's color() adjusters on a best
 * effort basis (alpha / a, blend / blenda, lightness / l, saturation / s),
 * `globals` and `rules`. The result is converted like a TextMate theme
 * (./tmtheme.ts), so the palette and syntax mapping match the other formats.
 */
import { converter } from "culori/fn";
import { type Rgba, mixRgb, parseColor } from "../contrast";
import type { ThemeFile } from "../types";
import { isRecord } from "../validate";
import { convertTextMateTheme, hexWithAlpha } from "./tmtheme";
import { resolveThemeName } from "./vscode";

const toHsl = converter("hsl");
const toRgb = converter("rgb");
const MAX_DEPTH = 16;

/** A .sublime-color-scheme document: `globals` or a `rules` array. */
export function isSublimeColorScheme(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (isRecord(value.globals) || Array.isArray(value.rules)) && !isRecord(value.colors);
}

/** Splits "a(b c) d" on top-level whitespace. */
function topLevelTokens(body: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

const percentage = (value: string) =>
  value.trim().endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);

export class SublimeColorResolver {
  readonly unsupported = new Set<string>();

  constructor(private readonly variables: Record<string, unknown>) {}

  /** A CSS colour (hex, with alpha when translucent), or null. */
  resolve(raw: unknown, depth = 0): string | null {
    const color = this.resolveRgba(raw, depth);
    return color ? hexWithAlpha(color) : null;
  }

  private resolveRgba(raw: unknown, depth: number): Rgba | null {
    if (typeof raw !== "string" || depth > MAX_DEPTH) return null;
    const value = raw.trim();
    const variable = /^var\(\s*([\w.-]+)\s*\)$/.exec(value);
    if (variable) return this.resolveRgba(this.variables[variable[1]!], depth + 1);
    const colorMod = /^color\((.*)\)$/s.exec(value);
    if (colorMod) return this.colorMod(colorMod[1]!, depth);
    // var() inside another function, e.g. rgba(var(x), 0.5) is not valid Sublime; plain colours are.
    return parseColor(value);
  }

  private colorMod(body: string, depth: number): Rgba | null {
    const [base, ...adjusters] = topLevelTokens(body);
    let color = this.resolveRgba(base, depth + 1);
    if (!color) return null;
    for (const adjuster of adjusters) {
      const match = /^([a-z-]+)\((.*)\)$/s.exec(adjuster);
      if (!match) continue;
      const [, name, args] = match as unknown as [string, string, string];
      color = this.adjust(color, name, args, depth) ?? color;
    }
    return color;
  }

  private adjust(color: Rgba, name: string, args: string, depth: number): Rgba | null {
    switch (name) {
      case "alpha":
      case "a": {
        const alpha = percentage(args);
        return Number.isFinite(alpha) ? { ...color, a: Math.min(1, Math.max(0, alpha)) } : null;
      }
      case "blend":
      case "blenda": {
        // blend(<color> <percentage>): the percentage is how much of the base to keep.
        const tokens = topLevelTokens(args);
        const other = this.resolveRgba(tokens[0], depth + 1);
        const keep = percentage(tokens[1] ?? "50%");
        if (!other || !Number.isFinite(keep)) return null;
        const mixed = mixRgb(other, color, keep);
        const a = name === "blenda" ? other.a + (color.a - other.a) * keep : color.a;
        return { ...mixed, a };
      }
      case "lightness":
      case "l":
      case "saturation":
      case "s": {
        const match = /^([+-]?)\s*([\d.]+)%?$/.exec(args.trim());
        const hsl = toHsl({ mode: "rgb", r: color.r / 255, g: color.g / 255, b: color.b / 255 });
        if (!match || !hsl) return null;
        const amount = Number.parseFloat(match[2]!) / 100;
        const key = name.startsWith("l") ? "l" : "s";
        const current = hsl[key] ?? 0;
        const next = match[1] === "+" ? current + amount : match[1] === "-" ? current - amount : amount;
        const rgb = toRgb({ ...hsl, [key]: Math.min(1, Math.max(0, next)) });
        return { r: (rgb.r ?? 0) * 255, g: (rgb.g ?? 0) * 255, b: (rgb.b ?? 0) * 255, a: color.a };
      }
      default:
        this.unsupported.add(name);
        return null;
    }
  }
}

/** Imports a parsed .sublime-color-scheme document. */
export function importSublimeColorScheme(
  value: Record<string, unknown>,
  filename?: string
): { theme: ThemeFile; warnings: string[] } {
  const warnings: string[] = [];
  const resolver = new SublimeColorResolver(isRecord(value.variables) ? value.variables : {});
  let invalid = 0;

  const globals: Record<string, string> = {};
  for (const [key, raw] of Object.entries(isRecord(value.globals) ? value.globals : {})) {
    const color = resolver.resolve(raw);
    // Non-colour globals (brackets_options, shadow_width, ...) drop out here.
    if (color) globals[key] = color;
  }

  const rules: unknown[] = [];
  for (const rule of Array.isArray(value.rules) ? value.rules : []) {
    if (!isRecord(rule) || rule.foreground === undefined) continue;
    const foreground = resolver.resolve(rule.foreground);
    if (!foreground) {
      invalid += 1;
      continue;
    }
    rules.push({ scope: rule.scope, settings: { foreground } });
  }

  if (resolver.unsupported.size > 0) {
    warnings.push(`Ignored unsupported colour adjusters: ${[...resolver.unsupported].join(", ")}.`);
  }
  if (invalid > 0) warnings.push(`Ignored ${invalid} colour${invalid === 1 ? "" : "s"} that could not be resolved.`);
  const name = resolveThemeName([value.name], filename, "Sublime Text theme");
  return { theme: convertTextMateTheme(name, globals, rules, warnings), warnings };
}
