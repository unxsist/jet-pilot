/*
 * TextMate scope matching for the editor's seven syntax slots. VS Code
 * `tokenColors`, Sublime `rules` and .tmTheme settings all reduce to a list
 * of { scope selectors, foreground } rules; each slot asks for a few target
 * scopes (most specific first, YAML-flavoured since that's what the editor
 * shows) and takes the colour of the best matching rule.
 *
 * Matching follows TextMate: a selector matches a scope when it equals it or
 * is a dot-prefix of it ("string" matches "string.quoted.double"); the
 * longest match wins, later rules win ties. Descendant selectors only match
 * when their ancestors are the document scope (source.yaml / source.json),
 * and "a - b" exclusions are honoured.
 */
import { parseColor, rgbToHex, flattenOver, type Rgb } from "../contrast";
import { isRecord } from "../validate";
import type { SyntaxSlot } from "../types";

export interface ScopeRule {
  selectors: string[];
  foreground: string;
}

export interface TokenRules {
  rules: ScopeRule[];
  /** The foreground of the scope-less "global" rule, if any. */
  globalForeground?: string;
}

/** Target scopes per slot, most specific first. "text" comes from the editor foreground. */
export const SLOT_TARGETS: Record<Exclude<SyntaxSlot, "text">, string[]> = {
  key: [
    "entity.name.tag.yaml",
    "support.type.property-name.json",
    "entity.name.tag",
    "support.type.property-name",
    "variable.other.property",
    "meta.object-literal.key",
  ],
  string: ["string.unquoted.plain.out.yaml", "string.quoted.double.json", "string.quoted", "string"],
  number: ["constant.numeric.integer.yaml", "constant.numeric"],
  constant: [
    "constant.language.boolean.yaml",
    "constant.language.boolean",
    "constant.language",
    "keyword",
  ],
  comment: ["comment.line.number-sign.yaml", "comment"],
  punctuation: [
    "punctuation.separator.key-value.mapping.yaml",
    "punctuation.separator",
    "punctuation",
  ],
};

const DOCUMENT_SCOPES = ["source.yaml", "source.json"];

const prefixMatches = (selector: string, scope: string) =>
  scope === selector || scope.startsWith(`${selector}.`);

/** Specificity of `selector` for `target`, or -1 when it doesn't match. */
export function scopeScore(selector: string, target: string): number {
  const [positive, ...exclusions] = selector.trim().split(/\s+-\s+/);
  if (!positive) return -1;
  if (exclusions.some((exclusion) => prefixMatches(exclusion.trim(), target))) return -1;
  const parts = positive.trim().split(/\s+/);
  const last = parts.pop()!;
  if (!prefixMatches(last, target)) return -1;
  if (
    !parts.every((ancestor) =>
      DOCUMENT_SCOPES.some((scope) => prefixMatches(ancestor, scope))
    )
  ) {
    return -1;
  }
  return last.split(".").length * 10 + parts.length;
}

/** The colour of the best rule for the slot's targets (first target that matches). */
export function matchSlot(rules: ScopeRule[], targets: string[]): string | undefined {
  for (const target of targets) {
    let best: string | undefined;
    let bestScore = -1;
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        const score = scopeScore(selector, target);
        // >= : later rules win ties, as in VS Code.
        if (score >= 0 && score >= bestScore) {
          best = rule.foreground;
          bestScore = score;
        }
      }
    }
    if (best) return best;
  }
  return undefined;
}

/** Splits "a, b" and ["a", "b, c"] into single selectors. */
export function splitSelectors(scope: unknown): string[] {
  const parts = Array.isArray(scope) ? scope : [scope];
  return parts
    .filter((part): part is string => typeof part === "string")
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Normalises VS Code `tokenColors` / tmTheme `settings` entries
 * ({ scope?, settings: { foreground } }); colours are flattened over `base`.
 */
export function readTokenRules(entries: unknown, base: Rgb): TokenRules {
  const result: TokenRules = { rules: [] };
  if (!Array.isArray(entries)) return result;
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.settings)) continue;
    const parsed = parseColor(entry.settings.foreground);
    if (!parsed) continue;
    const foreground = rgbToHex(flattenOver(parsed, base));
    const selectors = splitSelectors(entry.scope);
    if (selectors.length === 0) result.globalForeground ??= foreground;
    else result.rules.push({ selectors, foreground });
  }
  return result;
}

/** Every slot the rules can fill (text: the editor foreground, then the global rule). */
export function syntaxFromRules(
  tokenRules: TokenRules,
  editorForeground?: string
): Partial<Record<SyntaxSlot, string>> {
  const syntax: Partial<Record<SyntaxSlot, string>> = {};
  for (const [slot, targets] of Object.entries(SLOT_TARGETS)) {
    const color = matchSlot(tokenRules.rules, targets);
    if (color) syntax[slot as SyntaxSlot] = color;
  }
  const text = editorForeground ?? tokenRules.globalForeground;
  if (text) syntax.text = text;
  return syntax;
}
