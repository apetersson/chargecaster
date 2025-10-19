import { z } from "zod";

const INVALID_NUMBER_MESSAGE = "Expected a finite number or numeric string";
const INVALID_BOOLEAN_MESSAGE = "Expected a boolean or recognizable boolean string";
const INVALID_STRING_MESSAGE = "Expected a non-empty string";
const INVALID_TIMESTAMP_MESSAGE = "Expected a valid timestamp";

export const optionalNumberSchema = z.unknown().transform((value, ctx) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_NUMBER_MESSAGE});
      return z.NEVER;
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_NUMBER_MESSAGE});
      return z.NEVER;
    }
    return numeric;
  }
  ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_NUMBER_MESSAGE});
  return z.NEVER;
});

export const nullableNumberSchema = z.unknown().transform((value, ctx) => {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = optionalNumberSchema.safeParse(value);
  if (!parsed.success) {
    ctx.addIssue(parsed.error.issues[0] ?? {code: z.ZodIssueCode.custom, message: INVALID_NUMBER_MESSAGE});
    return z.NEVER;
  }
  return parsed.data ?? null;
});

export const optionalBooleanSchema = z.unknown().transform((value, ctx) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    if (["true", "t", "yes", "y", "on", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "f", "no", "n", "off", "0"].includes(normalized)) {
      return false;
    }
  }
  ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_BOOLEAN_MESSAGE});
  return z.NEVER;
});

export const optionalStringSchema = z.unknown().transform((value, ctx) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_STRING_MESSAGE});
  return z.NEVER;
});

export const optionalTimestampSchema = z.unknown().transform((value, ctx) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  let dateValue: Date | null = null;
  if (value instanceof Date) {
    dateValue = new Date(value.getTime());
  } else if (typeof value === "number") {
    const timestamp = value > 1e12 ? value : value * 1000;
    dateValue = new Date(timestamp);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      dateValue = parsed;
    }
  }

  if (!dateValue || Number.isNaN(dateValue.getTime())) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_TIMESTAMP_MESSAGE});
    return z.NEVER;
  }

  return dateValue.toISOString();
});

export const requiredTimestampSchema = z.unknown().transform((value, ctx) => {
  const parsed = optionalTimestampSchema.safeParse(value);
  if (!parsed.success || !parsed.data) {
    ctx.addIssue({code: z.ZodIssueCode.custom, message: INVALID_TIMESTAMP_MESSAGE});
    return z.NEVER;
  }
  return parsed.data;
});

export const unknownRecordSchema = z.record(z.unknown());
export type UnknownRecord = Record<string, unknown>;
