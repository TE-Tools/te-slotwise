import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRange, localToUtc, LocalTimeError } from '../src/time.ts';

test('Sommerzeit: 14:00 in Berlin im Juli ist 12:00 UTC', async () => {
  assert.equal(new Date(localToUtc('2026-07-15', '14:00', 'Europe/Berlin')).toISOString(), '2026-07-15T12:00:00.000Z');
});

test('Winterzeit: 14:00 in Berlin im Januar ist 13:00 UTC', async () => {
  assert.equal(new Date(localToUtc('2027-01-15', '14:00', 'Europe/Berlin')).toISOString(), '2027-01-15T13:00:00.000Z');
});

test('Zeitumstellung Frühjahr: 02:30 existiert nicht', async () => {
  assert.throws(() => localToUtc('2027-03-28', '02:30', 'Europe/Berlin'), LocalTimeError);
});

test('Zeitumstellung Herbst: 02:30 ist doppelt – die frühere (Sommerzeit) gilt', async () => {
  assert.equal(new Date(localToUtc('2026-10-25', '02:30', 'Europe/Berlin')).toISOString(), '2026-10-25T00:30:00.000Z');
});

test('Ungültiges Datum wird abgelehnt', async () => {
  assert.throws(() => localToUtc('2026-02-31', '10:00', 'Europe/Berlin'), LocalTimeError);
});

test('Anzeige nennt Datum, Zeit und Zeitzonenkürzel', async () => {
  const s = formatRange('2026-07-15T12:00:00.000Z', '2026-07-15T13:00:00.000Z', 'Europe/Berlin');
  assert.match(s, /15\.07\.2026, 14:00–15:00 Uhr \(MESZ\)/);
});
