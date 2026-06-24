import { describe, expect, it } from "bun:test";
import { HttpError, isHttpError } from "../src/lib/errors";

describe("HttpError", () => {
  it("creates an error with status, code, and message", () => {
    const error = new HttpError(404, "not_found", "Resource not found");
    expect(error.status).toBe(404);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Resource not found");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(HttpError);
  });

  it("stores optional details", () => {
    const details = { field: "email", reason: "taken" };
    const error = new HttpError(400, "validation_error", "Invalid", details);
    expect(error.details).toEqual(details);
  });

  it("has undefined details when not provided", () => {
    const error = new HttpError(500, "server_error", "Something broke");
    expect(error.details).toBeUndefined();
  });
});

describe("isHttpError", () => {
  it("returns true for HttpError instances", () => {
    expect(isHttpError(new HttpError(400, "bad", "Bad"))).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isHttpError(new Error("plain"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isHttpError(null)).toBe(false);
    expect(isHttpError(undefined)).toBe(false);
    expect(isHttpError("string")).toBe(false);
    expect(isHttpError(42)).toBe(false);
    expect(isHttpError({ status: 400, code: "fake" })).toBe(false);
  });
});
