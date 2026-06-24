import { describe, expect, it } from "bun:test";
import { ok, fail } from "../src/lib/http";

describe("ok", () => {
  it("returns success: true with no extra data", () => {
    expect(ok()).toEqual({ success: true });
  });

  it("spreads additional data into the response", () => {
    const result = ok({ userId: "123", role: "admin" });
    expect(result.success).toBe(true);
    expect((result as Record<string, unknown>).userId).toBe("123");
    expect((result as Record<string, unknown>).role).toBe("admin");
  });
});

describe("fail", () => {
  it("returns success: false with error message and code", () => {
    expect(fail("Not found", "not_found")).toEqual({
      success: false,
      error: "Not found",
      errorCode: "not_found",
      details: undefined,
    });
  });

  it("includes optional details", () => {
    const details = { field: "email" };
    expect(fail("Invalid", "validation", details)).toEqual({
      success: false,
      error: "Invalid",
      errorCode: "validation",
      details: { field: "email" },
    });
  });
});
