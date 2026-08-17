import { describe, it, expect } from "vitest";
import { getAllowedOrigins } from "../lib/origins.js";

const APP_ORIGIN = "https://threads.example.com";

describe("getAllowedOrigins", () => {
  it("contains the configured client origin", () => {
    expect(getAllowedOrigins({ APP_ORIGIN })).toContain(APP_ORIGIN);
  });

  it("contains local dev origins", () => {
    expect(getAllowedOrigins({ APP_ORIGIN })).toContain("http://localhost:5173");
    expect(getAllowedOrigins({ APP_ORIGIN })).toContain("http://localhost:5174");
  });

  it("supports multiple comma-separated origins and strips trailing slashes", () => {
    const origins = getAllowedOrigins({ APP_ORIGIN: "https://a.example.com/, https://b.example.com" });
    expect(origins).toContain("https://a.example.com");
    expect(origins).toContain("https://b.example.com");
  });

  it("does not include wildcard or overly broad origins", () => {
    for (const origin of getAllowedOrigins({ APP_ORIGIN })) {
      expect(origin).not.toBe("*");
      expect(origin).toMatch(/^https?:\/\//);
    }
  });
});

describe("parentOrigin validation logic", () => {
  // Mirror the validation logic used in handleWidgetRuntime
  const allowed = getAllowedOrigins({ APP_ORIGIN });
  function isValidParentOrigin(origin: string | null): boolean {
    return !!origin && allowed.includes(origin);
  }

  it("accepts the configured origin", () => {
    expect(isValidParentOrigin(APP_ORIGIN)).toBe(true);
  });

  it("accepts localhost dev origin", () => {
    expect(isValidParentOrigin("http://localhost:5173")).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidParentOrigin(null)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidParentOrigin("")).toBe(false);
  });

  it("rejects unknown origins", () => {
    expect(isValidParentOrigin("https://evil.example.com")).toBe(false);
  });

  it("rejects origins with trailing slashes", () => {
    expect(isValidParentOrigin(`${APP_ORIGIN}/`)).toBe(false);
  });

  it("rejects origins with paths", () => {
    expect(isValidParentOrigin(`${APP_ORIGIN}/foo`)).toBe(false);
  });

  it("rejects similar-looking subdomains", () => {
    expect(isValidParentOrigin("https://evil-threads.example.com")).toBe(false);
  });
});
