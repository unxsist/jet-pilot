import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { isAppError, vaultPrompt, withVault } from "@/lib/clusters/managed";
import { emptyManualForm, toSpec } from "@/views/clusters/add/forms";

describe("withVault", () => {
  beforeEach(() => {
    invoke.mockReset();
    vaultPrompt.value = null;
  });

  it("passes results and unrelated errors through", async () => {
    await expect(withVault(async () => 42)).resolves.toBe(42);
    await expect(withVault(async () => Promise.reject({ code: "conflict", message: "taken" }))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(vaultPrompt.value).toBeNull();
  });

  it("asks to set up a passphrase without a keychain, then retries once", async () => {
    invoke.mockResolvedValueOnce({ backend: "none", initialized: false, locked: true, keychainAvailable: false, keychainProblem: "No Secret Service" });
    let calls = 0;
    const result = withVault(async () => {
      calls++;
      if (calls === 1) throw { code: "keychainUnavailable", message: "no keychain" };
      return "stored";
    });
    await vi.waitFor(() => expect(vaultPrompt.value).not.toBeNull());
    expect(vaultPrompt.value).toMatchObject({ mode: "setup", problem: "No Secret Service" });
    vaultPrompt.value!.resolve(true);
    await expect(result).resolves.toBe("stored");
    expect(calls).toBe(2);
  });

  it("asks to unlock an initialized vault and gives up when cancelled", async () => {
    invoke.mockResolvedValueOnce({ backend: "passphrase", initialized: true, locked: true, keychainAvailable: false });
    const result = withVault(async () => Promise.reject({ code: "vaultLocked", message: "locked" }));
    await vi.waitFor(() => expect(vaultPrompt.value?.mode).toBe("unlock"));
    vaultPrompt.value!.resolve(false);
    await expect(result).rejects.toMatchObject({ code: "vaultLocked" });
  });

  it("recognises app errors", () => {
    expect(isAppError({ code: "io", message: "x" })).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
  });
});

describe("manual cluster form", () => {
  it("builds the spec", () => {
    const form = { ...emptyManualForm(), name: " homelab ", server: " https://10.0.0.1:6443 ", token: " abc ", namespace: " " };
    expect(toSpec(form)).toEqual({
      name: "homelab",
      server: "https://10.0.0.1:6443",
      ca: { kind: "system" },
      auth: { kind: "token", token: "abc" },
      namespace: null,
    });
    expect(toSpec({ ...form, ca: "pem", caPem: "PEM", auth: "clientCert", certPem: "C", keyPem: "K" })).toMatchObject({
      ca: { kind: "pem", pem: "PEM" },
      auth: { kind: "clientCert", certPem: "C", keyPem: "K" },
    });
    expect(toSpec({ ...form, ca: "insecure", auth: "none" })).toMatchObject({ ca: { kind: "insecure" }, auth: { kind: "none" } });
  });
});
