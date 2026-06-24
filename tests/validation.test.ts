import { describe, expect, it } from "bun:test";
import {
  isValidUuid,
  validateUuidParam,
  VALIDATION_LIMITS,
  validateStringLength,
  validateStringArray,
  validateMetadata,
  sanitizeInput,
} from "../src/lib/validation";
import { HttpError } from "../src/lib/errors";

describe("isValidUuid", () => {
  it("accepts a valid v4 UUID", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects a short string", () => {
    expect(isValidUuid("not-a-uuid")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidUuid("")).toBe(false);
  });

  it("rejects a UUID with invalid characters", () => {
    expect(isValidUuid("550e8400-e29b-41d4-a716-44665544000g")).toBe(false);
  });
});

describe("validateUuidParam", () => {
  it("does not throw for a valid UUID", () => {
    expect(() =>
      validateUuidParam("550e8400-e29b-41d4-a716-446655440000", "userId"),
    ).not.toThrow();
  });

  it("throws HttpError 400 for an invalid UUID", () => {
    try {
      validateUuidParam("bad", "userId");
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
      expect((error as HttpError).code).toBe("invalid_uuid");
    }
  });
});

describe("VALIDATION_LIMITS", () => {
  it("has expected limits", () => {
    expect(VALIDATION_LIMITS.TITLE_MAX_LENGTH).toBe(200);
    expect(VALIDATION_LIMITS.EMAIL_MAX_LENGTH).toBe(254);
    expect(VALIDATION_LIMITS.ARRAY_MAX_ITEMS).toBe(1000);
  });
});

describe("validateStringLength", () => {
  it("returns undefined for undefined input", () => {
    expect(validateStringLength(undefined, 100, "field")).toBeUndefined();
  });

  it("returns the value when within limit", () => {
    expect(validateStringLength("hello", 10, "field")).toBe("hello");
  });

  it("throws when string exceeds max length", () => {
    try {
      validateStringLength("toolong", 3, "name");
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).code).toBe("too_long");
    }
  });

  it("accepts a string at exactly the max length", () => {
    expect(validateStringLength("abc", 3, "field")).toBe("abc");
  });
});

describe("validateStringArray", () => {
  it("returns undefined for undefined input", () => {
    expect(validateStringArray(undefined, 5, 10, "tags")).toBeUndefined();
  });

  it("returns the array for valid input", () => {
    expect(validateStringArray(["a", "b"], 5, 10, "tags")).toEqual(["a", "b"]);
  });

  it("throws for non-array input", () => {
    try {
      validateStringArray("not-array", 5, 10, "tags");
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("invalid_type");
    }
  });

  it("throws when array exceeds max items", () => {
    try {
      validateStringArray(["a", "b", "c"], 2, 10, "tags");
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("too_many_items");
    }
  });

  it("throws when an item is not a string", () => {
    try {
      validateStringArray(["a", 123], 5, 10, "tags");
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("invalid_type");
    }
  });

  it("throws when an item exceeds max length", () => {
    try {
      validateStringArray(["toolong"], 5, 3, "tags");
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("too_long");
    }
  });
});

describe("validateMetadata", () => {
  it("returns undefined for undefined input", () => {
    expect(validateMetadata(undefined, 1000)).toBeUndefined();
  });

  it("returns the object for valid input", () => {
    const metadata = { key: "value" };
    expect(validateMetadata(metadata, 1000)).toEqual(metadata);
  });

  it("throws for null input", () => {
    try {
      validateMetadata(null, 1000);
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("invalid_type");
    }
  });

  it("throws for array input", () => {
    try {
      validateMetadata([1, 2], 1000);
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("invalid_type");
    }
  });

  it("throws when serialized size exceeds limit", () => {
    const large = { data: "x".repeat(200) };
    try {
      validateMetadata(large, 10);
      expect(true).toBe(false);
    } catch (error) {
      expect((error as HttpError).code).toBe("metadata_too_large");
    }
  });
});

describe("sanitizeInput", () => {
  it("returns null and undefined unchanged", () => {
    expect(sanitizeInput(null)).toBeNull();
    expect(sanitizeInput(undefined)).toBeUndefined();
  });

  it("strips control characters and trims strings", () => {
    expect(sanitizeInput("hello\x00world\x1F ")).toBe("helloworld");
  });

  it("returns numbers and booleans unchanged", () => {
    expect(sanitizeInput(42)).toBe(42);
    expect(sanitizeInput(true)).toBe(true);
  });

  it("recursively sanitizes arrays", () => {
    expect(sanitizeInput(["  hello\x00 ", "world "])).toEqual([
      "hello",
      "world",
    ]);
  });

  it("recursively sanitizes objects", () => {
    expect(sanitizeInput({ name: " test\x00 " })).toEqual({ name: "test" });
  });

  it("strips __proto__, constructor, and prototype keys", () => {
    const input: Record<string, unknown> = Object.create(null);
    input["__proto__"] = "bad";
    input["constructor"] = "bad";
    input["prototype"] = "bad";
    input["safe"] = "ok\x00";
    const result = sanitizeInput(input) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["safe"]);
    expect(result["safe"]).toBe("ok");
  });
});
