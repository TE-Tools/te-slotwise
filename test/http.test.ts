import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { RateLimiter } from '../src/ratelimit.ts';
import { dispatchPending } from '../src/services/notifications.ts';
import { getOffering } from '../src/services/offerings.ts';
import { createSlot } from '../src/services/slots.ts';
import { updateWorkspace } from '../src/services/workspaces.ts';
import { freshDb, futureDate, setupWorkspace } from './helpers.ts';

const ORIGIN = 'http://localhost:3000';

async function setup() {
  const db = await freshDb();
  const mailer = new MemoryMailer();
  const config = loadConfig({ APP_URL: ORIGIN });
  const app = createApp(() => ({ db, config, mailer, limiter: new RateLimiter(), kick: () => void dispatchPending(db, mailer) }));
  return { db, mailer, app };
}

/** Kleiner Browser-Ersatz mit Cookie-Speicher. */
function client(app: ReturnType<typeof createApp>) {
  let cookie = '';
  const req = async (path: string, init: { method?: string; form?: Record<string, string>; origin?: string | null } = {}) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    let body: string | undefined;
    if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    if (init.origin !== null && (init.method ?? 'GET') !== 'GET') headers.origin = init.origin ?? ORIGIN;
    const res = await app.request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers, body });
    const set = res.headers.get('set-cookie');
    if (set) {
      const m = /sw_session=([^;]*)/.exec(set);
      if (m) cookie = m[1] ? `sw_session=${m[1]}` : '';
    }
    return res;
  };
  return { req };
}

async function login(app: ReturnType<typeof createApp>, mailer: MemoryMailer, email: string, name = 'Testperson') {
  const c = client(app);
  const r1 = await c.req('/login', { method: 'POST', form: { email, mode: 'link' } });
  assert.equal(r1.status, 200);
  const mail = mailer.sent.at(-1)!;
  assert.equal(mail.to, email);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1];
  // GET verbraucht das Token nicht (Schutz vor Link-Vorschauen).
  assert.equal((await c.req(`/auth/verify?token=${token}`)).status, 200);
  const r2 = await c.req('/auth/verify', { method: 'POST', form: { token } });
  assert.equal(r2.status, 303);
  // Token ist nur einmal gültig.
  assert.equal((await c.req(`/auth/verify?token=${token}`)).status, 400);
  await c.req('/profile', { method: 'POST', form: { display_name: name } });
  return c;
}

test('Anmeldung per Link legt Konto an und schützt private Seiten', async () => {
  const { app, mailer } = await setup();
  const anon = client(app);
  const r = await anon.req('/dashboard');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location')!, /^\/login\?next=/);
  const c = await login(app, mailer, 'neu@example.com', 'Neu');
  const d = await c.req('/dashboard');
  assert.equal(d.status, 200);
  assert.match(await d.text(), /Hallo Neu/);
});

