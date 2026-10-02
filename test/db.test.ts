import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toOrdered } from '../src/db.ts';

test('D1: benannte Parameter werden nummeriert, "@" in Textliteralen bleibt unverändert', () => {
  const r = toOrdered(`SELECT CASE WHEN email LIKE '%@ohne-app.invalid' THEN '' ELSE 'it''s @x' END FROM t WHERE ws = @ws AND a = @a OR ws = @ws`, { ws: 'w1', a: 2 });
  assert.equal(r.sql, `SELECT CASE WHEN email LIKE '%@ohne-app.invalid' THEN '' ELSE 'it''s @x' END FROM t WHERE ws = ?1 AND a = ?2 OR ws = ?1`);
  assert.deepEqual(r.values, ['w1', 2]);
  assert.throws(() => toOrdered('SELECT @fehlt', {}), /@fehlt/);
});
