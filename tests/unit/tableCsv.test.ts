import { describe, expect, test } from "vitest";
import { defineComponent, h } from "vue";
import { escapeCsvCell, renderedText, toCsv } from "../../src/components/tables/csv";
import { resolveTableKey, tableShortcuts } from "../../src/components/tables/keyboard";

const Dot = defineComponent({ props: { tone: String }, setup: () => () => h("span") });
const Badge = defineComponent({ setup: (_, { slots }) => () => h("span", slots.default?.()) });

describe("cell text", () => {
  test("strings and numbers as they are", () => {
    expect(renderedText("payments-api")).toBe("payments-api");
    expect(renderedText(4)).toBe("4");
    expect(renderedText(null)).toBe("");
    expect(renderedText(undefined)).toBe("");
  });

  test("a status cell reads as its label (the dot adds nothing)", () => {
    const cell = h("span", { class: "inline-flex" }, [
      h(Dot, { tone: "success" }),
      h("span", { class: "truncate" }, "Running"),
    ]);
    expect(renderedText(cell)).toBe("Running");
  });

  test("sibling elements are separated, text parts are not", () => {
    expect(renderedText(h("span", [h("span", "web"), h("span", "prod")]))).toBe("web prod");
    expect(renderedText(h("span", ["3", "/", "4"]))).toBe("3/4");
    expect(renderedText(h("span", ["  spaced \n", h("b", " out ")]))).toBe("spaced out");
  });

  test("a component's default slot", () => {
    expect(renderedText(h(Badge, null, () => "Bound"))).toBe("Bound");
    expect(renderedText(h(Badge, null, { default: () => [h("i", "x"), h("i", "y")] }))).toBe("x y");
  });

  test("comments and components without text are empty", () => {
    expect(renderedText(h(Dot))).toBe("");
    expect(renderedText([h(Dot), null, false])).toBe("");
  });
});

describe("CSV", () => {
  test("plain cells stay unquoted", () => {
    expect(escapeCsvCell("payments-api")).toBe("payments-api");
    expect(escapeCsvCell("")).toBe("");
    expect(escapeCsvCell("4/4")).toBe("4/4");
  });

  test("quotes commas, quotes, line breaks and edge spaces", () => {
    expect(escapeCsvCell("a,b")).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell("two\nlines")).toBe('"two\nlines"');
    expect(escapeCsvCell("cr\r")).toBe('"cr\r"');
    expect(escapeCsvCell(" padded")).toBe('" padded"');
  });

  test("guards cells a spreadsheet would run as a formula", () => {
    expect(escapeCsvCell("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(escapeCsvCell("+cmd")).toBe("'+cmd");
    expect(escapeCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escapeCsvCell("-2+3")).toBe("'-2+3");
  });

  test("numbers and the empty placeholder are not formulas", () => {
    expect(escapeCsvCell("-")).toBe("-");
    expect(escapeCsvCell("-12")).toBe("-12");
    expect(escapeCsvCell("+1.5")).toBe("+1.5");
    expect(escapeCsvCell("-0.25%")).toBe("-0.25%");
    expect(escapeCsvCell("1,024")).toBe('"1,024"');
  });

  test("a header line, then one line per row", () => {
    expect(
      toCsv(
        ["Context", "Namespace", "Name", "Ready"],
        [
          ["prod", "payments", "payments-api", "4/4"],
          ["prod", "payments", "worker, v2", "2/3"],
        ]
      )
    ).toBe("Context,Namespace,Name,Ready\nprod,payments,payments-api,4/4\nprod,payments,\"worker, v2\",2/3\n");
  });
});

describe("Copy as CSV shortcut", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ...mods });

  test("⌘/Ctrl+Shift+C copies, plain ⌘/Ctrl+C is left to the browser", () => {
    expect(resolveTableKey(key("C", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "copyCsv" });
    expect(resolveTableKey(key("c", { metaKey: true, shiftKey: true }), true)).toEqual({ type: "copyCsv" });
    expect(resolveTableKey(key("c", { ctrlKey: true }), false)).toBeNull();
    expect(resolveTableKey(key("c", { metaKey: true }), true)).toBeNull();
  });

  test("is on the cheat sheet", () => {
    const items = tableShortcuts(false).flatMap((group) => group.items);
    expect(items.some((item) => item.label.startsWith("Copy as CSV"))).toBe(true);
  });
});
