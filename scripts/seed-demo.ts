// Legt Beispieldaten für die lokale Entwicklung an. Nicht in Produktion ausführen.
import { loadConfig } from '../src/config.ts';
import { openNodeDb } from '../src/db-node.ts';
import { newId, nowIso } from '../src/ids.ts';
import { hashPassword } from '../src/password.ts';
import { requestBooking } from '../src/services/bookings.ts';
import { getOffering, saveOffering } from '../src/services/offerings.ts';
import { createSeries, createSlot } from '../src/services/slots.ts';
import { addToGroup, createWorkspace, saveGroup, updateWorkspace } from '../src/services/workspaces.ts';
import { addDays, localDate } from '../src/time.ts';

const config = loadConfig(process.env);
if (config.production) throw new Error('Demo-Daten nicht in Produktion anlegen.');
const db = await openNodeDb(config.databasePath);

// Alle Demo-Konten haben das Passwort "demo-passwort".
const DEMO_PASSWORD = 'demo-passwort';
async function user(email: string, name: string) {
  const existing = await db.get<{ id: string }>(`SELECT id FROM users WHERE email = ?`, [email]);
  if (existing) return existing.id;
  const id = newId();
  const [first, last] = name.split(' ');
  await db.run(
    `INSERT INTO users (id, email, first_name, last_name, display_name, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, email, first, last, name, await hashPassword(DEMO_PASSWORD), nowIso(), nowIso()],
  );
  return id;
}

const teacher = await user('lehrkraft@example.test', 'Demo Lehrkraft');
await db.run(`UPDATE users SET account_type = 'teacher' WHERE id = ?`, [teacher]);
const student = await user('schuelerin@example.test', 'Demo Schülerin');
const visitor = await user('besucher@example.test', 'Demo Besucher');

const wsId = await createWorkspace(db, teacher, { name: 'Unterricht Demo', kind: 'personal', timezone: 'Europe/Berlin', description: 'Einzel- und Gruppenunterricht.' });
await updateWorkspace(db, wsId, { name: 'Unterricht Demo', kind: 'personal', timezone: 'Europe/Berlin', description: 'Einzel- und Gruppenunterricht.', publicEnabled: true });
const mid = newId();
await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)`, [mid, wsId, student, nowIso()]);
const group = await saveGroup(db, wsId, null, { name: 'Mittwochsgruppe', description: '' });
await addToGroup(db, wsId, group, mid);

const base = { description: '', location: 'Studio, Raum 2', online_info: '', default_capacity: 1, hold_on_request: 0, allow_self_cancel: 1, cancel_cutoff_hours: 24, min_notice_hours: 2 };
const single = (await saveOffering(db, wsId, null, { ...base, name: 'Einzelstunde', duration_min: 60, buffer_min: 0, confirmation_mode: 'manual', visibility: 'public' }, { groupIds: [], membershipIds: [] }))!;
const groupLesson = (await saveOffering(db, wsId, null, { ...base, name: 'Gruppenstunde', duration_min: 45, buffer_min: 15, default_capacity: 4, confirmation_mode: 'auto', visibility: 'groups' }, { groupIds: [group], membershipIds: [] }))!;

const tomorrow = addDays(localDate(Date.now(), 'Europe/Berlin'), 1);
const slotInput = { bufferMin: 0, capacity: 1, location: null, onlineInfo: null, confirmationMode: null, status: 'published' as const, preference: 'normal' as const, visibility: 'inherit' as const, audience: { groupIds: [], membershipIds: [] } };
// Freie Zeitfenster für die Einzelstunde (Wunschzeit), Mo–Fr 16–19 Uhr, zwei Wochen.
await createSeries(db, wsId, teacher, await (await getOffering(db, wsId, single))!, 'Europe/Berlin', { fromDate: tomorrow, toDate: addDays(tomorrow, 13), weekdays: [1, 2, 3, 4, 5], windowStart: '16:00', windowEnd: '19:00' }, { ...slotInput, kind: 'window', durationMin: 180 });
// Feste Gruppenstunden mittwochs.
await createSeries(db, wsId, teacher, await (await getOffering(db, wsId, groupLesson))!, 'Europe/Berlin', { fromDate: tomorrow, toDate: addDays(tomorrow, 27), weekdays: [3], windowStart: '14:00', windowEnd: '16:00' }, { ...slotInput, kind: 'fixed', durationMin: 45, bufferMin: 15, capacity: 4 });
const sat = await createSlot(db, wsId, await (await getOffering(db, wsId, single))!, 'Europe/Berlin', addDays(tomorrow, 2), '10:00', { ...slotInput, kind: 'fixed', durationMin: 60 });

// Zwei überlappende Wunschzeiten im ersten Zeitfenster.
const firstWindow = (await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? AND kind = 'window' ORDER BY starts_at LIMIT 1`, [wsId]))!.id;
await requestBooking(db, config.appUrl, { workspaceId: wsId, slotId: firstWindow, userId: student, membershipId: mid, note: 'Gern Tonleitern üben.', time: '16:45' });
await requestBooking(db, config.appUrl, { workspaceId: wsId, slotId: firstWindow, userId: visitor, membershipId: null, note: '', time: '17:00' });
await requestBooking(db, config.appUrl, { workspaceId: wsId, slotId: sat, userId: visitor, membershipId: null, note: '' });

const token = (await db.get<{ public_token: string }>(`SELECT public_token FROM workspaces WHERE id = ?`, [wsId]))!.public_token;
console.log('Demo-Daten angelegt.');
console.log(`Anmelden als: lehrkraft@example.test (Anbieter), schuelerin@example.test (Mitglied), besucher@example.test (extern) – Passwort: ${DEMO_PASSWORD}`);
console.log(`Öffentliche Seite: ${config.appUrl}/p/${token}`);
db.close();
