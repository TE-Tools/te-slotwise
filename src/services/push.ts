import type { Db } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

// Web-Push (RFC 8030) mit VAPID (RFC 8292) und verschlüsselter Nutzlast (RFC 8291, aes128gcm).
// Nur Web-Crypto – läuft unter Node und auf Cloudflare ohne zusätzliche Bibliothek.
// Die VAPID-Schlüssel werden beim ersten Bedarf erzeugt und in app_settings gespeichert,
// es sei denn, VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY sind gesetzt.

export interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: string;
  last_success_at: string | null;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Seite, die beim Antippen geöffnet wird (gleiche Herkunft). */
  url: string;
  /** Gleiche Kennung ersetzt eine ältere Benachrichtigung. */
  tag?: string;
}

/** Ergebnis pro Gerät: zugestellt, Abo ungültig (wird gelöscht) oder Fehler. */
export type PushResult = 'ok' | 'gone' | 'error';

export interface PushSender {
  /** Liefert den öffentlichen Schlüssel für pushManager.subscribe (base64url). */
  publicKey(): Promise<string>;
  send(sub: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>, msg: PushMessage): Promise<PushResult>;
}

// ---------- base64url ----------

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, info: info as Uint8Array<ArrayBuffer> }, key, bytes * 8),
  );
}

// ---------- Schlüssel ----------

export interface VapidKeys {
  publicKey: string; // unkomprimierter P-256-Punkt, base64url (65 Byte)
  privateJwk: Record<string, unknown>;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as { publicKey: CryptoKey; privateKey: CryptoKey };
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: b64u(raw), privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as Record<string, unknown> };
}

/** JWK aus öffentlichem Punkt (65 Byte) und privatem Skalar d (base64url). */
function jwkFrom(publicKey: string, d: string): Record<string, unknown> {
  const pub = unb64u(publicKey);
  return { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d, ext: true };
}

async function loadVapidKeys(db: Db, env: { publicKey?: string; privateKey?: string }): Promise<VapidKeys> {
  if (env.publicKey && env.privateKey) return { publicKey: env.publicKey, privateJwk: jwkFrom(env.publicKey, env.privateKey) };
  const row = await db.get<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'vapid'`);
  if (row) return JSON.parse(row.value) as VapidKeys;
  // Bei gleichzeitigen Anfragen gewinnt der erste Eintrag; danach lesen alle denselben.
  await db.run(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('vapid', ?)`, [JSON.stringify(await generateVapidKeys())]);
  return JSON.parse((await db.get<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'vapid'`))!.value) as VapidKeys;
}

// ---------- VAPID-Anmeldung ----------

export async function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk as never, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // Web-Crypto liefert die Signatur bereits als r||s (64 Byte), wie JWS es verlangt.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

// ---------- Verschlüsselung (RFC 8291) ----------

export async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
  salt = crypto.getRandomValues(new Uint8Array(16)),
  /** nur für Tests mit festen Werten (RFC 8291, Anhang A) */
  localKeys?: { publicKey: CryptoKey; privateKey: CryptoKey },
) {
  const uaPublic = unb64u(p256dh);
  const auth = unb64u(authSecret);
  if (uaPublic.length !== 65 || auth.length < 16) throw new Error('Ungültiges Push-Abo');
  const local = localKeys ?? ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as { publicKey: CryptoKey; privateKey: CryptoKey });
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // Ein einziger Datensatz: Klartext + Begrenzer 0x02.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// ---------- Zulässige Push-Dienste ----------

// Nur bekannte Push-Dienste der Browser – der Server schickt sonst keine Anfragen an beliebige Adressen.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];

export function isAllowedEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && endpoint.length <= 1000 && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

// ---------- Versand ----------

export class WebPushSender implements PushSender {
  private keys: Promise<VapidKeys> | null = null;
  private db: Db;
  private subject: string;
  private env: { publicKey?: string; privateKey?: string };
  constructor(db: Db, subject: string, env: { publicKey?: string; privateKey?: string } = {}) {
    this.db = db;
    this.subject = subject;
    this.env = env;
  }

  private vapid() {
    this.keys ??= loadVapidKeys(this.db, this.env).catch((e) => {
      this.keys = null;
      throw e;
    });
    return this.keys;
  }

  async publicKey() {
    return (await this.vapid()).publicKey;
  }

  async send(sub: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>, msg: PushMessage): Promise<PushResult> {
    if (!isAllowedEndpoint(sub.endpoint)) return 'gone';
    const keys = await this.vapid();
    const body = await encryptPayload(enc.encode(JSON.stringify(msg)), sub.p256dh, sub.auth);
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, keys, this.subject),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(3 * 24 * 3600),
        Urgency: 'high',
        ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body,
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) {
      console.error(`[Push] ${new URL(sub.endpoint).host}: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return 'error';
    }
    return 'ok';
  }
}

/** Für Tests und Umgebungen ohne Push: merkt sich nur, was gesendet worden wäre. */
export class MemoryPushSender implements PushSender {
  sent: { endpoint: string; msg: PushMessage }[] = [];
  result: PushResult = 'ok';
  async publicKey() {
    return 'BMemoryTestKey';
  }
  async send(sub: { endpoint: string }, msg: PushMessage) {
    this.sent.push({ endpoint: sub.endpoint, msg });
    return this.result;
  }
}

// ---------- Abos ----------

/** Grobe Gerätebezeichnung aus dem User-Agent – nur zur Anzeige in der eigenen Geräteliste. */
export function deviceLabel(ua: string) {
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Gerät';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

export async function saveSubscription(db: Db, userId: string, s: { endpoint: string; p256dh: string; auth: string; label: string }) {
  // Ein Gerät gehört immer der zuletzt angemeldeten Person.
  await db.run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, failures = 0`,
    [newId(), userId, s.endpoint, s.p256dh, s.auth, s.label.slice(0, 80), nowIso()],
  );
}

export async function deleteSubscription(db: Db, userId: string, endpointOrId: string) {
  return await db.run(`DELETE FROM push_subscriptions WHERE user_id = ? AND (endpoint = ? OR id = ?)`, [userId, endpointOrId, endpointOrId]);
}

export async function listSubscriptions(db: Db, userId: string) {
  return await db.all<PushSubscriptionRow>(`SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC`, [userId]);
}

/**
 * Sendet an alle Geräte einer Person. Ungültige Abos werden gelöscht, Geräte mit vielen Fehlern
 * ebenfalls. Liefert die Zahl erfolgreich erreichter Geräte und ob es überhaupt Geräte gab.
 */
export async function pushToUser(db: Db, sender: PushSender, userId: string, msg: PushMessage) {
  const subs = await listSubscriptions(db, userId);
  let delivered = 0;
  const errors: string[] = [];
  for (const s of subs) {
    let r: PushResult;
    try {
      r = await sender.send(s, msg);
    } catch (e) {
      console.error('[Push]', e);
      r = 'error';
    }
    if (r === 'ok') {
      delivered++;
      await db.run(`UPDATE push_subscriptions SET last_success_at = ?, failures = 0 WHERE id = ?`, [nowIso(), s.id]);
    } else if (r === 'gone') {
      await db.run(`DELETE FROM push_subscriptions WHERE id = ?`, [s.id]);
    } else {
      errors.push(s.label || 'Gerät');
      await db.run(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?`, [s.id]);
      await db.run(`DELETE FROM push_subscriptions WHERE id = ? AND failures >= 20`, [s.id]);
    }
  }
  return { devices: subs.length, delivered, errors };
}
