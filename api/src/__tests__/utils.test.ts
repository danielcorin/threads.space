import { describe, it, expect } from "vitest";
import {
  generateId,
  generateToken,
  jsonResponse,
  errorResponse,
  getCookie,
  setSessionCookie,
  clearSessionCookie,
} from "../utils.js";

describe("generateId", () => {
  it("returns a 25-character string", () => {
    const id = generateId();
    expect(id).toHaveLength(25);
  });

  it("returns only alphanumeric characters", () => {
    const id = generateId();
    expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it("is lexicographically sortable by time", () => {
    const id1 = generateId();
    // IDs generated at the same millisecond share a prefix
    const id2 = generateId();
    // At minimum, they should both start with the same timestamp prefix
    expect(id1.slice(0, 7)).toBe(id2.slice(0, 7));
  });

  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe("generateToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]+$/);
  });

  it("generates unique tokens", () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1).not.toBe(t2);
  });
});

describe("jsonResponse", () => {
  it("returns a Response with JSON content type", async () => {
    const res = jsonResponse({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ hello: "world" });
  });

  it("supports custom status codes", () => {
    const res = jsonResponse({ id: 1 }, 201);
    expect(res.status).toBe(201);
  });
});

describe("errorResponse", () => {
  it("returns error JSON with the given status", async () => {
    const res = errorResponse("Not found", 404);
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toBe("Not found");
  });

  it("defaults to status 400", () => {
    const res = errorResponse("Bad request");
    expect(res.status).toBe(400);
  });
});

describe("getCookie", () => {
  it("parses a single cookie", () => {
    const req = new Request("http://localhost", {
      headers: { Cookie: "session=abc123" },
    });
    expect(getCookie(req, "session")).toBe("abc123");
  });

  it("parses multiple cookies", () => {
    const req = new Request("http://localhost", {
      headers: { Cookie: "foo=bar; session=abc123; other=xyz" },
    });
    expect(getCookie(req, "session")).toBe("abc123");
    expect(getCookie(req, "foo")).toBe("bar");
    expect(getCookie(req, "other")).toBe("xyz");
  });

  it("returns null for missing cookie", () => {
    const req = new Request("http://localhost", {
      headers: { Cookie: "foo=bar" },
    });
    expect(getCookie(req, "session")).toBeNull();
  });

  it("returns null when no Cookie header", () => {
    const req = new Request("http://localhost");
    expect(getCookie(req, "session")).toBeNull();
  });

  it("handles URL-encoded cookie values", () => {
    const req = new Request("http://localhost", {
      headers: { Cookie: "name=hello%20world" },
    });
    expect(getCookie(req, "name")).toBe("hello world");
  });
});

describe("setSessionCookie", () => {
  it("produces a cookie string with all flags", () => {
    const cookie = setSessionCookie("mytoken");
    expect(cookie).toContain("session=mytoken");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=2592000"); // 30 days
  });

  it("includes domain when provided", () => {
    const cookie = setSessionCookie("tok", undefined, ".example.com");
    expect(cookie).toContain("Domain=.example.com");
  });

  it("omits domain when not provided", () => {
    const cookie = setSessionCookie("tok");
    expect(cookie).not.toContain("Domain=");
  });

  it("accepts a custom maxAge", () => {
    const cookie = setSessionCookie("tok", 3600);
    expect(cookie).toContain("Max-Age=3600");
  });
});

describe("clearSessionCookie", () => {
  it("produces a cookie with Max-Age=0", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain("session=");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("includes domain when provided", () => {
    const cookie = clearSessionCookie(".example.com");
    expect(cookie).toContain("Domain=.example.com");
  });
});