test('CSRF: Formular von fremder Herkunft wird abgewiesen', async () => {
  const { app } = await setup();
  const c = client(app);
  const r = await c.req('/login', { method: 'POST', form: { email: 'x@example.com' }, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('Fremder Arbeitsbereich ist per URL nicht erreichbar (404)', async () => {
  const { app, mailer, db } = await setup();
  const { wsId } = await setupWorkspace(db);
  const c = await login(app, mailer, 'fremd@example.com');
  for (const path of [`/w/${wsId}`, `/w/${wsId}/bookings`, `/w/${wsId}/members`, `/w/${wsId}/book`, `/w/${wsId}/slots`]) {
    assert.equal((await c.req(path)).status, 404, path);
  }
  assert.equal((await c.req(`/w/${wsId}/settings/delete`, { method: 'POST', form: { confirm_name: 'Testbereich' } })).status, 404);
});

test('Öffentliche Seite zeigt nur öffentliche freie Slots und keine Personendaten', async () => {
  const { app, mailer, db } = await setup();
  const { wsId, ws, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  await updateWorkspace(db, wsId, { name: ws.name, kind: 'personal', timezone: ws.timezone, description: '', publicEnabled: true });
  const off = (await getOffering(db, wsId, offeringId))!;
  const base = { kind: 'fixed' as const, durationMin: 60, bufferMin: 0, capacity: 1, location: null, onlineInfo: 'https://video.example/geheim', confirmationMode: null, status: 'published' as const, preference: 'normal' as const, visibility: 'inherit' as const, audience: { groupIds: [], membershipIds: [] } };
  const day = futureDate();
  const slotA = await createSlot(db, wsId, off, 'Europe/Berlin', day, '10:00', base);
  await createSlot(db, wsId, off, 'Europe/Berlin', day, '12:00', { ...base, visibility: 'internal' });
  const token = (await db.get<{ public_token: string }>(`SELECT public_token FROM workspaces WHERE id = ?`, [wsId]))!.public_token;

  const booker = await login(app, mailer, 'kunde@example.com', 'Kundin Geheim');
  const b = await booker.req(`/p/${token}/slots/${slotA}/book`, { method: 'POST', form: { note: '' } });
  assert.equal(b.status, 303);
  assert.match(b.headers.get('location')!, /booked_confirmed/);

  const anon = client(app);
  const page = await (await anon.req(`/p/${token}?view=list`)).text();
  assert.doesNotMatch(page, /Kundin Geheim|kunde@example\.com/);
  assert.doesNotMatch(page, /12:00/, 'interner Slot nicht öffentlich');
  assert.doesNotMatch(page, /10:00–11:00/, 'gebuchter Slot nicht mehr frei');
  assert.doesNotMatch(page, /video\.example/, 'Online-Info nur für Bestätigte');
  // Falscher Token → 404, deaktivierte Seite → 404.
  assert.equal((await anon.req('/p/falsch')).status, 404);
  await updateWorkspace(db, wsId, { name: ws.name, kind: 'personal', timezone: ws.timezone, description: '', publicEnabled: false });
  assert.equal((await anon.req(`/p/${token}`)).status, 404);
});

test('Einladung: Link allein reicht nicht, Annahme nur mit passender bestätigter Adresse', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'chefin@example.com', 'Chefin');
  const created = await owner.req('/workspaces', { method: 'POST', form: { name: 'Schule Nord', kind: 'organization', timezone: 'Europe/Berlin', description: '' } });
  const wsId = /\/w\/([^/]+)\//.exec(created.headers.get('location')!)![1];
  const inv = await owner.req(`/w/${wsId}/invitations`, { method: 'POST', form: { email: 'schueler@example.com', role: 'member', group_id: '', offering_id: '' } });
  assert.equal(inv.status, 200);
  const mail = mailer.sent.at(-1)!;
  assert.equal(mail.to, 'schueler@example.com');
  const link = /\/invite\/([A-Za-z0-9_-]+)/.exec(mail.text)![1];

  // Eine andere angemeldete Person kann die Einladung nicht annehmen.
  const other = await login(app, mailer, 'andere@example.com');
  await other.req(`/invite/${link}`, { method: 'POST' });
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?`, [wsId]))!.n, 1);

  const invitee = await login(app, mailer, 'schueler@example.com', 'Schüler');
  const acc = await invitee.req(`/invite/${link}`, { method: 'POST' });
  assert.equal(acc.status, 303);
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ?`, [wsId]))!.n, 2);
  // Mitglied ohne Verwaltungsrechte kommt nicht in die Verwaltung.
  assert.equal((await invitee.req(`/w/${wsId}/members`)).status, 404);
  assert.equal((await invitee.req(`/w/${wsId}/book`)).status, 200);
  // Einladungslink ist danach verbraucht.
  assert.equal((await invitee.req(`/invite/${link}`)).status, 404);
});

test('Ohne E-Mail-Versand wird kein Versand behauptet', async () => {
  const db = await freshDb();
  const config = loadConfig({ APP_URL: ORIGIN });
  const { createMailer } = await import('../src/mail/mailer.ts');
  const app = createApp(() => ({ db, config, mailer: createMailer(config), limiter: new RateLimiter(), kick: () => {} }));
  const c = client(app);
  const r = await c.req('/login', { method: 'POST', form: { email: 'a@example.com', mode: 'link' } });
  const text = await r.text();
  assert.match(text, /nicht eingerichtet/);
  assert.doesNotMatch(text, /Prüfe dein Postfach/);
});

