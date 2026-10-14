/*
 * Values in the side panel (ConfigMap data, annotations): recognising JSON
 * and YAML, pretty-printing JSON, and a light colouring of both (keys,
 * literals, comments). Pure, unit tested; no editor needed for a glance.
 */

export type ValueFormat = "json" | "yaml" | "text";

export interface Token {
  text: string;
  kind: "key" | "string" | "literal" | "comment" | "punctuation" | "text";
}

/** JSON when it parses as an object / array; YAML when it reads like a mapping or list. */
export function detectFormat(value: string, key = ""): ValueFormat {
  const text = value.trim();
  if (/\.json$/i.test(key) || /^[[{]/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return "json";
    } catch {
      // not JSON after all
    }
  }
  if (/\.ya?ml$/i.test(key)) return "yaml";
  const lines = text.split("\n").filter((line) => line.trim() && !line.trim().startsWith("#"));
  if (lines.length >= 2 && lines.every((line) => /^\s*(- |[\w.\-/"']+\s*:(\s|$))/.test(line) || /^\s+\S/.test(line))) {
    return "yaml";
  }
  return "text";
}

/** Pretty JSON (2 spaces); the value as is when it isn't JSON. */
export function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)|([{}[\],:])/g;

function jsonTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: text.slice(last, index), kind: "text" });
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], kind: match[2] !== undefined ? "key" : "string" });
      if (match[2] !== undefined) tokens.push({ text: match[2], kind: "punctuation" });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], kind: "literal" });
    } else {
      tokens.push({ text: match[0], kind: "punctuation" });
    }
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: "text" });
  return tokens;
}

const YAML_LITERAL = /^(-?\d+(\.\d+)?|true|false|null|~|yes|no|on|off)$/i;

function yamlLine(line: string): Token[] {
  const tokens: Token[] = [];
  const comment = /^(\s*)(#.*)$/.exec(line);
  if (comment) return [{ text: comment[1]!, kind: "text" }, { text: comment[2]!, kind: "comment" }];
  const match = /^(\s*(?:- )*)([^\s#:][^:#]*?|"[^"]*"|'[^']*')(\s*:)(\s+|$)(.*)$/.exec(line);
  let rest = line;
  if (match) {
    tokens.push({ text: match[1]!, kind: "punctuation" });
    tokens.push({ text: match[2]!, kind: "key" });
    tokens.push({ text: match[3]!, kind: "punctuation" });
    tokens.push({ text: match[4]!, kind: "text" });
    rest = match[5]!;
  } else {
    const item = /^(\s*- )(.*)$/.exec(line);
    if (item) {
      tokens.push({ text: item[1]!, kind: "punctuation" });
      rest = item[2]!;
    } else {
      return [{ text: line, kind: "text" }];
    }
  }
  const valueComment = /^(.*?)(\s+#.*)$/.exec(rest);
  const value = valueComment ? valueComment[1]! : rest;
  if (value) {
    const kind: Token["kind"] = YAML_LITERAL.test(value.trim())
      ? "literal"
      : /^["'].*["']$/.test(value.trim())
        ? "string"
        : "text";
    tokens.push({ text: value, kind });
  }
  if (valueComment) tokens.push({ text: valueComment[2]!, kind: "comment" });
  return tokens;
}

/** Lines of tokens for display (JSON pretty-printed first). */
export function highlight(value: string, format: ValueFormat): Token[][] {
  const text = format === "json" ? prettyJson(value) : value;
  const lines = text.replace(/\n$/, "").split("\n");
  if (format === "json") return lines.map(jsonTokens);
  if (format === "yaml") return lines.map(yamlLine);
  return lines.map((line) => [{ text: line, kind: "text" }]);
}

/** Size of a value in bytes, in words: "312 B", "4.2 KiB". */
export const sizeWords = (value: string): string => bytesWords(new TextEncoder().encode(value).length);

export function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  return kib < 1024 ? `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB` : `${(kib / 1024).toFixed(1)} MiB`;
}
