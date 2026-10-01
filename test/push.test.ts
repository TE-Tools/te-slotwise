import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestBooking, providerDecision } from '../src/services/bookings.ts';
import { dispatchPending } from '../src/services/notifications.ts';
import { getOffering } from '../src/services/offerings.ts';
import {
  b64u,
  encryptPayload,
  generateVapidKeys,
  hkdf,
  isAllowedEndpoint,
  MemoryPushSender,
  saveSubscription,
  unb64u,
  vapidAuthorization,
  WebPushSender,
} from '../src/services/push.ts';
import { createSlot } from '../src/services/slots.ts';
import { MemoryMailer } from '../src/mail/mailer.ts';
import { addMember, freshDb, futureDate, makeUser, setupWorkspace } from './helpers.ts';

const enc = new TextEncoder();

/** Entschlüsselt wie ein Browser (Empfängerseite von RFC 8291) – zur Gegenprobe. */
async function browserDecrypt(body: Uint8Array, uaKeys: { publicKey: CryptoKey; privateKey: CryptoKey }, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', uaKeys.publicKey));
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKeys.privateKey, 256));
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  assert.equal(plain.at(-1), 2, 'Begrenzer des letzten Datensatzes');
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function browserSubscription() {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  return { keys, auth, sub: { endpoint: `https://fcm.googleapis.com/fcm/send/${b64u(crypto.getRandomValues(new Uint8Array(8)))}`, p256dh, auth: b64u(auth) } };
}

test('Push-Nutzlast: Verschlüsselung lässt sich wie im Browser entschlüsseln', async () => {
  const { keys, auth, sub } = await browserSubscription();
  const body = await encryptPayload(enc.encode('{"title":"Hallo Ü"}'), sub.p256dh, sub.auth);
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(await browserDecrypt(body, keys, auth), '{"title":"Hallo Ü"}');
});

test('VAPID: gültige ES256-Signatur für den Push-Dienst', async () => {
  const keys = await generateVapidKeys();
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:test@example.com');
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
  assert.ok(m);
  const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:test@example.com');
  const pub = await crypto.subtle.importKey('raw', unb64u(m[4]), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(m[3]), enc.encode(`${m[1]}.${m[2]}`)));
});

test('Nur bekannte Push-Dienste sind erlaubt', () => {
  assert.ok(isAllowedEndpoint('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(isAllowedEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(isAllowedEndpoint('https://web.push.apple.com/abc'));
  assert.ok(isAllowedEndpoint('https://wns2-db5p.notify.windows.com/w/?token=x'));
  assert.ok(!isAllowedEndpoint('http://fcm.googleapis.com/x'));
  assert.ok(!isAllowedEndpoint('https://evil.example/fcm.googleapis.com'));
  assert.ok(!isAllowedEndpoint('https://fcm.googleapis.com.evil.example/x'));
  assert.ok(!isAllowedEndpoint('https://169.254.169.254/'));
});

test('VAPID-Schlüssel werden einmal erzeugt und wiederverwendet', async () => {
  const db = await freshDb();
  const a = await new WebPushSender(db, 'mailto:x@example.com').publicKey();
  const b = await new WebPushSender(db, 'mailto:x@example.com').publicKey();
  assert.equal(a, b);
  assert.equal(unb64u(a).length, 65);
});

test('Push: Anfrage an die Lehrkraft, Bestätigung an das Mitglied; E-Mail abbestellbar', async () => {
  const db = await freshDb();
  const mailer = new MemoryMailer();
  const push = new MemoryPushSender();
  const { owner, wsId, offeringId } = await setupWorkspace(db, { confirmation_mode: 'manual', visibility: 'internal' });
  const kid = await makeUser(db, 'kind@example.com', 'Kind');
  const mid = await addMember(db, wsId, kid.id);
  await saveSubscription(db, owner.id, { endpoint: 'https://fcm.googleapis.com/fcm/send/lehrer', p256dh: 'x', auth: 'y', label: 'Android · Chrome' });
  await saveSubscription(db, kid.id, { endpoint: 'https://web.push.apple.com/kind', p256dh: 'x', auth: 'y', label: 'iPhone/iPad · Safari' });
  // Das Kind möchte nur Push, keine E-Mails.
  await db.run(`UPDATE users SET notify_email = 0 WHERE id = ?`, [kid.id]);

  const off = (await getOffering(db, wsId, offeringId))!;
  const slotId = await createSlot(db, wsId, off, 'Europe/Berlin', futureDate(), '15:00', { kind: 'fixed', durationMin: 60, bufferMin: 0, capacity: 1, location: null, onlineInfo: null, confirmationMode: null, status: 'published', preference: 'normal', visibility: 'inherit', audience: { groupIds: [], membershipIds: [] } });
  const r = await requestBooking(db, 'http://localhost:3000', { workspaceId: wsId, slotId, userId: kid.id, membershipId: mid, note: '' });
  assert.ok(r.ok);
  await dispatchPending(db, mailer, { push });
  const toTeacher = push.sent.find((s) => s.endpoint.endsWith('/lehrer'));
  assert.ok(toTeacher, 'Lehrkraft bekommt Push bei neuer Anfrage');
  assert.match(toTeacher.msg.title, /Neue Anfrage/);
  assert.match(toTeacher.msg.body, /^Kind · Testbereich/);
  assert.equal(toTeacher.msg.url, `/w/${wsId}/bookings`);
  assert.ok(mailer.sent.some((m) => m.to === owner.email), 'Lehrkraft bekommt weiterhin auch E-Mail');

  push.sent = [];
  mailer.sent = [];
  assert.equal(await providerDecision(db, 'http://localhost:3000', wsId, r.ok ? r.bookingId : '', owner.id, 'confirm'), 'ok');
  await dispatchPending(db, mailer, { push });
  const toKid = push.sent.find((s) => s.endpoint.endsWith('/kind'));
  assert.ok(toKid, 'Mitglied bekommt Push bei Bestätigung');
  assert.match(toKid.msg.title, /Bestätigt/);
  assert.equal(toKid.msg.url, '/bookings');
  assert.ok(!mailer.sent.some((m) => m.to === 'kind@example.com'), 'keine E-Mail, wenn nur Push gewünscht');

  // Abgelaufenes Abo wird entfernt.
  push.result = 'gone';
  push.sent = [];
  await providerDecision(db, 'http://localhost:3000', wsId, r.ok ? r.bookingId : '', owner.id, 'cancel');
  await dispatchPending(db, mailer, { push });
  assert.equal((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?`, [kid.id]))!.n, 0);
});

test('Push-Verschlüsselung entspricht dem Beispiel aus RFC 8291 (Anhang A)', async () => {
  const asPublic = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const asPrivate = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
  const pub = unb64u(asPublic);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: asPrivate, ext: true };
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = await crypto.subtle.importKey('raw', pub, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const body = await encryptPayload(
    enc.encode('When I grow up, I want to be a watermelon'),
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    'BTBZMqHH6r4Tts7J_aSIgg',
    unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    { publicKey, privateKey },
  );
  assert.equal(
    b64u(body),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
});
