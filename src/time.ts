// Zeitzonen-Hilfen ohne Fremdbibliothek, auf Basis von Intl.
// Gespeichert wird immer UTC; Eingabe und Anzeige erfolgen in einer IANA-Zeitzone
// (z. B. Europe/Berlin). Sommer-/Winterzeit wird über Intl korrekt aufgelöst.

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function localParts(utcMs: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}

/** Abstand der Zone zu UTC in Millisekunden zum Zeitpunkt utcMs. */
export function tzOffsetMs(utcMs: number, tz: string): number {
  const base = Math.floor(utcMs / 60000) * 60000;
  const p = localParts(base, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - base;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class LocalTimeError extends Error {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

/**
 * Wandelt ein lokales Datum + Uhrzeit in einer Zeitzone in einen UTC-Zeitpunkt.
 * Bei doppelt vorkommenden Zeiten (Umstellung auf Winterzeit) gilt die frühere.
 * Nicht existierende Zeiten (Umstellung auf Sommerzeit) werden abgelehnt.
 */
export function localToUtc(date: string, time: string, tz: string): number {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new LocalTimeError('Ungültiges Datum oder ungültige Uhrzeit.');
  const [y, mo, da, h, mi] = [+d[1], +d[2], +d[3], +t[1], +t[2]];
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) throw new LocalTimeError('Ungültiges Datum oder ungültige Uhrzeit.');
  const naive = Date.UTC(y, mo - 1, da, h, mi);
  const offsets = new Set([tzOffsetMs(naive - 86_400_000, tz), tzOffsetMs(naive, tz), tzOffsetMs(naive + 86_400_000, tz)]);
  const matches: number[] = [];
  for (const off of offsets) {
    const candidate = naive - off;
    const p = localParts(candidate, tz);
    if (p.year === y && p.month === mo && p.day === da && p.hour === h && p.minute === mi) matches.push(candidate);
  }
  if (!matches.length) {
    // Entweder gibt es das Datum nicht (31.02.) oder die Uhrzeit fällt in die Zeitumstellung.
    const check = new Date(Date.UTC(y, mo - 1, da));
    if (check.getUTCDate() !== da) throw new LocalTimeError('Dieses Datum gibt es nicht.');
    throw new LocalTimeError(`${date} ${time} existiert in ${tz} wegen der Zeitumstellung nicht.`);
  }
  return Math.min(...matches);
}

/** Datum (YYYY-MM-DD) eines Zeitpunkts in einer Zone. */
export function localDate(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function localTime(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Kalendertage addieren (ohne Zeitzone, reines Datum). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Wochentag 1 = Montag … 7 = Sonntag. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return wd === 0 ? 7 : wd;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string, kind: 'date' | 'dateShort' | 'time' | 'zone') {
  const key = `${tz}|${kind}`;
  let f = fmtCache.get(key);
  if (!f) {
    const opts: Intl.DateTimeFormatOptions =
      kind === 'date'
        ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
        : kind === 'dateShort'
          ? { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }
          : kind === 'time'
            ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
            : { timeZoneName: 'short' };
    f = new Intl.DateTimeFormat('de-DE', { ...opts, timeZone: tz });
    fmtCache.set(key, f);
  }
  return f;
}

export function formatDate(utcMs: number, tz: string, long = false) {
  return fmt(tz, long ? 'date' : 'dateShort').format(utcMs);
}

export function formatTime(utcMs: number, tz: string) {
  return fmt(tz, 'time').format(utcMs);
}

/** Kurzname der Zone zum Zeitpunkt, z. B. "MESZ" oder "MEZ". */
export function zoneLabel(utcMs: number, tz: string) {
  const part = fmt(tz, 'zone').formatToParts(utcMs).find((p) => p.type === 'timeZoneName');
  return part?.value ?? tz;
}

export function durationLabel(minutes: number) {
  if (minutes < 60) return `${minutes} Min.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

/** "Mo., 05.10.2026, 14:30–15:15 Uhr (MESZ)" */
export function formatRange(startIso: string, endIso: string, tz: string) {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  const sameDay = localDate(s, tz) === localDate(e, tz);
  const end = sameDay ? formatTime(e, tz) : `${formatDate(e, tz)}, ${formatTime(e, tz)}`;
  return `${formatDate(s, tz)}, ${formatTime(s, tz)}–${end} Uhr (${zoneLabel(s, tz)})`;
}

export const COMMON_TIME_ZONES = [
  'Europe/Berlin',
  'Europe/Vienna',
  'Europe/Zurich',
  'Europe/Amsterdam',
  'Europe/Brussels',
  'Europe/Luxembourg',
  'Europe/Paris',
  'Europe/London',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Warsaw',
  'Europe/Prague',
  'Europe/Copenhagen',
  'Europe/Stockholm',
  'Europe/Helsinki',
  'Europe/Athens',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Australia/Sydney',
  'UTC',
];
