// Compact number formatting for the flow view. Output is units and digits only.

function trim(value: number): string {
  // One decimal below 10, none from 10 up: 1.2, 12, 120.
  return value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
}

/** 812 -> `812 B`, 1234 -> `1.2 KB`, 5_300_000 -> `5.1 MB`. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${trim(value)} ${units[i]}`;
}

/** 950 -> `950`, 1234 -> `1.2k`, 12_000 -> `12k`, 3_400_000 -> `3.4M`. */
export function formatCount(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count) || count < 0) return '';
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${trim(count / 1000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

/** 64 -> `64 ms`, 1500 -> `1.5 s`. */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${trim(ms / 1000)} s`;
}

/** ISO time -> `5s`, `3m`, `2h`, `4d`. Empty when missing or unparsable. */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