test('Fehlgeschlagener Versand ändert den Buchungsstatus nicht', async () => {
  const { db, mailer } = await setup();
  const { wsId, offeringId } = await setupWorkspace(db, { confirmation_mode: 'auto' });
  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '10:00', { kind: 'fixed', durationMin: 60, bufferMin: 0, capacity: 1, location: null, onlineInfo: null, confirmationMode: null, status: 'published', preference: 'normal', visibility: 'inherit', audience: { groupIds: [], membershipIds: [] } });
  const { requestBooking } = await import('../src/services/bookings.ts');
  const { makeUser } = await import('./helpers.ts');
  const u = await makeUser(db, 'k@example.com');
  const r = await requestBooking(db, ORIGIN, { workspaceId: wsId, slotId, userId: u.id, membershipId: null, note: '' });
  assert.ok(r.ok);
  mailer.failNext = true;
  await dispatchPending(db, mailer);
  assert.equal((await db.get<{ status: string }>(`SELECT status FROM bookings WHERE id = ?`, [r.bookingId]))!.status, 'confirmed');
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'failed'`))!.n, 1);
});

test('Alle Verwaltungs- und Buchungsseiten laden ohne Fehler', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'chef@example.com', 'Chef');
  const created = await owner.req('/workspaces', { method: 'POST', form: { name: 'Bereich', kind: 'personal', timezone: 'Europe/Berlin', description: '' } });
  const wsId = /\/w\/([^/]+)\//.exec(created.headers.get('location')!)![1];
  const off = await owner.req(`/w/${wsId}/offerings`, {
    method: 'POST',
    form: { name: 'Beratung', duration_min: '45', buffer_min: '15', default_capacity: '1', confirmation_mode: 'manual', visibility: 'public', cancel_cutoff_hours: '24', min_notice_hours: '0' },
  });
  assert.equal(off.status, 303);
  const offeringId = /offerings\/([^?]+)/.exec(off.headers.get('location')!)![1];
  const day = futureDate(5);
  const single = await owner.req(`/w/${wsId}/slots`, { method: 'POST', form: { offering_id: offeringId, kind: 'window', date: day, time: '16:00', end_time: '19:00', status: 'published', visibility: 'inherit', capacity: '1' } });
  assert.equal(single.status, 303, 'Zeitfenster angelegt');
  const series = await owner.req(`/w/${wsId}/slots/series`, {
    method: 'POST',
    form: { offering_id: offeringId, kind: 'fixed', from: futureDate(8), to: futureDate(14), window_start: '09:00', window_end: '12:00', duration: '45', weekday: '1', status: 'published', visibility: 'inherit', capacity: '1' },
  });
  assert.equal(series.status, 303);
  assert.match(series.headers.get('location')!, /n=3/);
  const slotId = (await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? LIMIT 1`, [wsId]))!.id;
  const groupRes = await owner.req(`/w/${wsId}/groups`, { method: 'POST', form: { name: 'Kurs A' } });
  const groupPath = groupRes.headers.get('location')!.split('?')[0];
  const month = futureDate(5).slice(0, 7);
  for (const path of [
    `/w/${wsId}`,
    `/w/${wsId}/settings`,
    `/w/${wsId}/members`,
    `/w/${wsId}/groups`,
    groupPath,
    `/w/${wsId}/offerings`,
    `/w/${wsId}/offerings/new`,
    `/w/${wsId}/offerings/${offeringId}`,
    `/w/${wsId}/slots`,
    `/w/${wsId}/slots?view=calendar&month=${month}`,
    `/w/${wsId}/slots?view=calendar&day=${day}`,
    `/w/${wsId}/slots/new`,
    `/w/${wsId}/slots/${slotId}`,
    `/w/${wsId}/bookings`,
    `/w/${wsId}/bookings?status=awaiting_me`,
    `/w/${wsId}/notifications`,
    `/w/${wsId}/book`,
    `/w/${wsId}/book?view=calendar&month=${month}`,
    `/w/${wsId}/o/${offeringId}`,
    '/bookings',
    '/profile',
    '/profile/export',
    '/datenschutz',
  ]) {
    const r = await owner.req(path);
    assert.equal(r.status, 200, path);
  }
  // Wunschzeit im Zeitfenster buchen (eigenes Angebot, öffentlich).
  const book = await owner.req(`/w/${wsId}/slots/${(await db.get<{ id: string }>(`SELECT id FROM slots WHERE workspace_id = ? AND kind = 'window'`, [wsId]))!.id}/book`, { method: 'POST', form: { time: '16:45', note: '' } });
  assert.match(book.headers.get('location')!, /booked_requested/);
});

