export const numberFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const integerFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export const percentFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

export const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Same as dateTimeFormatter but without seconds for compact display
export const dateTimeNoSecondsFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return `${percentFormatter.format(value)}%`;
}

export function formatNumber(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  const trimmedUnit = unit.trim();
  const nbspUnit = trimmedUnit ? `\u00A0${trimmedUnit}` : "";
  if (trimmedUnit === "slots") {
    return `${integerFormatter.format(value)}${nbspUnit}`;
  }
  return `${numberFormatter.format(value)}${nbspUnit}`;
}

export function formatSignedNumber(value: number | null | undefined, unit = ""): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  const trimmedUnit = unit.trim();
  const nbspUnit = trimmedUnit ? `\u00A0${trimmedUnit}` : "";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${numberFormatter.format(value)}${nbspUnit}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return dateTimeFormatter.format(parsed);
}

export function formatTimeRange(
  startValue: string | null | undefined,
  endValue: string | null | undefined,
): string {
  if (!startValue) {
    return "n/a";
  }
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) {
    return "n/a";
  }
  if (!endValue) {
    return timeFormatter.format(start);
  }
  const end = new Date(endValue);
  if (Number.isNaN(end.getTime())) {
    return timeFormatter.format(start);
  }
  return `${timeFormatter.format(start)}-${timeFormatter.format(end)}`;
}

export function statusClass(
  errors?: string[],
  warnings?: string[],
): { label: string; className: string } {
  if (errors?.length) {
    return {label: "Errors", className: "status err"};
  }
  if (warnings?.length) {
    return {label: "Warnings", className: "status warn"};
  }
  return {label: "OK", className: "status ok"};
}
