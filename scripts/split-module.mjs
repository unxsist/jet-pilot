/*
 * Splits a pre-bundled library file into one module per group of top-level
 * statements, so the bundler can put each part in the chunk that uses it.
 *
 * Why: radix-vue 1.x ships all of its components as a single 600 kB
 * dist/index.js. Rolldown tree-shakes it fine, but a module can only live in
 * one chunk, so the startup chunk got every primitive any lazy screen uses
 * (comboboxes, selects, tabs, number fields, ...) plus the date and number
 * libraries those pull in. After the split, the startup chunk only gets the
 * menu, popover, toast, scroll-area and splitter code the shell renders; the
 * rest moves into the lazy chunks that need it.
 *
 * How: scope analysis (eslint-scope) finds which top-level statements each
 * statement references. Statements that reference each other in a cycle,
 * redeclare or reassign each other's bindings, or run top-level code against
 * another statement's binding are merged, so the module graph is acyclic and
 * every binding is only written by its own module. Each group keeps the
 * original statement order and exports its bindings under their (unique)
 * top-level names; the original file becomes a facade of re-exports.
 *
 * The library must declare `"sideEffects": false` (radix-vue does): parts
 * nobody imports are dropped, and so are statements that declare nothing
 * and touch no binding (radix-vue has one: a `typeof` feature probe). A
 * side-effect import in the facade would make every chunk that uses the
 * library load every part.
 * Build only: the dev server pre-bundles dependencies with its own pipeline.
 */
import { readFile } from "node:fs/promises";
import { analyze } from "eslint-scope";
import { parseAst } from "vite";

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Root identifier of an assignment target: `a` for `a`, `a.b[c]`. */
const rootName = (node) => {
  while (node && node.type === "MemberExpression") node = node.object;
  return node && node.type === "Identifier" ? node.name : undefined;
};

/**
 * Names a statement writes to while the module evaluates (assignments,
 * updates, deletes outside of function bodies). Writes inside functions
 * only happen when the function is called and are covered by scope analysis.
 */
const eagerWrites = (statement) => {
  const names = new Set();
  const visit = (node, top) => {
    if (!node || typeof node.type !== "string") return;
    if (!top && FUNCTION_TYPES.has(node.type)) return;
    if (node.type === "AssignmentExpression") {
      // Destructuring targets: collect every identifier in the pattern.
      collectPatternRoots(node.left, names);
    } else if (node.type === "UpdateExpression") {
      const name = rootName(node.argument);
      if (name) names.add(name);
    } else if (node.type === "UnaryExpression" && node.operator === "delete") {
      const name = rootName(node.argument);
      if (name) names.add(name);
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) value.forEach((child) => visit(child, false));
      else if (value && typeof value === "object") visit(value, false);
    }
  };
  // A function declaration's body never runs at evaluation time.
  if (statement.type !== "FunctionDeclaration") visit(statement, true);
  return names;
};

const collectPatternRoots = (pattern, names) => {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      names.add(pattern.name);
      break;
    case "MemberExpression": {
      const name = rootName(pattern);
      if (name) names.add(name);
      break;
    }
    case "ArrayPattern":
      pattern.elements.forEach((el) => collectPatternRoots(el, names));
      break;
    case "ObjectPattern":
      pattern.properties.forEach((p) =>
        collectPatternRoots(p.type === "RestElement" ? p.argument : p.value, names)
      );
      break;
    case "RestElement":
      collectPatternRoots(pattern.argument, names);
      break;
    case "AssignmentPattern":
      collectPatternRoots(pattern.left, names);
      break;
  }
};

/** eslint-scope reads `range`; Vite's (oxc) parser only sets start/end. */
const addRanges = (node) => {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(addRanges);
  if (typeof node.start === "number") node.range = [node.start, node.end];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === "object" && key !== "range") addRanges(value);
  }
};

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i) {
    while (this.parent[i] !== i) i = this.parent[i] = this.parent[this.parent[i]];
    return i;
  }
  union(a, b) {
    this.parent[this.find(a)] = this.find(b);
  }
}

/** Tarjan's strongly connected components; `edges[n]` lists n's targets. */
const stronglyConnected = (edges) => {
  const size = edges.length;
  const index = new Array(size).fill(-1);
  const low = new Array(size).fill(0);
  const onStack = new Array(size).fill(false);
  const stack = [];
  const component = new Array(size).fill(-1);
  let counter = 0;
  let components = 0;
  for (let root = 0; root < size; root++) {
    if (index[root] !== -1) continue;
    // Iterative DFS: the radix-vue graph is deep enough to overflow recursion.
    const work = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length) {
      const frame = work[work.length - 1];
      const [node, i] = frame;
      if (i < edges[node].length) {
        frame[1]++;
        const to = edges[node][i];
        if (index[to] === -1) {
          index[to] = low[to] = counter++;
          stack.push(to);
          onStack[to] = true;
          work.push([to, 0]);
        } else if (onStack[to]) {
          low[node] = Math.min(low[node], index[to]);
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1][0];
        low[parent] = Math.min(low[parent], low[node]);
      }
      if (low[node] === index[node]) {
        let member;
        do {
          member = stack.pop();
          onStack[member] = false;
          component[member] = components;
        } while (member !== node);
        components++;
      }
    }
  }
  return { component, count: components };
};