test('Plattform-Verwaltung nur für freigeschaltete Admin-Adressen', async () => {
  const db = await freshDb();
  const mailer = new MemoryMailer();
  const config = loadConfig({ APP_URL: ORIGIN, ADMIN_EMAILS: 'Chef@Example.com' });
  const app = createApp(() => ({ db, config, mailer, limiter: new RateLimiter(), kick: () => {} }));
  const other = await login(app, mailer, 'nutzer@example.com');
  assert.equal((await other.req('/admin')).status, 404);
  const admin = await login(app, mailer, 'chef@example.com', 'Chef');
  const page = await admin.req('/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Plattform-Verwaltung/);
  const t = await admin.req('/admin/test-mail', { method: 'POST' });
  assert.match(t.headers.get('location')!, /test=ok/);
  assert.equal(mailer.sent.at(-1)!.to, 'chef@example.com');
});

test('Passwort: nach E-Mail-Anmeldung festlegen, danach mit Passwort anmelden', async () => {
  const { app, mailer } = await setup();
  const c = await login(app, mailer, 'pw@example.com', 'Paula');
  // Zu kurz → abgelehnt
  const weak = await c.req('/profile/password', { method: 'POST', form: { new_password: 'kurz', new_password2: 'kurz' } });
  assert.match(weak.headers.get('location')!, /password_weak/);
  const ok = await c.req('/profile/password', { method: 'POST', form: { new_password: 'sehr-geheim-123', new_password2: 'sehr-geheim-123' } });
  assert.match(ok.headers.get('location')!, /password_saved/);

  const fresh = client(app);
  const wrong = await fresh.req('/login', { method: 'POST', form: { email: 'pw@example.com', password: 'falsch-falsch', mode: 'password' } });
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /stimmen nicht/);
  // Unbekanntes Konto: gleiche Meldung
  const unknown = await fresh.req('/login', { method: 'POST', form: { email: 'gibtsnicht@example.com', password: 'egal-egal-egal', mode: 'password' } });
  assert.match(await unknown.text(), /stimmen nicht/);
  const good = await fresh.req('/login', { method: 'POST', form: { email: 'PW@example.com', password: 'sehr-geheim-123', mode: 'password' } });
  assert.equal(good.status, 303);
  assert.equal((await fresh.req('/dashboard')).status, 200);
  // Ändern verlangt das aktuelle Passwort
  const noCurrent = await fresh.req('/profile/password', { method: 'POST', form: { current_password: 'falsch', new_password: 'neues-passwort-1', new_password2: 'neues-passwort-1' } });
  assert.match(noCurrent.headers.get('location')!, /password_wrong/);
});

test('Passwort: Sperre nach zu vielen Fehlversuchen', async () => {
  const { app, mailer } = await setup();
  const c = await login(app, mailer, 'lock@example.com');
  await c.req('/profile/password', { method: 'POST', form: { new_password: 'richtiges-pw-1', new_password2: 'richtiges-pw-1' } });
  const x = client(app);
  for (let i = 0; i < 8; i++) await x.req('/login', { method: 'POST', form: { email: 'lock@example.com', password: 'falsch-' + i, mode: 'password' } });
  const locked = await x.req('/login', { method: 'POST', form: { email: 'lock@example.com', password: 'richtiges-pw-1', mode: 'password' } });
  assert.match(await locked.text(), /gesperrt/);
});

test('Passwort vergessen: nach Anmeldelink neues Passwort ohne das alte setzen', async () => {
  const { app, mailer } = await setup();
  const c = await login(app, mailer, 'vergessen@example.com', 'Vergesslich');
  await c.req('/profile/password', { method: 'POST', form: { new_password: 'altes-passwort-1', new_password2: 'altes-passwort-1' } });
  // Neues Gerät: „Passwort vergessen?“ schickt einen Link, der zum Profil führt.
  const x = client(app);
  const r = await x.req('/login', { method: 'POST', form: { email: 'vergessen@example.com', mode: 'forgot' } });
  assert.equal(r.status, 200);
  const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.sent.at(-1)!.text)![1];
  const v = await x.req('/auth/verify', { method: 'POST', form: { token } });
  assert.equal(v.headers.get('location'), '/profile?reset=1');
  const page = await (await x.req('/profile?reset=1')).text();
  assert.doesNotMatch(page, /current_password/);
  const ok = await x.req('/profile/password', { method: 'POST', form: { new_password: 'neues-passwort-2', new_password2: 'neues-passwort-2' } });
  assert.match(ok.headers.get('location')!, /password_saved/);
  const y = client(app);
  const good = await y.req('/login', { method: 'POST', form: { email: 'vergessen@example.com', password: 'neues-passwort-2', mode: 'password' } });
  assert.equal(good.status, 303);
  // Mit Passwort angemeldet: Ändern braucht weiterhin das aktuelle Passwort.
  const no = await y.req('/profile/password', { method: 'POST', form: { new_password: 'drittes-passwort', new_password2: 'drittes-passwort' } });
  assert.match(no.headers.get('location')!, /password_wrong/);
});

