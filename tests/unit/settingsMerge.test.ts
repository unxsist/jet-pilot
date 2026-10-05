import { describe, expect, it } from "vitest";
import { mergeSettings } from "@/lib/settingsMerge";

const defaults = () => ({
  lastContext: null as string | null,
  kubeConfigs: [] as string[],
  openTabs: null as { tabs: string[] } | null,
  appearance: {
    colorScheme: "auto" as "auto" | "light" | "dark",
    lightTheme: "jet",
    darkTheme: "jet",
  },
  updates: { checkOnStartup: true, whatsNew: null as string | null },
});

describe("mergeSettings", () => {
  it("keeps new default keys of a section for older settings files", () => {
    const merged = mergeSettings(defaults(), {
      appearance: { colorScheme: "dark" },
    });
    expect(merged.appearance).toEqual({
      colorScheme: "dark",
      lightTheme: "jet",
      darkTheme: "jet",
    });
  });

  it("lets stored values win over defaults", () => {
    const merged = mergeSettings(defaults(), {
      lastContext: "prod",
      kubeConfigs: ["/a", "/b"],
      openTabs: { tabs: ["x"] },
      appearance: { colorScheme: "light", lightTheme: "dracula", darkTheme: "nord" },
      updates: { checkOnStartup: false },
    });
    expect(merged.lastContext).toBe("prod");
    expect(merged.kubeConfigs).toEqual(["/a", "/b"]);
    expect(merged.openTabs).toEqual({ tabs: ["x"] });
    expect(merged.appearance).toEqual({
      colorScheme: "light",
      lightTheme: "dracula",
      darkTheme: "nord",
    });
    expect(merged.updates).toEqual({ checkOnStartup: false, whatsNew: null });
  });

  it("does not merge arrays or nullable sections", () => {
    const merged = mergeSettings(
      { ...defaults(), kubeConfigs: ["/default"] },
      { kubeConfigs: [], openTabs: null }
    );
    expect(merged.kubeConfigs).toEqual([]);
    expect(merged.openTabs).toBeNull();
  });

  it("falls back to the default section when the stored one has the wrong type", () => {
    const merged = mergeSettings(defaults(), { appearance: "dark", updates: null });
    expect(merged.appearance).toEqual(defaults().appearance);
    expect(merged.updates).toEqual(defaults().updates);
  });

  it("keeps unknown keys and ignores non-object files", () => {
    expect(mergeSettings(defaults(), { futureKey: 1 })).toMatchObject({ futureKey: 1 });
    expect(mergeSettings(defaults(), null)).toEqual(defaults());
    expect(mergeSettings(defaults(), [1, 2])).toEqual(defaults());
  });

  it("does not share section objects with the defaults", () => {
    const base = defaults();
    const merged = mergeSettings(base, {});
    merged.appearance.lightTheme = "changed";
    expect(base.appearance.lightTheme).toBe("jet");
  });
});
