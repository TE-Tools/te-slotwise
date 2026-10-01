import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lessonPrice, parseMoney, parsePeriod, toCsv } from '../src/services/billing.ts';

test('Beträge lesen', () => {
  assert.equal(parseMoney('25'), 2500);
  assert.equal(parseMoney('25,5'), 2550);
  assert.equal(parseMoney(' 25,50 € '), 2550);
  assert.equal(parseMoney('25.50'), 2550);
  assert.equal(parseMoney('1.234,50'), 123450);
  assert.equal(parseMoney('1.234'), 123400);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('-5'), undefined);
  assert.equal(parseMoney('2,555'), undefined);
  assert.equal(parseMoney('abc'), undefined);
});

test('Preis pro Termin oder anteilig pro Stunde', () => {
  assert.equal(lessonPrice(3000, 'lesson', 45), 3000);
  assert.equal(lessonPrice(4000, 'hour', 45), 3000);
  assert.equal(lessonPrice(null, 'hour', 45), null);
});

test('Zeitraum: Monat und Jahr', () => {
  const m = parsePeriod({}, '2026-12-15');
  assert.deepEqual([m.kind, m.from, m.to, m.prev, m.next, m.label], ['month', '2026-12-01', '2027-01-01', '2026-11', '2027-01', 'Dezember 2026']);
  const y = parsePeriod({ year: '2026' }, '2026-12-15');
  assert.deepEqual([y.kind, y.from, y.to], ['year', '2026-01-01', '2027-01-01']);
  assert.equal(parsePeriod({ month: '2026-13' }, '2026-03-01').key, '2026-03');
});

test('CSV: Semikolon, Anführungszeichen, keine Formeln', () => {
  const csv = toCsv([['a;b', '=SUMME(A1)', '-5', 'x"y']]);
  assert.equal(csv, '﻿"a;b";\'=SUMME(A1);-5;"x""y"\r\n');
});
