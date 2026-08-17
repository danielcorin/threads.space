import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "../auth.js";

describe("hashPassword", () => {
  it("returns a string in salt:hash format", async () => {
    const result = await hashPassword("mypassword");
    const parts = result.split(":");
    expect(parts).toHaveLength(2);
  });

  it("salt is 32 hex characters (16 bytes)", async () => {
    const result = await hashPassword("mypassword");
    const [salt] = result.split(":");
    expect(salt).toHaveLength(32);
    expect(salt).toMatch(/^[0-9a-f]+$/);
  });

  it("hash is 64 hex characters (32 bytes)", async () => {
    const result = await hashPassword("mypassword");
    const [, hash] = result.split(":");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("produces different salts on different calls", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    const [saltA] = a.split(":");
    const [saltB] = b.split(":");
    expect(saltA).not.toBe(saltB);
  });

  it("produces different hashes due to different salts", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });
});

describe("verifyPassword", () => {
  it("returns true for the correct password", async () => {
    const stored = await hashPassword("correct-password");
    const result = await verifyPassword("correct-password", stored);
    expect(result).toBe(true);
  });

  it("returns false for the wrong password", async () => {
    const stored = await hashPassword("correct-password");
    const result = await verifyPassword("wrong-password", stored);
    expect(result).toBe(false);
  });

  it("returns false for an empty password", async () => {
    const stored = await hashPassword("correct-password");
    const result = await verifyPassword("", stored);
    expect(result).toBe(false);
  });
});
