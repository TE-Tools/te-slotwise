import type { Db } from '../db.ts';
import { nowIso } from '../ids.ts';
import { localToUtc } from '../time.ts';
import { MONTHS, shiftMonth } from '../views/calendar.ts';

// Schülerübersicht und Abrechnung.
// - Preis: Standardpreis des Arbeitsbereichs oder individueller Preis pro Person (student_rates),
//   pro Termin oder pro 60 Minuten (anteilig).
// - Nach dem Termin wird abgehakt (attendance). Beim Abhaken wird der Preis am Termin festgeschrieben,
//   damit spätere Preisänderungen alte Termine nicht verändern.
// - Pro Termin wird der bezahlte Betrag erfasst (paid_cents).
// Beträge sind immer ganze Cent (Euro).

export type Attendance = 'attended' | 'absent_billed' | 'absent';
export type PriceUnit = 'lesson' | 'hour';

export const ATTENDANCE_LABELS: Record<Attendance, string> = {
  attended: 'Stattgefunden',
  absent_billed: 'Gefehlt (wird berechnet)',
  absent: 'Ausgefallen (nicht berechnet)',
};

export const PRICE_UNIT_LABELS: Record<PriceUnit, string> = {
  lesson: 'pro Termin (Unterrichtsstunde)',
  hour: 'pro 60 Minuten (anteilig nach Dauer)',
};

export const MAX_CENTS = 10_000_000;

const billable = (a: Attendance | null) => a === 'attended' || a === 'absent_billed';

const moneyFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
export function formatMoney(cents: number) {
  return moneyFmt.format(cents / 100);
}

