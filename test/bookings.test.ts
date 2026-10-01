import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bookerAction, listWorkspaceBookings, proposeSlot, proposeTime, providerDecision, requestBooking, respondToProposal } from '../src/services/bookings.ts';
import { getOffering, saveOffering } from '../src/services/offerings.ts';
import { createSeries, createSlot, listVisibleSlots, type SlotInput } from '../src/services/slots.ts';
import { localToUtc } from '../src/time.ts';
import { addMember, baseOffering, freshDb, futureDate, makeUser, setupWorkspace } from './helpers.ts';

const APP = 'http://localhost:3000';

function slotInput(over: Partial<SlotInput> = {}): SlotInput {
  return {
    kind: 'fixed',
    durationMin: 60,
    bufferMin: 0,
    capacity: 1,
    location: null,
    onlineInfo: null,
    confirmationMode: null,
    status: 'published',
    preference: 'normal',
    visibility: 'inherit',
    audience: { groupIds: [], membershipIds: [] },
    ...over,
  };
}

test('Fester Slot: zweite Buchung wird abgewiesen (keine Doppelbuchung)', async () => {
  const db = await freshDb();
  const { wsId, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '10:00', slotInput());
  const a = await makeUser(db, 'a@example.com');
  const b = await makeUser(db, 'b@example.com');
  const r1 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '' });
  const r2 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: b.id, membershipId: null, note: '' });
  assert.deepEqual(r1.ok && r1.status, 'confirmed');
  assert.deepEqual(r2, { ok: false, code: 'full' });
  // Auch derselbe Nutzer kann nicht zweimal buchen.
  const r3 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '' });
  assert.equal(r3.ok, false);
});

test('Datenbank-Trigger verhindert Überbuchung auch ohne Anwendungsprüfung', async () => {
  const db = await freshDb();
  const { wsId, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '10:00', slotInput());
  const a = await makeUser(db, 'a@example.com');
  const b = await makeUser(db, 'b@example.com');
  await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '' });
  const slot = (await db.get<{ starts_at: string; ends_at: string }>(`SELECT starts_at, ends_at FROM slots WHERE id = ?`, [slotId]))!;
  await assert.rejects(
    async () =>
      await db.run(
        `INSERT INTO bookings (id, workspace_id, slot_id, offering_id, user_id, status, starts_at, ends_at, holds_seat, created_at, updated_at)
         VALUES ('x', ?, ?, ?, ?, 'confirmed', ?, ?, 1, 'now', 'now')`,
        [wsId, slotId, offeringId, b.id, slot.starts_at, slot.ends_at],
      ),
    /slot_full/,
  );
});

test('Manuelle Bestätigung: mehrere Anfragen möglich, nur eine wird bestätigt', async () => {
  const db = await freshDb();
  const { wsId, offeringId, owner } = await setupWorkspace(db);
  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '10:00', slotInput());
  const a = await makeUser(db, 'a@example.com');
  const b = await makeUser(db, 'b@example.com');
  const r1 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '' });
  const r2 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: b.id, membershipId: null, note: '' });
  assert.ok(r1.ok && r2.ok);
  assert.equal(await providerDecision(db, APP, wsId, r1.bookingId, owner.id, 'confirm'), 'ok');
  assert.equal(await providerDecision(db, APP, wsId, r2.bookingId, owner.id, 'confirm'), 'full');
});

test('Zeitfenster: überlappende Wunschzeiten anfragen, Bestätigung prüft Überschneidung', async () => {
  const db = await freshDb();
  const { wsId, offeringId, owner } = await setupWorkspace(db);
  const off = (await getOffering(db, wsId, offeringId))!;
  const day = futureDate();
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', day, '16:00', slotInput({ kind: 'window', durationMin: 180 }));
  const a = await makeUser(db, 'a@example.com');
  const b = await makeUser(db, 'b@example.com');
  const r1 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '', time: '16:45' });
  const r2 = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: b.id, membershipId: null, note: '', time: '17:00' });
  assert.ok(r1.ok && r2.ok, 'beide Anfragen sind erlaubt');
  // Außerhalb des Fensters geht nicht.
  const c = await makeUser(db, 'c@example.com');
  assert.deepEqual(await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: c.id, membershipId: null, note: '', time: '18:30' }), {
    ok: false,
    code: 'bad_time',
  });
  assert.equal(await providerDecision(db, APP, wsId, r1.bookingId, owner.id, 'confirm'), 'ok');
  assert.equal(await providerDecision(db, APP, wsId, r2.bookingId, owner.id, 'confirm'), 'full', '17:00 überschneidet sich mit 16:45–17:45');

  // Anbieter verschiebt die zweite Anfrage auf 17:45 → Kunde muss zustimmen → dann fix.
  const s = localToUtc(day, '17:45', 'Europe/Berlin');
  assert.equal(await proposeTime(db, APP, 'provider', { wsId, userId: owner.id }, r2.bookingId, s, s + 3600_000), 'ok');
  let row = (await listWorkspaceBookings(db, wsId, { id: r2.bookingId }))[0];
  assert.equal(row.status, 'requested');
  assert.equal(row.proposed_by, 'provider');
  assert.equal(await respondToProposal(db, APP, 'booker', { userId: b.id }, r2.bookingId, true), 'ok');
  row = (await listWorkspaceBookings(db, wsId, { id: r2.bookingId }))[0];
  assert.equal(row.status, 'confirmed');
  assert.equal(row.starts_at, new Date(s).toISOString());
  assert.equal(row.proposed_by, null);
});