/**
 * Splits `code` (an ES module) into parts. `partId(n)` names part n,
 * `source(s)` rewrites the library's own import sources.
 * Returns null when the file uses a form this splitter doesn't handle, so
 * the caller can fall back to the original module.
 *
 * @returns {{ facade: string, parts: string[] } | null}
 */
export function splitModule(code, { partId, source = (target) => target }) {
  const ast = parseAst(code);
  addRanges(ast);
  const body = ast.body;
  const imports = new Map(); // local name -> { source, imported } (imported "*" = namespace)
  const exportsList = []; // { local, exported }
  // Statements that become parts. Minifiers join neighbouring declarations
  // (`const a = ..., b = ...`), often across components, so each declarator
  // of a multi-declarator statement is a unit of its own.
  const units = []; // { node, start, end, text }

  for (let i = 0; i < body.length; i++) {
    const node = body[i];
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") continue;
      for (const spec of node.specifiers) {
        imports.set(spec.local.name, {
          source: node.source.value,
          imported:
            spec.type === "ImportNamespaceSpecifier"
              ? "*"
              : spec.type === "ImportDefaultSpecifier"
                ? "default"
                : spec.imported.name ?? spec.imported.value,
        });
      }
      if (node.specifiers.length === 0) return null; // bare side-effect import
    } else if (node.type === "ExportNamedDeclaration" && !node.declaration && !node.source) {
      for (const spec of node.specifiers) {
        exportsList.push({
          local: spec.local.name ?? spec.local.value,
          exported: spec.exported.name ?? spec.exported.value,
        });
      }
    } else if (node.type.startsWith("Export")) {
      return null; // export default / export * / export const: not needed for radix-vue
    } else if (node.type === "VariableDeclaration" && node.declarations.length > 1) {
      for (const declarator of node.declarations) {
        units.push({
          node: declarator,
          start: declarator.start,
          end: declarator.end,
          text: `${node.kind} ${code.slice(declarator.start, declarator.end)};`,
        });
      }
    } else {
      units.push({
        node,
        start: node.start,
        end: node.end,
        text: code.slice(node.start, node.end),
      });
    }
  }

  /** Unit containing source position `pos`, undefined outside of units. */
  const unitAt = (pos) => {
    let lo = 0;
    let hi = units.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (units[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    const unit = units[lo];
    return unit && unit.start <= pos && pos < unit.end ? lo : undefined;
  };

  const scopeManager = analyze(ast, {
    ecmaVersion: 2022,
    sourceType: "module",
    fallback: "iteration",
  });
  const moduleScope = scopeManager.scopes.find((scope) => scope.type === "module");
  if (!moduleScope) return null;

  const declaredBy = new Map(); // top-level name -> unit index
  const uf = new UnionFind(units.length);
  const refs = units.map(() => new Set()); // unit -> referenced top-level names

  for (const variable of moduleScope.variables) {
    if (imports.has(variable.name)) continue;
    const owners = [...new Set(variable.defs.map((def) => unitAt(def.name.start)))];
    if (owners.some((owner) => owner === undefined)) return null;
    // `var a` declared twice, or a function redeclared: one module owns it.
    owners.slice(1).forEach((owner) => uf.union(owner, owners[0]));
    declaredBy.set(variable.name, owners[0]);
  }

  for (const variable of moduleScope.variables) {
    const isImport = imports.has(variable.name);
    for (const ref of variable.references) {
      const unit = unitAt(ref.identifier.start);
      if (unit === undefined) continue; // export list
      refs[unit].add(variable.name);
      if (ref.isWrite()) {
        if (isImport) return null;
        // Imported bindings are read-only: writers live with the declaration.
        uf.union(unit, declaredBy.get(variable.name));
      }
    }
  }
  // Top-level code that mutates another statement's binding, and statements
  // that declare nothing (calls, expressions), run with what they touch so
  // they still run whenever, and right after, those bindings are loaded.
  const declaresSomething = new Set(declaredBy.values());
  units.forEach(({ node }, unit) => {
    const touched = declaresSomething.has(unit)
      ? [...eagerWrites(node)]
      : [...refs[unit]];
    touched
      .map((name) => declaredBy.get(name))
      .filter((owner) => owner !== undefined && owner !== unit)
      .forEach((owner) => uf.union(unit, owner));
  });

  // Groups -> dependency graph -> strongly connected components (merged).
  const groupIds = new Map();
  const groupOf = units.map((_, unit) => {
    const root = uf.find(unit);
    if (!groupIds.has(root)) groupIds.set(root, groupIds.size);
    return groupIds.get(root);
  });
  const edges = Array.from({ length: groupIds.size }, () => new Set());
  units.forEach((_, unit) => {
    for (const name of refs[unit]) {
      const owner = declaredBy.get(name);
      if (owner !== undefined && groupOf[owner] !== groupOf[unit]) {
        edges[groupOf[unit]].add(groupOf[owner]);
      }
    }
  });
  const { component, count } = stronglyConnected(edges.map((targets) => [...targets]));
  const partOf = units.map((_, unit) => component[groupOf[unit]]);

  const partUnits = Array.from({ length: count }, () => []);
  units.forEach((_, unit) => partUnits[partOf[unit]].push(unit));

  const from = (target) => JSON.stringify(source(target));
  // ES2022 allows any string as an import/export name; quote only when needed.
  const moduleName = (name) =>
    /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
  const importLine = (local, { source: target, imported }) =>
    imported === "*"
      ? `import * as ${local} from ${from(target)};`
      : `import { ${imported === local ? local : `${moduleName(imported)} as ${local}`} } from ${from(target)};`;
  const partFrom = (part) => JSON.stringify(partId(part));

  const parts = partUnits.map((members, part) => {
    const names = new Set();
    members.forEach((unit) => refs[unit].forEach((name) => names.add(name)));
    const lines = [];
    const fromParts = new Map();
    for (const name of names) {
      if (imports.has(name)) {
        lines.push(importLine(name, imports.get(name)));
      } else {
        const owner = partOf[declaredBy.get(name)];
        if (owner === part) continue;
        if (!fromParts.has(owner)) fromParts.set(owner, []);
        fromParts.get(owner).push(name);
      }
    }
    for (const [owner, list] of fromParts) {
      lines.push(`import { ${list.join(", ")} } from ${partFrom(owner)};`);
    }
    members.forEach((unit) => lines.push(units[unit].text));
    const own = [...declaredBy.entries()]
      .filter(([, unit]) => partOf[unit] === part)
      .map(([name]) => name);
    if (own.length) lines.push(`export { ${own.join(", ")} };`);
    return lines.join("\n");
  });

  const facade = [];
  for (const { local, exported } of exportsList) {
    const name = moduleName(exported);
    if (imports.has(local)) {
      const { source: target, imported } = imports.get(local);
      facade.push(
        imported === "*"
          ? `export * as ${name} from ${from(target)};`
          : `export { ${moduleName(imported)} as ${name} } from ${from(target)};`
      );
    } else if (declaredBy.has(local)) {
      facade.push(`export { ${local} as ${name} } from ${partFrom(partOf[declaredBy.get(local)])};`);
    } else {
      return null;
    }
  }

  return { facade: facade.join("\n"), parts };
}

const QUERY = "?split-part=";

/**
 * Vite plugin: serves every file matching `include` as a facade over its
 * split parts. Part ids are `<file>?split-part=<n>`, so bundle reports still
 * attribute them to their package.
 */
export function splitBundledModules(include) {
  const splits = new Map(); // file -> split result, or null when not split
  const split = async (ctx, file) => {
    if (splits.has(file)) return splits.get(file);
    const code = await readFile(file, "utf8");
    // Parts are virtual: resolve the library's own imports (relative files,
    // nested dependencies) against the original file up front.
    const resolved = new Map();
    for (const node of parseAst(code).body) {
      if (node.type !== "ImportDeclaration") continue;
      const hit = await ctx.resolve(node.source.value, file, { skipSelf: true });
      if (hit && !hit.external) resolved.set(node.source.value, hit.id);
    }
    const result = splitModule(code, {
      partId: (n) => `${file}${QUERY}${n}`,
      source: (target) => resolved.get(target) ?? target,
    });
    if (!result) ctx.warn(`${file}: unsupported module shape, not split`);
    splits.set(file, result);
    return result;
  };
  return {
    name: "jet-pilot:split-bundled-modules",
    apply: "build",
    resolveId(source) {
      const [file] = source.split(QUERY);
      return source.includes(QUERY) && include.test(file) ? source : null;
    },
    async load(id) {
      const [file, part] = id.split(QUERY);
      if (!include.test(file)) return null;
      const result = await split(this, file);
      if (!result) return null;
      if (part === undefined) return { code: result.facade, moduleSideEffects: false };
      return { code: result.parts[Number(part)], moduleSideEffects: false };
    },
  };
}
