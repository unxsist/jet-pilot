import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { differenceInSeconds } from "date-fns";
import pluralize from "pluralize";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatResourceKind(kind: string) {
  return pluralize(kind);
}

export function injectStrict<T>(key: InjectionKey<T>, fallback?: T) {
  const resolved = inject(key, fallback);
  if (!resolved) {
    throw new Error(`Could not resolve ${key.description}`);
  }
  return resolved;
}

export function formatDateTime(date: Date) {
  return date.toLocaleString();
}

export function formatDateTimeDifference(startDate: Date, endDate: Date) {
  let remainingSeconds = differenceInSeconds(endDate, startDate);

  const days = Math.floor(remainingSeconds / (3600 * 24));
  remainingSeconds -= days * 3600 * 24;

  const hours = Math.floor(remainingSeconds / 3600);
  remainingSeconds -= hours * 3600;

  const minutes = Math.floor(remainingSeconds / 60);
  remainingSeconds -= minutes * 60;

  const seconds = remainingSeconds;

  // Construct the formatted string
  let formattedDuration = "";
  if (days > 0) {
    formattedDuration += `${days}d`;
    if (hours > 0) {
      formattedDuration += `${hours}h`;
    }
  } else if (hours > 0) {
    formattedDuration += `${hours}h`;
    if (minutes > 0) {
      formattedDuration += `${minutes}m`;
    }
  } else if (minutes > 0) {
    formattedDuration += `${minutes}m`;
    if (seconds > 0) {
      formattedDuration += `${seconds}s`;
    }
  } else {
    formattedDuration += `${seconds}s`;
  }

  return formattedDuration;
}

export function formatSnakeCaseToHumanReadable(input: string) {
  return input
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
