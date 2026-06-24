import { HttpError } from "./errors";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function validateUuidParam(value: string, paramName: string): void {
  if (!isValidUuid(value)) {
    throw new HttpError(400, "invalid_uuid", `${paramName} must be a valid UUID`);
  }
}

export const VALIDATION_LIMITS = {
  TITLE_MAX_LENGTH: 200,
  DESCRIPTION_MAX_LENGTH: 5000,
  DOCUMENT_CONTENT_MAX_LENGTH: 2_000_000,
  NAME_MAX_LENGTH: 100,
  EMAIL_MAX_LENGTH: 254,
  KEYWORD_MAX_LENGTH: 50,
  KEYWORDS_MAX_COUNT: 20,
  METADATA_SIZE_BYTES: 65536,
  ARRAY_MAX_ITEMS: 1000,
} as const;

export function validateStringLength(
  value: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  if (value !== undefined && value.length > maxLength) {
    throw new HttpError(400, "too_long", `${fieldName} must be at most ${maxLength} characters`);
  }
  return value;
}

export function validateStringArray(
  value: unknown,
  maxItems: number,
  maxItemLength: number,
  fieldName: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_type", `${fieldName} must be an array`);
  }
  if (value.length > maxItems) {
    throw new HttpError(400, "too_many_items", `${fieldName} must have at most ${maxItems} items`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new HttpError(400, "invalid_type", `${fieldName} must contain only strings`);
    }
    if (item.length > maxItemLength) {
      throw new HttpError(400, "too_long", `Each item in ${fieldName} must be at most ${maxItemLength} characters`);
    }
  }
  return value as string[];
}

export function validateMetadata(value: unknown, maxSizeBytes: number): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "invalid_type", "metadata must be an object");
  }
  const jsonString = JSON.stringify(value);
  if (jsonString.length > maxSizeBytes) {
    throw new HttpError(400, "metadata_too_large", `metadata must be at most ${maxSizeBytes} bytes when serialized`);
  }
  return value as Record<string, unknown>;
}

export function sanitizeInput(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    return input.replace(/[\x00-\x1F\x7F]/g, "").trim();
  }
  if (Array.isArray(input)) {
    return input.map(sanitizeInput);
  }
  if (typeof input === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized;
  }
  return input;
}
