import { describe, expect, it } from "vitest";
import {
  formatDuration,
  jsonTokens,
  normalizePath,
  prettyBody,
  pushHistory,
  sendableHeaders,
  statusTone,
  type HttpHistoryEntry,
  type HttpRequestDraft,
} from "@/lib/portForwardHttp";
import { formatSize } from "@/lib/portForwardView";

const request = (over: Partial<HttpRequestDraft> = {}): HttpRequestDraft => ({
  method: "GET",
  path: "/",
  headers: [],
  body: "",
  ...over,
});

const entry = (
  id: number,
  req: HttpRequestDraft,
  body = "{}"
): HttpHistoryEntry => ({
  id,
  at: id,
  request: req,
  response: {
    status: 200,
    statusText: "OK",
    durationMs: 12,
    headers: [],
    body,
    size: body.length,
    truncated: false,
    binary: false,
    url: "http://127.0.0.1:8080/",
  },
  error: null,
});

describe("HTTP tester", () => {
  it("normalizes paths", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath(" api/orders ")).toBe("/api/orders");
    expect(normalizePath("/healthz")).toBe("/healthz");
  });

  it("colours statuses by class", () => {
    expect(statusTone(204)).toBe("success");
    expect(statusTone(302)).toBe("info");
    expect(statusTone(404)).toBe("warning");
    expect(statusTone(503)).toBe("destructive");
  });

  it("formats time and size", () => {
    expect(formatDuration(34.4)).toBe("34 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1234)).toBe("1.2 KB");
    expect(formatSize(3_400_000)).toBe("3.4 MB");
  });

  it("pretty-prints JSON and leaves the rest alone", () => {
    expect(prettyBody('{"a":1}', "application/json")).toEqual({
      text: '{\n  "a": 1\n}',
      json: true,
    });
    expect(prettyBody('{"cut":', "application/json")).toEqual({
      text: '{"cut":',
      json: false,
    });
    expect(prettyBody("ok", "text/plain")).toEqual({ text: "ok", json: false });
  });

  it("tokenizes JSON for colour", () => {
    const text = '{\n  "a": "b",\n  "n": -1.5,\n  "t": true\n}';
    const tokens = jsonTokens(text);
    expect(
      tokens.filter((t) => t.kind !== "plain").map((t) => `${t.kind}:${t.text}`)
    ).toEqual([
      'key:"a"',
      'string:"b"',
      'key:"n"',
      "number:-1.5",
      'key:"t"',
      "literal:true",
    ]);
    expect(tokens.map((t) => t.text).join("")).toBe(text);
  });

  it("adds a JSON content type when the body is JSON", () => {
    expect(
      sendableHeaders(request({ method: "POST", body: '{"a":1}' }))
    ).toEqual([{ name: "Content-Type", value: "application/json" }]);
    const typed = request({
      method: "POST",
      body: "{}",
      headers: [
        { name: "content-type", value: "text/plain" },
        { name: " ", value: "x" },
      ],
    });
    expect(sendableHeaders(typed)).toEqual([
      { name: "content-type", value: "text/plain" },
    ]);
    expect(sendableHeaders(request({ body: "{}" }))).toEqual([]);
  });

  it("keeps recent requests unique, newest first, and capped", () => {
    let history: HttpHistoryEntry[] = [];
    history = pushHistory(history, entry(1, request({ path: "/a" })));
    history = pushHistory(history, entry(2, request({ path: "/b" })));
    history = pushHistory(history, entry(3, request({ path: "/a" })));
    expect(history.map((h) => h.id)).toEqual([3, 2]);

    for (let i = 10; i < 40; i++) {
      history = pushHistory(history, entry(i, request({ path: `/${i}` })));
    }
    expect(history).toHaveLength(20);

    const big = pushHistory([], entry(99, request(), "x".repeat(70_000)));
    expect(big[0].response!.body).toHaveLength(64 * 1024);
    expect(big[0].response!.truncated).toBe(true);
  });
});
