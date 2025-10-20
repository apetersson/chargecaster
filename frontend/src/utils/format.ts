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

export function statusClass(
  errors?: string[],
  warnings?: string[],
): { label: string; className: string } {
  if (errors && errors.length) {
    return {label: "Errors", className: "status err"};
  }
  if (warnings && warnings.length) {
    return {label: "Warnings", className: "status warn"};
  }
  return {label: "OK", className: "status ok"};
}
