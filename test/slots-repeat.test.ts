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
