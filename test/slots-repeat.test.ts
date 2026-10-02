import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOffering } from '../src/services/offerings.ts';
import { createSeries, repeatWeek } from '../src/services/slots.ts';
import { addDays, isoWeekday, localDate, localTime } from '../src/time.ts';
import { freshDb, setupWorkspace } from './helpers.ts';

const base = { bufferMin: 0, capacity: 1, location: null, onlineInfo: null, confirmationMode: null, status: 'published' as const, preference: 'normal' as const, visibility: 'inherit' as const, audience: { groupIds: [], membershipIds: [] } };

/** Nächster Montag mindestens eine Woche in der Zukunft. */
function nextMonday() {
  const d = new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10);
  return addDays(d, (8 - isoWeekday(d)) % 7);
}

async function slotTimes(db: Awaited<ReturnType<typeof freshDb>>, wsId: string) {
  return (await db.all<{ starts_at: string }>(`SELECT starts_at FROM slots WHERE workspace_id = ? ORDER BY starts_at`, [wsId])).map((r) => {
    const t = Date.parse(r.starts_at);
    return `${localDate(t, 'Europe/Berlin')} ${localTime(t, 'Europe/Berlin')}`;
  });
}

test('Serie alle 2 Wochen: nur jede zweite Woche, Uhrzeit bleibt über die Zeitumstellung gleich', async () => {
  const db = await freshDb();
  const { owner, wsId, offeringId } = await setupWorkspace(db, { duration_min: 45 });
  const off = (await getOffering(db, wsId, offeringId))!;
  const mon = nextMonday();
  const r = await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: addDays(mon, 1), toDate: addDays(mon, 8 * 7), weekdays: [2], windowStart: '16:00', windowEnd: '16:45', everyWeeks: 2 }, { ...base, kind: 'fixed', durationMin: 45 });
  assert.equal(r.created, 4);
  const times = await slotTimes(db, wsId);
  assert.deepEqual(times, [0, 2, 4, 6].map((w) => `${addDays(mon, 1 + 7 * w)} 16:00`));
});

test('Woche wiederholen: Slots der Woche in die nächsten Wochen, ohne Doppelte', async () => {
  const db = await freshDb();
  const { owner, wsId, offeringId } = await setupWorkspace(db, { duration_min: 60 });
  const off = (await getOffering(db, wsId, offeringId))!;
  const mon = nextMonday();
  // Woche 1: Di 16 und 17 Uhr, Do 15 Uhr.
  await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: mon, toDate: addDays(mon, 6), weekdays: [2], windowStart: '16:00', windowEnd: '18:00' }, { ...base, kind: 'fixed', durationMin: 60 });
  await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: mon, toDate: addDays(mon, 6), weekdays: [4], windowStart: '15:00', windowEnd: '16:00' }, { ...base, kind: 'fixed', durationMin: 60 });
  // In Woche 3 gibt es Di 16 Uhr schon – wird übersprungen.
  await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: addDays(mon, 15), toDate: addDays(mon, 15), weekdays: [2], windowStart: '16:00', windowEnd: '17:00' }, { ...base, kind: 'fixed', durationMin: 60 });
  const r = await repeatWeek(db, wsId, mon, 'Europe/Berlin', 3);
  assert.deepEqual(r, { source: 3, created: 8, skipped: 1 });
  const times = await slotTimes(db, wsId);
  assert.equal(times.length, 12);
  for (let w = 0; w < 4; w++) {
    assert.ok(times.includes(`${addDays(mon, 1 + 7 * w)} 16:00`));
    assert.ok(times.includes(`${addDays(mon, 1 + 7 * w)} 17:00`));
    assert.ok(times.includes(`${addDays(mon, 3 + 7 * w)} 15:00`));
  }
  // Erneut ausführen erzeugt nichts Doppeltes.
  assert.equal((await repeatWeek(db, wsId, mon, 'Europe/Berlin', 3)).created, 0);
});

test('Woche wiederholen übernimmt auch freie Zeitfenster', async () => {
  const db = await freshDb();
  const { owner, wsId, offeringId } = await setupWorkspace(db, { duration_min: 45 });
  const off = (await getOffering(db, wsId, offeringId))!;
  const mon = nextMonday();
  await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: mon, toDate: mon, weekdays: [1], windowStart: '16:00', windowEnd: '19:30' }, { ...base, kind: 'window', durationMin: 45 });
  const r = await repeatWeek(db, wsId, mon, 'Europe/Berlin', 2);
  assert.equal(r.created, 2);
  const kinds = await db.all<{ kind: string; n: number }>(`SELECT kind, COUNT(*) AS n FROM slots GROUP BY kind`);
  assert.deepEqual(kinds.map((k) => ({ ...k })), [{ kind: 'window', n: 3 }]);
});

// ---------- Nachträglich ändern ----------
import { requestBooking } from '../src/services/bookings.ts';
import { updateSlots } from '../src/services/slots.ts';
import { addMember, makeUser } from './helpers.ts';

const input = (kind: 'fixed' | 'window', durationMin: number) => ({ ...base, kind, durationMin });

