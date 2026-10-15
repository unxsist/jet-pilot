import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { analyze } from "eslint-scope";
import { parseAst } from "vite";
// @ts-expect-error plain .mjs build script without type declarations
import { splitModule } from "../../scripts/split-module.mjs";

type Split = { facade: string; parts: string[] };

const split = (code: string): Split | null =>
  splitModule(code, { partId: (n: number) => `part:${n}` });

/** Index of the part that declares `name` (exports it). */
const partOf = (result: Split, name: string) =>
  result.parts.findIndex((part) =>
    new RegExp(`^export \\{[^}]*\\b${name.replace("$", "\\$")}\\b`, "m").test(part)
  );

/** Part indexes a part imports from. */
const partImports = (part: string) =>
  [...part.matchAll(/from "part:(\d+)"/g)].map((m) => Number(m[1]));

/** Identifiers a module reads that nothing in it declares or imports. */
const freeVariables = (code: string) => {
  const ast = parseAst(code);
  const addRanges = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(addRanges);
    const record = node as Record<string, unknown>;
    if (typeof record.start === "number") record.range = [record.start, record.end];
    for (const [key, value] of Object.entries(record)) {
      if (key !== "range") addRanges(value);
    }
  };
  addRanges(ast);
  const manager = analyze(ast as never, {
    ecmaVersion: 2022,
    sourceType: "module",
    fallback: "iteration",
  });
  return new Set(manager.globalScope!.through.map((ref) => ref.identifier.name));
};

describe("splitModule", () => {
  test("splits joined declarations and keeps shared helpers apart", () => {
    const result = split(
      [
        "function helper() { return 1; }",
        "const a = () => helper(), b = () => helper();",
        "export { a as A, b as B };",
      ].join("\n")
    )!;
    const [a, b, helper] = ["a", "b", "helper"].map((name) => partOf(result, name));
    expect(new Set([a, b, helper]).size).toBe(3);
    expect(result.parts[a]).toContain(`import { helper } from "part:${helper}";`);
    expect(result.facade).toContain(`export { a as A } from "part:${a}";`);
    expect(result.facade).toContain(`export { b as B } from "part:${b}";`);
  });

  test("merges cycles, writers and top-level mutations with their binding", () => {
    const result = split(
      [
        "function f() { return g(); }",
        "function g() { return f(); }",
        "let count = 0;",
        "function inc() { count++; }",
        "const registry = {};",
        "registry.ready = true;",
        "const flagged = (registry.flag = 1, 2);",
        "export { f, inc, registry, flagged };",
      ].join("\n")
    )!;
    expect(partOf(result, "f")).toBe(partOf(result, "g"));
    expect(partOf(result, "inc")).toBe(partOf(result, "count"));
    expect(partOf(result, "flagged")).toBe(partOf(result, "registry"));
    expect(result.parts[partOf(result, "registry")]).toContain("registry.ready = true;");
  });

  test("ignores shadowed names and carries the imports a part uses", () => {
    const result = split(
      [
        'import { ref as r } from "vue";',
        'import { x } from "lib";',
        "const a = 1;",
        "function same(a) { return a; }",
        "const state = r(a);",
        "export { same, state, x as y };",
      ].join("\n")
    )!;
    const same = result.parts[partOf(result, "same")];
    expect(same).not.toContain("import");
    const state = result.parts[partOf(result, "state")];
    expect(state).toContain('import { ref as r } from "vue";');
    expect(state).toContain(`import { a } from "part:${partOf(result, "a")}";`);
    expect(result.facade).toContain('export { x as y } from "lib";');
  });

  test("refuses module shapes it doesn't handle", () => {
    expect(split("export default 1;")).toBeNull();
    expect(split('import "side-effect";\nconst a = 1;\nexport { a };')).toBeNull();
    expect(split('import { a } from "lib";\na = 2;\nexport { a };')).toBeNull();
  });

  test("split modules behave like the original, state included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "split-module-"));
    try {
      const code = [
        "let n = 0;",
        "function inc() { return ++n; }",
        "const twice = () => (inc(), inc()), current = () => n;",
        "class Box { constructor(v) { this.v = v; } get double() { return this.v * 2; } }",
        "const box = new Box(21);",
        "export { inc, twice, current, box, Box };",
      ].join("\n");
      const result = splitModule(code, { partId: (n: number) => `./part-${n}.mjs` });
      result.parts.forEach((part: string, n: number) =>
        writeFileSync(join(dir, `part-${n}.mjs`), part)
      );
      writeFileSync(join(dir, "index.mjs"), result.facade);
      const mod = await import(pathToFileURL(join(dir, "index.mjs")).href);
      expect(mod.twice()).toBe(2);
      expect(mod.inc()).toBe(3);
      expect(mod.current()).toBe(3);
      expect(mod.box).toBeInstanceOf(mod.Box);
      expect(mod.box.double).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("radix-vue", () => {
    const file = createRequire(import.meta.url).resolve("radix-vue");
    const code = readFileSync(file, "utf8");
    const result = split(code)!;

    test("splits into many parts and keeps every export", () => {
      expect(result).not.toBeNull();
      expect(result.parts.length).toBeGreaterThan(300);
      const exported = (text: string) =>
        [...text.matchAll(/\bas (\w+)(?=\s*[,}])/g)].map((m) => m[1]).sort();
      const original = code.slice(code.lastIndexOf("export {"));
      expect(exported(result.facade)).toEqual(exported(original));
    });

    test("parts read no variable the original file didn't", () => {
      const globals = freeVariables(code);
      const introduced = result.parts.flatMap((part) =>
        [...freeVariables(part)].filter((name) => !globals.has(name))
      );
      expect(introduced).toEqual([]);
    });

    test("parts import each other without cycles", () => {
      const state = new Array(result.parts.length).fill(0); // 0 new, 1 visiting, 2 done
      const visit = (n: number): boolean => {
        if (state[n] === 1) return false;
        if (state[n] === 2) return true;
        state[n] = 1;
        const ok = partImports(result.parts[n]).every(visit);
        state[n] = 2;
        return ok;
      };
      expect(result.parts.every((_, n) => visit(n))).toBe(true);
    });
  });
});
