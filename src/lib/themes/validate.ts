/*
 * Validation of JSON theme files (portable, optionally with a jetPilot
 * block), with readable errors: version 1 for the full form, a name of at
 * most 48 characters, light / dark appearance, lower-case ids, no unknown
 * colour roles. Unknown top-level keys are kept. Variants are accepted in
 * the flat form ({ "dark": { "canvas": ..., "text": ... } }) and in JET's
 * structured form ({ "dark": { "colors": ..., "jetPilot": ... } }) and
 * always come back structured. Licence: see THIRD_PARTY_THEMES.md.
 */
import { isColor, TRIPLET_PATTERN } from "./contrast";
import { RESERVED_THEME_IDS, THEME_ID_PATTERN, themeIdFromName } from "./runtime";
import {
  type JetPilotThemeExtensions,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeFile,
  type ThemeVariant,
  ANSI_COLORS,
  JET_COLOR_ROLES,
  SYNTAX_SLOTS,
  THEME_COLOR_ROLES,
  THEME_TOKENS,
} from "./types";

export { RESERVED_THEME_IDS, THEME_ID_PATTERN, themeIdFromName };

const COLLECTION_ID_PATTERN = /^[a-z0-9][a-z0-9.:-]{0,127}$/i;
const MAX_NAME_LENGTH = 48;

const ROLE_SET: ReadonlySet<string> = new Set(THEME_COLOR_ROLES);
const JET_ROLE_SET: ReadonlySet<string> = new Set(JET_COLOR_ROLES);
const FILE_KEYS = new Set([
  "version",
  "id",
  "name",
  "appearance",
  "canvas",
  "accent",
  "colors",
  "variants",
  "jetPilot",
  "collection",
  "managed",
  "origin",
]);
const STRUCTURED_VARIANT_KEYS = new Set(["canvas", "accent", "colors", "jetPilot"]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAppearance = (value: unknown): value is ThemeAppearance =>
  value === "light" || value === "dark";

const isLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= MAX_NAME_LENGTH;

const colorError = (where: string, key: string) =>
  new Error(
    `${where}The colour for "${key}" must be a CSS colour such as #1a1b26 or oklch(0.62 0.2 280).`
  );

function parseColorRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
  unknownMessage: (key: string) => string
): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${where}Colours must be an object.`);
  const result: Record<string, string> = {};
  for (const [key, color] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`${where}${unknownMessage(key)}`);
    if (!isColor(color)) throw colorError(where, key);
    result[key] = color.trim();
  }
  return result;
}

function parseRoles(value: unknown, where: string): ThemeColors {
  return parseColorRecord(value, ROLE_SET, where, (key) =>
    JET_ROLE_SET.has(key)
      ? `"${key}" is a JET Pilot role: put it in jetPilot.colors.`
      : `"${key}" is not a supported theme color role.`
  );
}

function parseExtensions(value: unknown, where: string): JetPilotThemeExtensions {
  const at = `${where}jetPilot: `;
  if (!isRecord(value)) throw new Error(`${at}must be an object.`);
  const result: JetPilotThemeExtensions = {};
  for (const [key, block] of Object.entries(value)) {
    switch (key) {
      case "colors":
        result.colors = parseColorRecord(block, JET_ROLE_SET, `${at}colors: `, (role) =>
          ROLE_SET.has(role)
            ? `"${role}" is a standard role: put it in the top-level colors.`
            : `"${role}" is not a JET Pilot color role (${JET_COLOR_ROLES.join(", ")}).`
        );
        break;
      case "terminal":
        result.terminal = parseColorRecord(
          block,
          new Set(ANSI_COLORS),
          `${at}terminal: `,
          (name) => `"${name}" is not an ANSI colour (black, red, ..., brightWhite).`
        );
        break;
      case "syntax":
        result.syntax = parseColorRecord(
          block,
          new Set(SYNTAX_SLOTS),
          `${at}syntax: `,
          (slot) => `"${slot}" is not a syntax slot (${SYNTAX_SLOTS.join(", ")}).`
        );
        break;
      case "editor": {
        if (!isRecord(block)) throw new Error(`${at}editor must be an object.`);
        const editor: Record<string, string> = {};
        for (const [name, color] of Object.entries(block)) {
          if (!isColor(color)) throw colorError(`${at}editor: `, name);
          editor[name] = color.trim();
        }
        result.editor = editor;
        break;
      }
      case "tokens": {
        if (!isRecord(block)) throw new Error(`${at}tokens must be an object.`);
        const tokens: Record<string, string> = {};
        const known = new Set<string>(THEME_TOKENS);
        for (const [token, triplet] of Object.entries(block)) {
          if (!known.has(token)) throw new Error(`${at}tokens: "${token}" is not a JET Pilot token.`);
          if (typeof triplet !== "string" || !TRIPLET_PATTERN.test(triplet.trim())) {
            throw new Error(`${at}tokens: "${token}" must be an HSL triplet such as "240 5% 6.5%".`);
          }
          tokens[token] = triplet.trim();
        }
        result.tokens = tokens;
        break;
      }
      default:
        throw new Error(
          `${at}"${key}" is not supported (colors, terminal, syntax, editor, tokens).`
        );
    }
  }
  return result;
}

function parseSeed(value: unknown, name: string, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isColor(value)) {
    throw new Error(`${where}The "${name}" seed must be a CSS colour such as #1a1b26.`);
  }
  return value.trim();
}

