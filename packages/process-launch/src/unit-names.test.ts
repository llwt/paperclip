import { describe, expect, it } from "vitest";
import {
  buildScopeUnitName,
  isOpaqueId,
  isValidScopeName,
  isValidSliceName,
  newLaunchNonce,
  scopeUnitNamespace,
  sliceCgroupPath,
} from "./unit-names.js";

describe("slice names", () => {
  it("accepts non-root agent slices", () => {
    for (const name of ["app-agents.slice", "agents.slice", "app-pcltest_1.slice"]) {
      expect(isValidSliceName(name)).toBe(true);
    }
  });

  it("rejects reserved, root and malformed slices", () => {
    for (const name of [
      "-.slice",
      "app.slice",
      "system.slice",
      "user.slice",
      "app-agents",
      "app-agents.service",
      "app--agents.slice",
      "-app.slice",
      "app-.slice",
      "app/agents.slice",
      "../app.slice",
      "app..agents.slice",
      "app agents.slice",
      ".slice",
      "",
      `${"a".repeat(260)}.slice`,
    ]) {
      expect(isValidSliceName(name), name).toBe(false);
    }
  });

  it("maps slices to their cgroup path", () => {
    expect(sliceCgroupPath("app-agents.slice")).toBe("/app.slice/app-agents.slice");
    expect(sliceCgroupPath("agents.slice")).toBe("/agents.slice");
  });
});

describe("scope unit names", () => {
  const base = { instanceId: "default", ownerKind: "run", ownerId: "run-1", companyId: "company-a" };

  it("builds names from hashed identity and a nonce only", () => {
    const nonce = newLaunchNonce();
    const unit = buildScopeUnitName({ ...base, nonce });
    expect(unit).toMatch(/^pcagent-[0-9a-f]{12}-[0-9a-f]{16}-[0-9a-f]{16}\.scope$/);
    expect(unit.startsWith(scopeUnitNamespace("default"))).toBe(true);
    expect(unit.endsWith(`-${nonce}.scope`)).toBe(true);
    expect(unit).not.toContain("run-1");
    expect(unit).not.toContain("company-a");
    expect(isValidScopeName(unit)).toBe(true);
  });

  it("is stable for one owner and different per owner, company and instance", () => {
    const nonce = "0123456789abcdef";
    const unit = buildScopeUnitName({ ...base, nonce });
    expect(buildScopeUnitName({ ...base, nonce })).toBe(unit);
    expect(buildScopeUnitName({ ...base, ownerId: "run-2", nonce })).not.toBe(unit);
    expect(buildScopeUnitName({ ...base, companyId: "company-b", nonce })).not.toBe(unit);
    expect(buildScopeUnitName({ ...base, instanceId: "other", nonce }).startsWith(scopeUnitNamespace("default"))).toBe(
      false,
    );
  });

  it("uses a fresh nonce per launch", () => {
    const nonces = new Set(Array.from({ length: 200 }, () => newLaunchNonce()));
    expect(nonces.size).toBe(200);
    expect(() => buildScopeUnitName({ ...base, nonce: "not hex" })).toThrow();
  });

  it("accepts only opaque ids", () => {
    expect(isOpaqueId("3f2c-run_1:a.b")).toBe(true);
    for (const value of ["", "fix the login bug", "a/b", "x".repeat(129), "$(rm -rf)"]) {
      expect(isOpaqueId(value), value).toBe(false);
    }
  });
});
