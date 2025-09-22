/* eslint-disable @typescript-eslint/consistent-indexed-object-style */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type JsonCompatibleValue = JsonValue | Date;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface MutableJsonObject {
  [key: string]: JsonCompatibleValue | undefined;
}

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
