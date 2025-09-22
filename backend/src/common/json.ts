export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonCompatibleValue = JsonValue | Date;

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
export interface JsonObject {
  [key: string]: JsonValue;
}

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
export interface MutableJsonObject {
  [key: string]: JsonCompatibleValue | undefined;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sanitizeJsonObject = (value: unknown): JsonObject | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  } catch {
    return null;
  }
};

export const sanitizeMutableJsonObject = (value: unknown): MutableJsonObject | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as MutableJsonObject;
  } catch {
    return null;
  }
};