test('Fixer Termin: Änderung durch Kunden braucht Zustimmung, alte Zeit gilt bis dahin', async () => {
  const db = await freshDb();
  const { wsId, offeringId, owner } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  const off = (await getOffering(db, wsId, offeringId))!;
  const day = futureDate();
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', day, '10:00', slotInput());
  const a = await makeUser(db, 'a@example.com');
  const r = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '' });
  assert.ok(r.ok);
  const oldStart = (await listWorkspaceBookings(db, wsId, { id: r.bookingId }))[0].starts_at;
  const s = localToUtc(day, '11:00', 'Europe/Berlin');
  assert.equal(await proposeTime(db, APP, 'booker', { userId: a.id }, r.bookingId, s, s + 3600_000), 'ok');
  let row = (await listWorkspaceBookings(db, wsId, { id: r.bookingId }))[0];
  assert.equal(row.status, 'confirmed');
  assert.equal(row.starts_at, oldStart, 'alte Zeit bleibt gültig');
  // Der Kunde kann seinen eigenen Vorschlag nicht selbst annehmen.
  assert.equal(await respondToProposal(db, APP, 'booker', { userId: a.id }, r.bookingId, true), 'invalid_state');
  // Anbieter lehnt ab → alte Zeit bleibt.
  assert.equal(await respondToProposal(db, APP, 'provider', { wsId, userId: owner.id }, r.bookingId, false), 'ok');
  row = (await listWorkspaceBookings(db, wsId, { id: r.bookingId }))[0];
  assert.equal(row.starts_at, oldStart);
  assert.equal(row.proposed_by, null);
});

test('Absage durch Kunden nur vor der Frist, sonst Absage-Anfrage', async () => {
  const db = await freshDb();
  const { wsId, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto', cancel_cutoff_hours: 48 });
  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(1), '23:00', slotInput());
  const a = await makeUser(db, 'a@example.com');
  const r = await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: a.id, membershipId: null, note: '' });
  assert.ok(r.ok);
  assert.equal(await bookerAction(db, APP, a.id, r.bookingId, 'cancel'), 'cancel_requested');
  const other = await makeUser(db, 'x@example.com');
  assert.equal(await bookerAction(db, APP, other.id, r.bookingId, 'cancel'), 'not_found', 'fremde Buchung');
});

test('Sichtbarkeit: Gruppen-Slots nur für Gruppenmitglieder, nie öffentlich', async () => {
  const db = await freshDb();
  const { wsId, owner } = await setupWorkspace(db);
  const groupId = 'g1';
  await db.run(`INSERT INTO ws_groups (id, workspace_id, name, created_at) VALUES (?, ?, 'Klasse A', 'now')`, [groupId, wsId]);
  const inGroup = await makeUser(db, 'in@example.com');
  const outside = await makeUser(db, 'out@example.com');
  const midIn = await addMember(db, wsId, inGroup.id);
  const midOut = await addMember(db, wsId, outside.id);
  await db.run(`INSERT INTO group_members (group_id, membership_id, workspace_id, created_at) VALUES (?, ?, ?, 'now')`, [groupId, midIn, wsId]);
  const offId = (await saveOffering(db, wsId, null, { ...baseOffering, name: 'Gruppenkurs', visibility: 'groups' }, { groupIds: [groupId], membershipIds: [] }))!;
  const off = (await getOffering(db, wsId, offId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '09:00', slotInput());

  assert.equal((await listVisibleSlots(db, wsId, midIn, inGroup.id)).length, 1);
  assert.equal((await listVisibleSlots(db, wsId, midOut, outside.id)).length, 0);
  assert.equal((await listVisibleSlots(db, wsId, null, null)).length, 0);
  // Buchen über eine erratene ID scheitert ebenfalls.
  assert.deepEqual(await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: outside.id, membershipId: midOut, note: '' }), { ok: false, code: 'not_found' });
  assert.deepEqual(await requestBooking(db, APP, { workspaceId: wsId, slotId, userId: outside.id, membershipId: null, note: '' }), { ok: false, code: 'not_found' });
  void owner;
});