test('Schülerübersicht: nur für Verwaltende, Abhaken, Preise, Zahlungen und CSV', async () => {
  const { app, mailer, db } = await setup();
  const owner = await login(app, mailer, 'lehrer@example.com', 'Lehrer');
  const wsId = /\/w\/([^/]+)\//.exec((await owner.req('/workspaces', { method: 'POST', form: { name: 'Musik', kind: 'personal', timezone: 'Europe/Berlin', description: '' } })).headers.get('location')!)![1];
  const off = await owner.req(`/w/${wsId}/offerings`, { method: 'POST', form: { name: 'Stunde', duration_min: '45', confirmation_mode: 'manual', visibility: 'internal' } });
  const offId = /offerings\/([^?]+)/.exec(off.headers.get('location')!)![1];
  const student = await login(app, mailer, 'kind@example.com', 'Kind');
  const studentId = (await db.get<{ id: string }>(`SELECT id FROM users WHERE email = 'kind@example.com'`))!.id;
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES ('m-kind', ?, ?, 'member', ?)`, [wsId, studentId, new Date().toISOString()]);
  // Mitglieder sehen die Abrechnung nicht.
  assert.equal((await student.req(`/w/${wsId}/students`)).status, 404);
  assert.equal((await student.req(`/w/${wsId}/students/export.csv`)).status, 404);

  // Standardpreis 40 € pro 60 Minuten → 45 Minuten = 30 €.
  await owner.req(`/w/${wsId}/students/settings`, { method: 'POST', form: { default_price: '40', price_unit: 'hour' } });
  assert.match((await owner.req(`/w/${wsId}/students/settings`, { method: 'POST', form: { default_price: 'abc', price_unit: 'hour' } })).headers.get('location')!, /money_invalid/);
  const add = async (date: string) =>
    owner.req(`/w/${wsId}/students/${studentId}/lessons`, { method: 'POST', form: { offering_id: offId, date, time: '15:00', duration: '' } });
  assert.match((await add('2026-01-05')).headers.get('location')!, /lesson_added/);
  assert.match((await add('2026-01-12')).headers.get('location')!, /lesson_added/);
  // Doppelt zur selben Zeit geht nicht.
  assert.doesNotMatch((await add('2026-01-12')).headers.get('location')!, /lesson_added/);

  const ids = (await db.all<{ id: string }>(`SELECT id FROM bookings WHERE user_id = ? ORDER BY starts_at`, [studentId])).map((r) => r.id);
  const page = await (await owner.req(`/w/${wsId}/students/${studentId}?month=2026-01`)).text();
  assert.match(page, /30,00/);
  const save = await owner.req(`/w/${wsId}/lessons`, {
    method: 'POST',
    form: { back: `/w/${wsId}/students/${studentId}?month=2026-01`, ids: ids[0], [`att_${ids[0]}`]: 'attended', [`price_${ids[0]}`]: '30,00', [`paid_${ids[0]}`]: '30' },
  });
  assert.match(save.headers.get('location')!, new RegExp(`/w/${wsId}/students/${studentId}\\?month=2026-01&msg=lessons_saved`));
  // Zweiten Termin per Sammelaktion abhaken; danach Preis erhöhen – der festgeschriebene Preis bleibt.
  const p2 = new URLSearchParams({ back: `/w/${wsId}/students`, bulk: 'attended' });
  p2.append('ids', ids[1]);
  await owner.req(`/w/${wsId}/lessons`, { method: 'POST', form: Object.fromEntries(p2) });
  await owner.req(`/w/${wsId}/students/${studentId}/rate`, { method: 'POST', form: { price: '80' } });
  const rows = await db.all<{ attendance: string; price_cents: number; paid_cents: number }>(`SELECT attendance, price_cents, paid_cents FROM bookings WHERE user_id = ? ORDER BY starts_at`, [studentId]);
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { attendance: 'attended', price_cents: 3000, paid_cents: 3000 },
    { attendance: 'attended', price_cents: 3000, paid_cents: 0 },
  ]);
  const overview = await (await owner.req(`/w/${wsId}/students?year=2026`)).text();
  assert.match(overview, /60,00\s*€/); // berechnet
  assert.match(overview, /individuell/);
  const csv = await (await owner.req(`/w/${wsId}/students/export.csv?month=2026-01`)).text();
  assert.match(csv, /2026-01-05;15:00;15:45;45;Kind;kind@example.com;Stunde;fest;Stattgefunden;30,00;30,00;30,00/);
  // Fremde Rücksprungziele werden ignoriert.
  const evil = await owner.req(`/w/${wsId}/lessons`, { method: 'POST', form: { back: 'https://evil.example/', ids: ids[1], [`att_${ids[1]}`]: 'attended', [`price_${ids[1]}`]: '30', [`paid_${ids[1]}`]: '' } });
  assert.match(evil.headers.get('location')!, new RegExp(`^/w/${wsId}/students\\?msg=`));
});
