// Rauchtest gegen einen laufenden Server (z. B. `npm run cf:dev` mit DEV_LOGIN_LINKS=1).
// Aufruf: node scripts/smoke.ts http://localhost:8788
const BASE = process.argv[2] ?? 'http://localhost:8788';

class Client {
  cookie = '';
  async req(path: string, form?: Record<string, string | string[]>) {
    const headers: Record<string, string> = { origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    let body: string | undefined;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      body = p.toString();
    }
    const res = await fetch(BASE + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    const m = set && /sw_session=([^;]*)/.exec(set);
    if (m) this.cookie = m[1] ? `sw_session=${m[1]}` : '';
    return res;
  }
  async login(email: string, name: string) {
    const html = await (await this.req('/login', { email, next: '' })).text();
    const token = /verify\?token=([A-Za-z0-9_-]+)/.exec(html)?.[1];
    if (!token) throw new Error('Kein Dev-Anmeldelink: ' + html.slice(0, 300));
    await this.req('/auth/verify', { token });
    await this.req('/profile', { display_name: name, notify_booking_updates: '1' });
  }
}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error('FEHLER: ' + msg);
  console.log('✔ ' + msg);
}

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const owner = new Client();
await owner.login(`chef-${Date.now()}@example.test`, 'Chefin Test');
const ws = await owner.req('/workspaces', { name: 'Rauchtest', kind: 'personal', timezone: 'Europe/Berlin', description: 'Test' });
const wsId = /\/w\/([^/]+)\//.exec(ws.headers.get('location') ?? '')?.[1];
check(wsId, 'Arbeitsbereich angelegt');
const off = await owner.req(`/w/${wsId}/offerings`, { name: 'Stunde', duration_min: '60', buffer_min: '0', default_capacity: '1', confirmation_mode: 'manual', visibility: 'public', cancel_cutoff_hours: '24', min_notice_hours: '0', allow_self_cancel: '1' });
const offId = /offerings\/([^?]+)/.exec(off.headers.get('location') ?? '')?.[1];
check(offId, 'Angebot angelegt');
const w = await owner.req(`/w/${wsId}/slots`, { offering_id: offId!, kind: 'window', date: day(3), time: '16:00', end_time: '19:00', status: 'published', visibility: 'inherit', capacity: '1', preference: 'normal' });
check(w.status === 303, 'Zeitfenster angelegt');
const f = await owner.req(`/w/${wsId}/slots`, { offering_id: offId!, kind: 'fixed', date: day(4), time: '10:00', duration: '60', status: 'published', visibility: 'inherit', capacity: '1', preference: 'reluctant' });
check(f.status === 303, 'Gelber Slot angelegt');
const ser = await owner.req(`/w/${wsId}/slots/series`, { offering_id: offId!, kind: 'fixed', from: day(7), to: day(13), window_start: '09:00', window_end: '11:00', duration: '60', weekday: ['1', '3'], status: 'published', visibility: 'inherit', capacity: '1', preference: 'normal' });
check(/n=4/.test(ser.headers.get('location') ?? ''), 'Serie mit 4 Slots angelegt');
await owner.req(`/w/${wsId}/settings`, { name: 'Rauchtest', kind: 'personal', timezone: 'Europe/Berlin', description: '', public_enabled: '1', show_booked_public: 'names', show_booked_members: 'names' });
const settings = await (await owner.req(`/w/${wsId}/settings`)).text();
const token = /\/p\/([A-Za-z0-9_-]+)/.exec(settings)?.[1];
check(token, 'Öffentlicher Link aktiv');

const kunde = new Client();
await kunde.login(`kunde-${Date.now()}@example.test`, 'Karla Kunde');
const pub = await (await kunde.req(`/p/${token}?view=week&week=${day(3)}`)).text();
check(pub.includes('Wunschzeit wählen') && pub.includes('ev-free'), 'Öffentliche Wochenansicht zeigt grünes Zeitfenster');
const winId = /\/slots\/([A-Za-z0-9_-]+)\/book/.exec(await (await kunde.req(`/p/${token}?day=${day(3)}`)).text())?.[1];
const b1 = await kunde.req(`/p/${token}/slots/${winId}/book`, { time: '16:45', note: 'Hallo' });
check(/booked_requested/.test(b1.headers.get('location') ?? ''), 'Wunschzeit 16:45 angefragt');

const bookings = await (await owner.req(`/w/${wsId}/bookings`)).text();
const bid = /id="b-([A-Za-z0-9_-]+)"/.exec(bookings)?.[1];
check(bid && bookings.includes('Karla Kunde'), 'Anbieter sieht Anfrage mit Namen');
const conf = await owner.req(`/w/${wsId}/bookings/${bid}/confirm`, {});
check(/msg=confirmed/.test(conf.headers.get('location') ?? ''), 'Anfrage bestätigt');
const prop = await owner.req(`/w/${wsId}/bookings/${bid}/propose`, { date: day(3), time: '17:30', duration: '60', note: '' });
check(/proposal_sent/.test(prop.headers.get('location') ?? ''), 'Verschiebung vorgeschlagen');
const acc = await kunde.req(`/bookings/${bid}/proposal`, { accept: '1' });
check(/proposal_accepted/.test(acc.headers.get('location') ?? ''), 'Kunde stimmt zu – Termin fest');

const anon = new Client();
const pubWeek = await (await anon.req(`/p/${token}?view=week&week=${day(3)}`)).text();
check(pubWeek.includes('ev-confirmed') && pubWeek.includes('Karla') && !pubWeek.includes('example.test'), 'Öffentlich: belegt mit Vorname, ohne E-Mail');
check(pubWeek.includes('ev-reluctant') || (await (await anon.req(`/p/${token}?view=week&week=${day(4)}`)).text()).includes('ev-reluctant'), 'Gelber Slot sichtbar');
const cal = await owner.req(`/w/${wsId}/calendar?week=${day(3)}`);
check(cal.status === 200 && (await cal.text()).includes('Karla Kunde'), 'Anbieter-Wochenkalender lädt');
for (const p of [`/w/${wsId}`, `/w/${wsId}/slots`, `/w/${wsId}/slots?view=calendar`, `/w/${wsId}/members`, `/w/${wsId}/offerings`, `/w/${wsId}/notifications`, '/impressum', '/datenschutz', '/bookings']) {
  const r = await owner.req(p);
  check(r.status === 200, `Seite ${p}`);
}
const css = await anon.req('/static/app.css');
check(css.status === 200, 'Statische Dateien');
console.log('\nRauchtest bestanden.');