/** Seeds, colours and extensions of the base theme or one variant. */
function parseVariantBody(value: Record<string, unknown>, where: string): ThemeVariant {
  const variant: ThemeVariant = {};
  const canvas = parseSeed(value.canvas, "canvas", where);
  const accent = parseSeed(value.accent, "accent", where);
  if (canvas) variant.canvas = canvas;
  if (accent) variant.accent = accent;
  if (value.colors !== undefined) variant.colors = parseRoles(value.colors, where);
  if (value.jetPilot !== undefined) variant.jetPilot = parseExtensions(value.jetPilot, where);
  return variant;
}

const hasColors = (variant: ThemeVariant) =>
  (variant.canvas !== undefined && variant.accent !== undefined) ||
  Object.keys(variant.colors ?? {}).length > 0;

function parseVariant(value: unknown, appearance: ThemeAppearance): ThemeVariant {
  const where = `variants.${appearance}: `;
  if (!isRecord(value)) throw new Error(`${where}must be an object.`);
  const structured = Object.keys(value).every((key) => STRUCTURED_VARIANT_KEYS.has(key));
  const variant = structured
    ? parseVariantBody(value, where)
    : // The flat form: the variant is the role map itself.
      (() => {
        const { jetPilot, ...roles } = value;
        return parseVariantBody(
          { colors: roles, ...(jetPilot !== undefined ? { jetPilot } : {}) },
          where
        );
      })();
  if (!hasColors(variant)) {
    throw new Error(`${where}Add at least one color role to the ${appearance} variant.`);
  }
  return variant;
}

/**
 * Validates a parsed theme file and returns it normalised (trimmed name, id
 * filled in, structured variants). Throws an Error with a readable message.
 */
export function parseThemeFile(value: unknown): ThemeFile {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");

  const { name, appearance } = value;
  if (!isLabel(name)) {
    throw new Error(`Theme files need a name (${MAX_NAME_LENGTH} characters or fewer).`);
  }
  if (!isAppearance(appearance)) {
    throw new Error('Theme files need an appearance of "light" or "dark".');
  }
  if (value.version !== undefined && value.version !== 1) {
    throw new Error("This theme file uses an unsupported version. Expected 1.");
  }

  const base = parseVariantBody(value, "");
  const seeded = base.canvas !== undefined || base.accent !== undefined;
  if (!seeded && value.version !== 1) {
    throw new Error(
      'Theme files need "version": 1, or the short form with "canvas" and "accent" seeds.'
    );
  }
  if (!seeded && value.colors === undefined) throw new Error("Theme files need a colors object.");
  if (!hasColors(base)) {
    throw new Error(
      seeded
        ? 'Seeded theme files need both "canvas" and "accent" (or at least one color role).'
        : "Add at least one color role to the theme file."
    );
  }

  const id = value.id === undefined ? themeIdFromName(name) : value.id;
  if (typeof id !== "string" || !THEME_ID_PATTERN.test(id)) {
    throw new Error(
      "Theme ids may only contain lowercase letters, numbers, and hyphens (48 characters or fewer)."
    );
  }
  if (RESERVED_THEME_IDS.has(id)) throw new Error(`The theme id "${id}" is reserved.`);

  let variants: ThemeFile["variants"];
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) throw new Error("Theme variants must be an object.");
    for (const [variantAppearance, variant] of Object.entries(value.variants)) {
      if (!isAppearance(variantAppearance)) {
        throw new Error('Theme variants may only be named "light" or "dark".');
      }
      if (variantAppearance === appearance) {
        throw new Error(`Theme variants must not repeat the base appearance "${appearance}".`);
      }
      variants = { ...variants, [variantAppearance]: parseVariant(variant, variantAppearance) };
    }
  }

  let collection: ThemeFile["collection"];
  if (value.collection !== undefined) {
    const raw = value.collection;
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      !COLLECTION_ID_PATTERN.test(raw.id) ||
      !isLabel(raw.label)
    ) {
      throw new Error("Theme collections need a valid id and label.");
    }
    collection = { id: raw.id, label: raw.label.trim() };
  }

  let origin: ThemeFile["origin"];
  if (value.origin !== undefined) {
    const raw = value.origin;
    const extras = ["url", "author", "license"] as const;
    if (
      !isRecord(raw) ||
      typeof raw.label !== "string" ||
      !raw.label.trim() ||
      extras.some((key) => raw[key] !== undefined && typeof raw[key] !== "string")
    ) {
      throw new Error("Theme origins need a label (and optional url, author and license strings).");
    }
    origin = { label: raw.label.trim() };
    for (const key of extras) {
      if (typeof raw[key] === "string") origin[key] = raw[key] as string;
    }
  }

  // Unknown top-level keys are kept, known ones replaced by their parsed form.
  const rest = Object.fromEntries(
    Object.entries(value).filter(([key]) => !FILE_KEYS.has(key))
  );
  return {
    ...rest,
    ...(value.version === 1 ? { version: 1 as const } : {}),
    id,
    name: name.trim(),
    appearance,
    ...base,
    ...(variants ? { variants } : {}),
    ...(collection ? { collection } : {}),
    ...(value.managed === true ? { managed: true } : {}),
    ...(origin ? { origin } : {}),
  };
}