async function windowWithBooking() {
  const db = await freshDb();
  const { owner, wsId, offeringId } = await setupWorkspace(db, { duration_min: 45, confirmation_mode: 'auto', visibility: 'internal' });
  const off = (await getOffering(db, wsId, offeringId))!;
  const mon = nextMonday();
  await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: mon, toDate: addDays(mon, 27), weekdays: [1], windowStart: '16:00', windowEnd: '18:00' }, input('window', 120));
  const slots = await db.all<{ id: string; starts_at: string }>(`SELECT id, starts_at FROM slots WHERE workspace_id = ? ORDER BY starts_at`, [wsId]);
  const kid = await makeUser(db, `kind-${Math.random()}@example.com`, 'Kim Kind');
  const mid = await addMember(db, wsId, kid.id);
  // Buchung im zweiten Zeitfenster 16:30–17:15.
  const b = await requestBooking(db, 'http://x', { workspaceId: wsId, slotId: slots[1].id, userId: kid.id, membershipId: mid, note: '', time: '16:30' });
  assert.ok(b.ok);
  return { db, wsId, off, mon, slots };
}

const span = async (db: Awaited<ReturnType<typeof freshDb>>, id: string) => {
  const s = (await db.get<{ kind: string; starts_at: string; ends_at: string }>(`SELECT kind, starts_at, ends_at FROM slots WHERE id = ?`, [id]))!;
  return `${s.kind} ${localTime(Date.parse(s.starts_at), 'Europe/Berlin')}-${localTime(Date.parse(s.ends_at), 'Europe/Berlin')}`;
};

test('Zeitfenster mit Buchung verlängern und verkürzen, solange die Buchung hineinpasst', async () => {
  const { db, wsId, mon, slots } = await windowWithBooking();
  const id = slots[1].id;
  const day = addDays(mon, 7);
  let r = await updateSlots(db, wsId, id, { date: day, time: '15:00', input: input('window', 240) }, 'one');
  assert.equal(r.skipped.length, 0);
  assert.equal(await span(db, id), 'window 15:00-19:00');
  // Verkürzen so, dass 16:30–17:15 herausfällt: Zeit bleibt, Hinweis kommt.
  r = await updateSlots(db, wsId, id, { date: day, time: '16:45', input: input('window', 75) }, 'one');
  assert.match(r.skipped[0].reason, /passen nicht mehr/);
  assert.equal(await span(db, id), 'window 15:00-19:00');
  // Genau passend verkürzen geht.
  r = await updateSlots(db, wsId, id, { date: day, time: '16:30', input: input('window', 45) }, 'one');
  assert.equal(r.skipped.length, 0);
  assert.equal(await span(db, id), 'window 16:30-17:15');
  // Art ändern geht mit Buchung nicht.
  r = await updateSlots(db, wsId, id, { date: day, time: '16:30', input: input('fixed', 45) }, 'one');
  assert.match(r.skipped[0].reason, /Art bleibt/);
  assert.equal(await span(db, id), 'window 16:30-17:15');
});

test('Art umwandeln: Zeitfenster wird in feste Termine aufgeteilt, fester Termin wird Zeitfenster', async () => {
  const { db, wsId, mon, slots } = await windowWithBooking();
  const r = await updateSlots(db, wsId, slots[0].id, { date: mon, time: '16:00', input: input('fixed', 120) }, 'one');
  assert.deepEqual({ updated: r.updated, created: r.created, skipped: r.skipped.length }, { updated: 1, created: 1, skipped: 0 });
  const day0 = await db.all<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? AND starts_at < ? ORDER BY starts_at`, [wsId, slots[1].starts_at]);
  assert.deepEqual(await Promise.all(day0.map((s) => span(db, s.id))), ['fixed 16:00-16:45', 'fixed 16:45-17:30']);
  // Und zurück: fester Termin → Zeitfenster.
  await updateSlots(db, wsId, day0[1].id, { date: mon, time: '16:45', input: input('window', 75) }, 'one');
  assert.equal(await span(db, day0[1].id), 'window 16:45-18:00');
});

test('Alle folgenden der Serie ändern: neue Zeiten, gebuchte Slots werden gemeldet', async () => {
  const { db, wsId, mon, slots } = await windowWithBooking();
  // Ab Woche 1: 15:00–17:00 statt 16:00–18:00 – Woche 2 hat eine Buchung 16:30–17:15, die nicht mehr passt.
  const r = await updateSlots(db, wsId, slots[0].id, { date: mon, time: '15:00', input: input('window', 120) }, 'following');
  assert.equal(r.skipped.length, 1);
  assert.equal(localDate(Date.parse(r.skipped[0].startsAt), 'Europe/Berlin'), addDays(mon, 7));
  assert.deepEqual(await Promise.all(slots.map((s) => span(db, s.id))), ['window 15:00-17:00', 'window 16:00-18:00', 'window 15:00-17:00', 'window 15:00-17:00']);
  // Nur ab Woche 3 auf Dienstag verschieben (über die Zeitumstellung hinweg bleibt die Ortszeit gleich).
  const r2 = await updateSlots(db, wsId, slots[2].id, { date: addDays(mon, 15), time: '15:00', input: input('window', 120) }, 'following');
  assert.equal(r2.skipped.length, 0);
  const days = await db.all<{ starts_at: string }>(`SELECT starts_at FROM slots WHERE id IN (?, ?) ORDER BY starts_at`, [slots[2].id, slots[3].id]);
  assert.deepEqual(days.map((d) => `${localDate(Date.parse(d.starts_at), 'Europe/Berlin')} ${localTime(Date.parse(d.starts_at), 'Europe/Berlin')}`), [`${addDays(mon, 15)} 15:00`, `${addDays(mon, 22)} 15:00`]);
});