test('Mandantentrennung: Gruppen/Mitglieder eines anderen Bereichs lassen sich nicht verknüpfen', async () => {
  const db = await freshDb();
  const one = await setupWorkspace(db);
  const two = await setupWorkspace(db);
  const u = await makeUser(db, 'u@example.com');
  const midTwo = await addMember(db, two.wsId, u.id);
  await db.run(`INSERT INTO ws_groups (id, workspace_id, name, created_at) VALUES ('g1', ?, 'G', 'now')`, [one.wsId]);
  await assert.rejects(async () =>
    await db.run(`INSERT INTO group_members (group_id, membership_id, workspace_id, created_at) VALUES ('g1', ?, ?, 'now')`, [midTwo, one.wsId]),
  );
  // Slot eines Bereichs lässt sich nicht über den anderen buchen.
  const off = (await getOffering(db, one.wsId, one.offeringId))!;
  const slotId = await createSlot(db, one.wsId, off, 'Europe/Berlin', futureDate(), '10:00', slotInput());
  assert.deepEqual(await requestBooking(db, APP, { workspaceId: two.wsId, slotId, userId: u.id, membershipId: midTwo, note: '' }), { ok: false, code: 'not_found' });
});

test('Serie: feste Slots nacheinander, Zeitfenster einmal pro Tag', async () => {
  const db = await freshDb();
  const { wsId, offeringId, owner } = await setupWorkspace(db, { duration_min: 45, buffer_min: 15 });
  const off = (await getOffering(db, wsId, offeringId))!;
  const from = futureDate(7);
  const to = futureDate(13);
  const r = await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: from, toDate: to, weekdays: [1, 2, 3, 4, 5, 6, 7], windowStart: '14:00', windowEnd: '18:00' }, slotInput({ durationMin: 45, bufferMin: 15 }));
  assert.equal(r.created, 7 * 4); // 14:00, 15:00, 16:00, 17:00
  const w = await createSeries(db, wsId, owner.id, off, 'Europe/Berlin', { fromDate: futureDate(20), toDate: futureDate(22), weekdays: [1, 2, 3, 4, 5, 6, 7], windowStart: '16:00', windowEnd: '19:00' }, slotInput({ kind: 'window', durationMin: 45 }));
  assert.equal(w.created, 3);
});

test('Buchende wählen nur vorgegebene Slots: Wechsel bei Anfrage sofort, bei festem Termin als Vorschlag', async () => {
  const db = await freshDb();
  const { wsId, offeringId, owner } = await setupWorkspace(db);
  const off = (await getOffering(db, wsId, offeringId))!;
  const s1 = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '10:00', slotInput());
  const s2 = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '12:00', slotInput());
  const a = await makeUser(db, 'a@example.com');
  const r = await requestBooking(db, APP, { workspaceId: wsId, slotId: s1, userId: a.id, membershipId: null, note: '' });
  assert.ok(r.ok);
  // Anfrage: direkter Wechsel auf s2
  assert.equal(await proposeSlot(db, APP, a.id, null, r.bookingId, s2), 'ok');
  let row = (await listWorkspaceBookings(db, wsId, { id: r.bookingId }))[0];
  assert.equal(row.slot_id, s2);
  assert.equal(row.status, 'requested');
  // Bestätigt → Wechsel zurück auf s1 nur als Vorschlag
  assert.equal(await providerDecision(db, APP, wsId, r.bookingId, owner.id, 'confirm'), 'ok');
  assert.equal(await proposeSlot(db, APP, a.id, null, r.bookingId, s1), 'ok');
  row = (await listWorkspaceBookings(db, wsId, { id: r.bookingId }))[0];
  assert.equal(row.slot_id, s2, 'bis zur Zustimmung gilt der alte Termin');
  assert.equal(await respondToProposal(db, APP, 'provider', { wsId, userId: owner.id }, r.bookingId, true), 'ok');
  row = (await listWorkspaceBookings(db, wsId, { id: r.bookingId }))[0];
  assert.equal(row.slot_id, s1);
  assert.equal(row.status, 'confirmed');
  // Fremder/unsichtbarer Slot wird abgelehnt
  assert.equal(await proposeSlot(db, APP, a.id, null, r.bookingId, 'gibt-es-nicht'), 'not_found');
});