/** Betrag für Eingabefelder, z. B. 2550 → "25,50". */
export function moneyInput(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * Liest einen Eurobetrag: "25", "25,5", "25,50", "25.50", "1.234,50", "25 €".
 * Leer → null, ungültig → undefined.
 */
export function parseMoney(raw: string): number | null | undefined {
  let s = raw.replace(/[\s€]/g, '').replace(/^EUR|EUR$/i, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // Tausenderpunkte
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const cents = Math.round(Number(s) * 100);
  return cents <= MAX_CENTS ? cents : undefined;
}

export function formatHours(minutes: number) {
  return `${(minutes / 60).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Std.`;
}

/** Preis eines Termins aus dem Satz (pro Termin oder pro 60 Minuten). */
export function lessonPrice(rateCents: number | null, unit: PriceUnit, minutes: number): number | null {
  if (rateCents === null) return null;
  return unit === 'hour' ? Math.round((rateCents * minutes) / 60) : rateCents;
}

export async function saveBillingSettings(db: Db, wsId: string, defaultCents: number | null, unit: PriceUnit) {
  await db.run(`UPDATE workspaces SET default_price_cents = ?, price_unit = ? WHERE id = ?`, [defaultCents, unit, wsId]);
}

/** Individuellen Preis setzen; null entfernt ihn (dann gilt der Standardpreis). */
export async function setStudentRate(db: Db, wsId: string, userId: string, cents: number | null) {
  if (cents === null) {
    await db.run(`DELETE FROM student_rates WHERE workspace_id = ? AND user_id = ?`, [wsId, userId]);
  } else {
    await db.run(
      `INSERT INTO student_rates (workspace_id, user_id, price_cents, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET price_cents = excluded.price_cents, updated_at = excluded.updated_at`,
      [wsId, userId, cents, nowIso()],
    );
  }
}

// ---------- Zeitraum ----------

export interface Period {
  kind: 'month' | 'year';
  /** "2026-10" bzw. "2026" */
  key: string;
  label: string;
  /** Lokale Datumsgrenzen [from, to) */
  from: string;
  to: string;
  prev: string;
  next: string;
  /** Query-Parameter für Links, z. B. "month=2026-10" */
  query: string;
}

export function parsePeriod(q: { month?: string; year?: string }, today: string): Period {
  if (q.year && /^\d{4}$/.test(q.year)) {
    const y = Number(q.year);
    return { kind: 'year', key: q.year, label: `Jahr ${y}`, from: `${y}-01-01`, to: `${y + 1}-01-01`, prev: String(y - 1), next: String(y + 1), query: `year=${y}` };
  }
  const month = q.month && /^\d{4}-(0[1-9]|1[0-2])$/.test(q.month) ? q.month : today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  return {
    kind: 'month',
    key: month,
    label: `${MONTHS[m - 1]} ${y}`,
    from: `${month}-01`,
    to: `${shiftMonth(month, 1)}-01`,
    prev: shiftMonth(month, -1),
    next: shiftMonth(month, 1),
    query: `month=${month}`,
  };
}

export function periodRangeIso(p: Pick<Period, 'from' | 'to'>, tz: string): [string, string] {
  return [new Date(localToUtc(p.from, '00:00', tz)).toISOString(), new Date(localToUtc(p.to, '00:00', tz)).toISOString()];
}

// ---------- Schüler:innen und Termine ----------

export interface StudentRow {
  user_id: string;
  display_name: string;
  email: string;
  role: string | null;
  /** individueller Preis (Cent) oder null */
  own_price_cents: number | null;
  /** Mitgliedschaft im Bereich (null = extern, nur über öffentliche Seite gebucht) */
  membership_id: string | null;
  /** Gruppen (z. B. Instrumente), durch „, “ getrennt */
  group_names: string | null;
  address_street: string;
  address_zip: string;
  address_city: string;
  birth_date: string | null;
  phone: string;
  billing_name: string;
}

/**
 * Schüler:innen eines Arbeitsbereichs: Mitglieder mit Rolle „Mitglied“ und alle, die hier einen
 * festen Termin hatten oder haben (auch ohne Mitgliedschaft).
 */
export async function listStudents(db: Db, wsId: string) {
  return await db.all<StudentRow>(
    `SELECT u.id AS user_id, u.display_name, u.email, m.role, sr.price_cents AS own_price_cents, m.id AS membership_id,
       (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT g.name FROM group_members gm JOIN ws_groups g ON g.id = gm.group_id WHERE gm.membership_id = m.id ORDER BY g.name COLLATE NOCASE)) AS group_names,
       u.address_street, u.address_zip, u.address_city, u.birth_date, u.phone, u.billing_name
     FROM users u
     LEFT JOIN memberships m ON m.user_id = u.id AND m.workspace_id = @ws
     LEFT JOIN student_rates sr ON sr.user_id = u.id AND sr.workspace_id = @ws
     WHERE u.id IN (
       SELECT user_id FROM memberships WHERE workspace_id = @ws AND role = 'member'
       UNION SELECT user_id FROM bookings WHERE workspace_id = @ws AND (status = 'confirmed' OR attendance IS NOT NULL OR paid_cents > 0))
     ORDER BY u.display_name COLLATE NOCASE, u.email`,
    { ws: wsId },
  );
}

export async function getStudent(db: Db, wsId: string, userId: string) {
  return (await listStudents(db, wsId)).find((s) => s.user_id === userId);
}

export interface LessonRow {
  id: string;
  user_id: string;
  student_name: string;
  student_email: string;
  offering_name: string;
  status: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  attendance: Attendance | null;
  price_cents: number | null;
  paid_cents: number;
  paid_at: string | null;
  /** aktueller Satz (individuell oder Standard) in Cent */
  rate_cents: number | null;
  /** gewählte Gruppe (z. B. Instrument) */
  group_name: string | null;
  minutes: number;
}

/**
 * Termine für die Abrechnung: feste Buchungen sowie alles, was schon abgehakt oder bezahlt wurde
 * (auch wenn es später abgesagt wurde, damit kein bezahlter Betrag verschwindet).
 */
export async function listLessons(db: Db, wsId: string, f: { fromIso?: string; toIso?: string; userId?: string; uncheckedBeforeIso?: string; ids?: string[] }) {
  const where = [`b.workspace_id = @ws`, `(b.status = 'confirmed' OR b.attendance IS NOT NULL OR b.paid_cents > 0)`];
  const params: Record<string, string> = { ws: wsId };
  if (f.fromIso) {
    where.push('b.starts_at >= @from');
    params.from = f.fromIso;
  }
  if (f.toIso) {
    where.push('b.starts_at < @to');
    params.to = f.toIso;
  }
  if (f.userId) {
    where.push('b.user_id = @uid');
    params.uid = f.userId;
  }
  if (f.uncheckedBeforeIso) {
    where.push(`b.attendance IS NULL AND b.status = 'confirmed' AND b.ends_at <= @before`);
    params.before = f.uncheckedBeforeIso;
  }
  if (f.ids) {
    if (!f.ids.length) return [];
    const names = f.ids.slice(0, 500).map((id, i) => {
      params[`id${i}`] = id;
      return `@id${i}`;
    });
    where.push(`b.id IN (${names.join(', ')})`);
  }
  const rows = await db.all<Omit<LessonRow, 'rate_cents' | 'minutes'> & { own_rate: number | null; default_rate: number | null; price_unit: PriceUnit }>(
    `SELECT b.id, b.user_id, u.display_name AS student_name, u.email AS student_email, o.name AS offering_name, b.status,
       b.starts_at, b.ends_at, s.timezone, b.attendance, b.price_cents, b.paid_cents, b.paid_at,
       sr.price_cents AS own_rate, w.default_price_cents AS default_rate, w.price_unit,
       (SELECT g.name FROM ws_groups g WHERE g.id = b.group_id) AS group_name
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id AND s.workspace_id = b.workspace_id
     JOIN offerings o ON o.id = b.offering_id AND o.workspace_id = b.workspace_id
     JOIN users u ON u.id = b.user_id
     JOIN workspaces w ON w.id = b.workspace_id
     LEFT JOIN student_rates sr ON sr.workspace_id = b.workspace_id AND sr.user_id = b.user_id
     WHERE ${where.join(' AND ')} ORDER BY b.starts_at LIMIT 5000`,
    params,
  );
  return rows.map(({ own_rate, default_rate, price_unit, ...r }): LessonRow => {
    const minutes = Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60_000);
    return { ...r, minutes, rate_cents: lessonPrice(own_rate ?? default_rate, price_unit, minutes) };
  });
}

/** Betrag, der für einen Termin berechnet wird (0 bei nicht abgehakt oder ausgefallen). */
export function dueCents(l: Pick<LessonRow, 'attendance' | 'price_cents' | 'rate_cents'>) {
  return billable(l.attendance) ? (l.price_cents ?? l.rate_cents ?? 0) : 0;
}

/** Preis, der beim Termin angezeigt wird: festgeschrieben oder aktueller Satz. */
export function shownPrice(l: Pick<LessonRow, 'price_cents' | 'rate_cents'>) {
  return l.price_cents ?? l.rate_cents;
}

export interface Totals {
  lessons: number;
  planned: number;
  unchecked: number;
  attended: number;
  attendedMinutes: number;
  absentBilled: number;
  absent: number;
  billedMinutes: number;
  dueCents: number;
  paidCents: number;
  /** Termine ohne Preis (weder Standard- noch individueller Preis) */
  missingPrice: number;
}

export const emptyTotals = (): Totals => ({
  lessons: 0,
  planned: 0,
  unchecked: 0,
  attended: 0,
  attendedMinutes: 0,
  absentBilled: 0,
  absent: 0,
  billedMinutes: 0,
  dueCents: 0,
  paidCents: 0,
  missingPrice: 0,
});

export function addToTotals(t: Totals, l: LessonRow, now = Date.now()) {
  t.lessons++;
  t.paidCents += l.paid_cents;
  if (l.attendance === null) {
    if (Date.parse(l.ends_at) > now) t.planned++;
    else if (l.status === 'confirmed') t.unchecked++;
    return t;
  }
  if (l.attendance === 'attended') {
    t.attended++;
    t.attendedMinutes += l.minutes;
  } else if (l.attendance === 'absent_billed') t.absentBilled++;
  else t.absent++;
  if (billable(l.attendance)) {
    t.billedMinutes += l.minutes;
    t.dueCents += dueCents(l);
    if (l.price_cents === null && l.rate_cents === null) t.missingPrice++;
  }
  return t;
}

export function totalsBy<K>(lessons: LessonRow[], key: (l: LessonRow) => K, now = Date.now()) {
  const out = new Map<K, Totals>();
  for (const l of lessons) {
    const k = key(l);
    if (!out.has(k)) out.set(k, emptyTotals());
    addToTotals(out.get(k)!, l, now);
  }
  return out;
}

// ---------- Abhaken und Zahlungen ----------

export interface LessonUpdate {
  id: string;
  attendance: Attendance | null;
  /** Preis für diesen Termin in Cent; null = aktuellen Satz verwenden */
  priceCents: number | null;
  paidCents: number;
}

/**
 * Speichert Anwesenheit, Preis und bezahlten Betrag. Nur Termine dieses Arbeitsbereichs.
 * Beim Abhaken als „berechnet“ wird der Preis festgeschrieben (eingegebener Preis oder aktueller Satz).
 */
export async function saveLessons(db: Db, wsId: string, updates: LessonUpdate[], now = Date.now()) {
  const current = new Map((await listLessons(db, wsId, { ids: updates.map((u) => u.id) })).map((l) => [l.id, l]));
  let changed = 0;
  for (const u of updates) {
    const l = current.get(u.id);
    if (!l) continue;
    let price = u.priceCents;
    // Ohne Abweichung vom Satz bleibt ein nicht abgehakter Termin ohne festen Preis (folgt späteren Änderungen).
    if (price !== null && price === l.rate_cents && l.price_cents === null && !billable(u.attendance)) price = null;
    if (price === null && billable(u.attendance)) price = l.price_cents ?? l.rate_cents;
    const paidAt = u.paidCents > 0 ? (l.paid_cents === u.paidCents && l.paid_at ? l.paid_at : nowIso(now)) : null;
    const checkedAt = u.attendance ? nowIso(now) : null;
    if (l.attendance === u.attendance && l.price_cents === price && l.paid_cents === u.paidCents) continue;
    changed += await db.run(
      `UPDATE bookings SET attendance = ?, price_cents = ?, paid_cents = ?, paid_at = ?,
         checked_at = CASE WHEN ? IS NULL THEN NULL WHEN attendance IS ? THEN checked_at ELSE ? END
       WHERE id = ? AND workspace_id = ?`,
      [u.attendance, price, u.paidCents, paidAt, checkedAt, u.attendance, checkedAt, u.id, wsId],
    );
  }
  return changed;
}

/** Alle vergangenen, noch nicht abgehakten Termine der Auswahl als „stattgefunden“ markieren. */
export async function markAttended(db: Db, wsId: string, ids: string[], now = Date.now()) {
  const lessons = await listLessons(db, wsId, { ids, uncheckedBeforeIso: nowIso(now) });
  return await saveLessons(
    db,
    wsId,
    lessons.map((l) => ({ id: l.id, attendance: 'attended', priceCents: l.price_cents, paidCents: l.paid_cents })),
    now,
  );
}

/** Alle berechneten Termine der Auswahl als vollständig bezahlt markieren. */
export async function markPaid(db: Db, wsId: string, ids: string[], now = Date.now()) {
  const lessons = (await listLessons(db, wsId, { ids })).filter((l) => billable(l.attendance) && dueCents(l) > l.paid_cents);
  return await saveLessons(
    db,
    wsId,
    lessons.map((l) => ({ id: l.id, attendance: l.attendance, priceCents: l.price_cents, paidCents: dueCents(l) })),
    now,
  );
}

/** Anzahl vergangener, nicht abgehakter Termine (für Hinweise in der Übersicht). */
export async function uncheckedCount(db: Db, wsId: string, now = Date.now()) {
  return (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bookings WHERE workspace_id = ? AND status = 'confirmed' AND attendance IS NULL AND ends_at <= ?`,
    [wsId, nowIso(now)],
  ))!.n;
}

/** Monate (YYYY-MM) eines Jahres – für die Jahresübersicht. */
export function monthsOfYear(year: string) {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/** CSV mit Semikolon und deutschem Dezimalkomma (öffnet direkt in Excel/LibreOffice). */
export function toCsv(rows: (string | number)[][]) {
  const cell = (v: string | number) => {
    const s = String(v);
    // Formeln in Tabellenprogrammen verhindern (CSV-Injection).
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

export const centsCsv = (cents: number | null) => (cents === null ? '' : (cents / 100).toFixed(2).replace('.', ','));

