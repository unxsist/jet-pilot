/**
 * The HTTP tester of a forward: requests, responses and the recent ones
 * per target (kept in memory only: headers may carry tokens).
 */
import { reactive } from "vue";
import type { StatusTone } from "@/components/ui/status";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface HttpHeader {
  name: string;
  value: string;
}

export interface HttpRequestDraft {
  method: HttpMethod;
  path: string;
  headers: HttpHeader[];
  body: string;
}

/** `port_forward_http_request`'s answer. */
export interface HttpResponse {
  status: number;
  statusText: string;
  durationMs: number;
  headers: HttpHeader[];
  body: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  url: string;
}

export interface HttpHistoryEntry {
  id: number;
  at: number;
  request: HttpRequestDraft;
  response: HttpResponse | null;
  error: string | null;
}

export const methodHasBody = (method: HttpMethod) =>
  method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

/** "/api" for "api", "/" for "": the tester always talks to a path. */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function statusTone(status: number): StatusTone {
  if (status >= 500) return "destructive";
  if (status >= 400) return "warning";
  if (status >= 300) return "info";
  return "success";
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function headerValue(headers: HttpHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** JSON pretty-printed (when it is JSON), else the text as is. */
export function prettyBody(body: string, contentType?: string): { text: string; json: boolean } {
  const looksJson =
    /json/i.test(contentType ?? "") || /^\s*[[{]/.test(body);
  if (looksJson) {
    try {
      return { text: JSON.stringify(JSON.parse(body), null, 2), json: true };
    } catch {
      // Not JSON after all (or cut off): show it raw.
    }
  }
  return { text: body, json: false };
}

/** The headers to send: a JSON body without a Content-Type gets one. */
export function sendableHeaders(draft: HttpRequestDraft): HttpHeader[] {
  const headers = draft.headers.filter((h) => h.name.trim());
  if (
    methodHasBody(draft.method) &&
    draft.body.trim() &&
    !headerValue(headers, "content-type") &&
    /^\s*[[{]/.test(draft.body)
  ) {
    return [...headers, { name: "Content-Type", value: "application/json" }];
  }
  return headers;
}

const sameRequest = (a: HttpRequestDraft, b: HttpRequestDraft) =>
  a.method === b.method &&
  a.path === b.path &&
  a.body === b.body &&
  JSON.stringify(a.headers) === JSON.stringify(b.headers);

const MAX_HISTORY = 20;
/** Response bodies kept per recent request (the live one isn't cut). */
const MAX_KEPT_BODY = 64 * 1024;

/** Adds a request to the front; the same request again moves up. */
export function pushHistory(
  history: HttpHistoryEntry[],
  entry: HttpHistoryEntry
): HttpHistoryEntry[] {
  const kept: HttpHistoryEntry = entry.response
    ? {
        ...entry,
        response:
          entry.response.body.length > MAX_KEPT_BODY
            ? {
                ...entry.response,
                body: entry.response.body.slice(0, MAX_KEPT_BODY),
                truncated: true,
              }
            : entry.response,
      }
    : entry;
  return [
    kept,
    ...history.filter((h) => !sameRequest(h.request, entry.request)),
  ].slice(0, MAX_HISTORY);
}

/* Recent requests per target key (see portForwardPorts.targetKey). */
const histories = reactive(new Map<string, HttpHistoryEntry[]>());

export function useHttpHistory(key: () => string) {
  return {
    entries: () => histories.get(key()) ?? [],
    add: (entry: HttpHistoryEntry) =>
      histories.set(key(), pushHistory(histories.get(key()) ?? [], entry)),
  };
}

export type JsonTokenKind = "key" | "string" | "number" | "literal" | "plain";
export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Pretty JSON split into tokens to colour (keys, strings, numbers…). */
export function jsonTokens(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let last = 0;
  for (const match of text.matchAll(JSON_TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: text.slice(last, index), kind: "plain" });
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], kind: match[2] ? "key" : "string" });
      if (match[2]) tokens.push({ text: match[2], kind: "plain" });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[3], kind: "literal" });
    } else {
      tokens.push({ text: match[0], kind: "number" });
    }
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ text: text.slice(last), kind: "plain" });
  return tokens;
}
