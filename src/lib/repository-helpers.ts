import type { JSONValue } from "postgres";

export function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}
