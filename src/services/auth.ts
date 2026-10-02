import type { Db } from '../db.ts';
import { hashToken, newId, newToken, nowIso } from '../ids.ts';
import { hashPassword, verifyPassword } from '../password.ts';

export interface User {
  id: string;
  email: string;
  /** Vor- und Nachname; display_name = beides zusammen (für Listen, Mails, Abrechnung). */
  first_name: string;
  last_name: string;
  display_name: string;
  email_verified_at: string | null;
  notify_booking_updates: number;
  notify_new_requests: number;
  /** student = bucht nur; teacher = darf Arbeitsbereiche anlegen und sieht die Verwaltung */
  account_type: AccountType;
  /** 0 = keine E-Mails, solange Push auf einem Gerät aktiv ist */
  notify_email: number;
  /** Gesetzt, wenn die Person ein Passwort festgelegt hat (nie an den Browser geben). */
  password_hash: string | null;
  created_at: string;
  /** Die aktuelle Sitzung entstand vor Kurzem per E-Mail-Link (erlaubt „Passwort vergessen“). */
  recent_link_login?: boolean;
}

export type AccountType = 'student' | 'teacher';
export const isTeacher = (u: { account_type?: string } | null | undefined) => u?.account_type === 'teacher';

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const SESSION_COOKIE = 'sw_session';
/** So lange nach einer Anmeldung per E-Mail-Link darf ein neues Passwort ohne das alte gesetzt werden. */
export const PASSWORD_RESET_WINDOW_MS = 30 * 60_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** Legt ein einmal verwendbares Anmeldetoken an. Gibt das Klartext-Token zurück (nur für den Link). */
export async function createLoginToken(db: Db, email: string, nextPath: string | null, now = Date.now(), ttlMs = LOGIN_TOKEN_TTL_MS) {
  const token = newToken();
  await db.run(
    `INSERT INTO login_tokens (id, token_hash, email, next_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), hashToken(token), email, nextPath, nowIso(now), nowIso(now + ttlMs)],
  );
  return token;
}

export async function recentLoginTokenCount(db: Db, email: string, sinceMs: number) {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?`, [email, nowIso(sinceMs)]))!.n;
}

/** Prüft ein Anmeldetoken ohne es zu verbrauchen (für die Bestätigungsseite). */
export async function peekLoginToken(db: Db, token: string, now = Date.now()) {
  return await db.get<{ id: string; email: string; next_path: string | null }>(
    `SELECT id, email, next_path FROM login_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
    [hashToken(token), nowIso(now)],
  );
}

/**
 * Verbraucht ein Anmeldetoken: legt bei Bedarf das Konto an (Registrierung), markiert die
 * E-Mail-Adresse als bestätigt und erzeugt eine Sitzung.
 */
export async function consumeLoginToken(db: Db, token: string, now = Date.now()) {
  return await db.tx(async () => {
    const row = await peekLoginToken(db, token, now);
    if (!row) return null;
    const changed = await db.run(`UPDATE login_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`, [nowIso(now), row.id]);
    if (!changed) return null;
    // Links gibt es nur noch für bestehende Konten (Registrierung bestätigen, Passwort zurücksetzen).
    const user = await db.get<User>(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, [row.email]);
    if (!user) return null;
    if (!user.email_verified_at) {
      await db.run(`UPDATE users SET email_verified_at = ? WHERE id = ?`, [nowIso(now), user.id]);
    }
    const session = await createSession(db, user.id, now, true);
    return { user, sessionToken: session, nextPath: row.next_path };
  });
}

export async function createSession(db: Db, userId: string, now = Date.now(), viaLink = false) {
  const token = newToken();
  await db.run(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, via_link) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    newId(),
    hashToken(token),
    userId,
    nowIso(now),
    nowIso(now + SESSION_TTL_MS),
    nowIso(now),
    viaLink ? 1 : 0,
  ]);
  return token;
}

export async function userForSession(db: Db, token: string | undefined, now = Date.now()): Promise<User | null> {
  if (!token || token.length > 100) return null;
  const row = await db.get<User & { session_id: string; last_seen_at: string; session_created_at: string; via_link: number }>(
    `SELECT u.*, s.id AS session_id, s.last_seen_at, s.created_at AS session_created_at, s.via_link FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`,
    [hashToken(token), nowIso(now)],
  );
  if (!row) return null;
  // Gleitende Verlängerung höchstens einmal pro Stunde, um Schreibzugriffe zu sparen.
  if (now - Date.parse(row.last_seen_at) > 3600_000) {
    await db.run(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, [nowIso(now), nowIso(now + SESSION_TTL_MS), row.session_id]);
  }
  const { session_id: _s, last_seen_at: _l, session_created_at: created, via_link: viaLink, ...user } = row;
  return { ...user, recent_link_login: !!viaLink && now - Date.parse(created) < PASSWORD_RESET_WINDOW_MS };
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.run(`DELETE FROM sessions WHERE token_hash = ?`, [hashToken(token)]);
}

export const MAX_FAILED_LOGINS = 8;
export const LOCK_MS = 15 * 60_000;

export type PasswordLogin = { ok: true; user: User; sessionToken: string } | { ok: false; reason: 'invalid' | 'locked' | 'unverified' };

/**
 * Anmeldung mit E-Mail und Passwort. Nur für Konten mit bestätigter Adresse und gesetztem Passwort.
 * Nach mehreren Fehlversuchen wird das Konto kurz gesperrt. Die Meldung verrät nicht, ob es das Konto gibt.
 */
export async function loginWithPassword(db: Db, email: string, password: string, now = Date.now()): Promise<PasswordLogin> {
  const check = await checkPassword(db, email, password, now);
  if (!check.ok) return check;
  return { ok: true, user: check.user, sessionToken: await createSession(db, check.user.id, now) };
}

/**
 * Prüft E-Mail und Passwort (mit Sperre nach Fehlversuchen), ohne eine Sitzung anzulegen.
 * „unverified“ kommt nur bei richtigem Passwort – sonst verrät die Antwort nichts über das Konto.
 */
export async function checkPassword(db: Db, email: string, password: string, now = Date.now()): Promise<{ ok: true; user: User } | { ok: false; reason: 'invalid' | 'locked' | 'unverified' }> {
  const user = await db.get<User & { failed_logins: number; locked_until: string | null }>(
    `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`,
    [email],
  );
  if (user?.locked_until && Date.parse(user.locked_until) > now) return { ok: false, reason: 'locked' };
  const ok = await verifyPassword(password, user?.password_hash);
  if (!user || !ok) {
    if (user) {
      const failed = user.failed_logins + 1;
      await db.run(`UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`, [
        failed >= MAX_FAILED_LOGINS ? 0 : failed,
        failed >= MAX_FAILED_LOGINS ? nowIso(now + LOCK_MS) : null,
        user.id,
      ]);
    }
    return { ok: false, reason: 'invalid' };
  }
  await db.run(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`, [user.id]);
  if (!user.email_verified_at) return { ok: false, reason: 'unverified' };
  return { ok: true, user };
}

export type RegisterResult = 'created' | 'pending' | 'exists';

/**
 * Registrierung mit Vorname, Nachname, E-Mail und Passwort. Das Konto ist erst nach dem Klick auf den
 * Bestätigungslink nutzbar. Ein noch nicht bestätigtes Konto wird mit den neuen Angaben überschrieben
 * (z. B. bei Tippfehler im Passwort); ein bestätigtes bleibt unangetastet.
 */
export async function registerUser(db: Db, p: { email: string; firstName: string; lastName: string; password: string }, now = Date.now()): Promise<RegisterResult> {
  const existing = await db.get<{ id: string; email_verified_at: string | null }>(`SELECT id, email_verified_at FROM users WHERE email = ? AND deleted_at IS NULL`, [p.email]);
  if (existing?.email_verified_at) return 'exists';
  const hash = await hashPassword(p.password);
  const name = fullName(p.firstName, p.lastName);
  if (existing) {
    await db.run(
      `UPDATE users SET first_name = ?, last_name = ?, display_name = ?, password_hash = ?, password_updated_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`,
      [p.firstName, p.lastName, name, hash, nowIso(now), existing.id],
    );
    return 'pending';
  }
  await db.run(
    `INSERT INTO users (id, email, first_name, last_name, display_name, password_hash, password_updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), p.email, p.firstName, p.lastName, name, hash, nowIso(now), nowIso(now)],
  );
  return 'created';
}

export const fullName = (first: string, last: string) => `${first} ${last}`.trim();

export async function userByEmail(db: Db, email: string) {
  return await db.get<User>(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, [email]);
}

/**
 * Kontoart umstellen. Zurück zu Schüler:in geht nur, wenn die Person keinen Arbeitsbereich mehr
 * besitzt – sonst wären dessen Verwaltung und Buchungen plötzlich unsichtbar.
 */
export async function setAccountType(db: Db, userId: string, type: AccountType): Promise<'ok' | 'owns_workspaces'> {
  if (type === 'student') {
    const owns = (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND role = 'owner'`, [userId]))!.n;
    if (owns) return 'owns_workspaces';
  }
  await db.run(`UPDATE users SET account_type = ? WHERE id = ?`, [type, userId]);
  return 'ok';
}

// ---------- Zugänge für andere Apps (Familienplaner usw.) ----------

export const API_TOKEN_TTL_MS = 180 * 24 * 3600_000;

export async function createApiToken(db: Db, userId: string, label: string, now = Date.now()) {
  const token = newToken();
  await db.run(`INSERT INTO api_tokens (id, token_hash, user_id, label, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    newId(),
    hashToken(token),
    userId,
    label.slice(0, 80),
    nowIso(now),
    nowIso(now),
    nowIso(now + API_TOKEN_TTL_MS),
  ]);
  return token;
}

/** Person zu einem App-Token; die Gültigkeit verlängert sich bei Nutzung (höchstens einmal pro Stunde geschrieben). */
export async function userForApiToken(db: Db, token: string, now = Date.now()) {
  if (!token || token.length > 100) return null;
  const row = await db.get<User & { token_id: string; last_used_at: string }>(
    `SELECT u.*, t.id AS token_id, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.expires_at > ? AND u.deleted_at IS NULL AND u.email_verified_at IS NOT NULL`,
    [hashToken(token), nowIso(now)],
  );
  if (!row) return null;
  if (now - Date.parse(row.last_used_at) > 3600_000) {
    await db.run(`UPDATE api_tokens SET last_used_at = ?, expires_at = ? WHERE id = ?`, [nowIso(now), nowIso(now + API_TOKEN_TTL_MS), row.token_id]);
  }
  const { token_id: _t, last_used_at: _l, ...user } = row;
  return user as User;
}

export async function revokeApiToken(db: Db, userId: string, idOrToken: string) {
  return await db.run(`DELETE FROM api_tokens WHERE user_id = ? AND (id = ? OR token_hash = ?)`, [userId, idOrToken, hashToken(idOrToken)]);
}

export async function listApiTokens(db: Db, userId: string) {
  return await db.all<{ id: string; label: string; created_at: string; last_used_at: string }>(
    `SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC`,
    [userId, nowIso()],
  );
}

// ---------- Kalender-Abo ----------

/** Geheimer Kalender-Link der Person; wird beim ersten Bedarf angelegt. */
export async function calendarToken(db: Db, userId: string, rotate = false) {
  if (!rotate) {
    const row = await db.get<{ calendar_token: string | null }>(`SELECT calendar_token FROM users WHERE id = ?`, [userId]);
    if (row?.calendar_token) return row.calendar_token;
  }
  const token = newToken();
  await db.run(`UPDATE users SET calendar_token = ? WHERE id = ?`, [token, userId]);
  return token;
}

export async function userForCalendarToken(db: Db, token: string) {
  if (!token || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return undefined;
  return await db.get<User>(`SELECT * FROM users WHERE calendar_token = ? AND deleted_at IS NULL`, [token]);
}

/** Passwort setzen oder ändern. Alle anderen Sitzungen werden dabei abgemeldet. */
export async function setPassword(db: Db, userId: string, password: string, keepSessionToken?: string) {
  await db.run(`UPDATE users SET password_hash = ?, password_updated_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?`, [
    await hashPassword(password),
    nowIso(),
    userId,
  ]);
  await db.run(`DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?`, [userId, keepSessionToken ? hashToken(keepSessionToken) : '']);
}

export async function removePassword(db: Db, userId: string) {
  await db.run(`UPDATE users SET password_hash = NULL, password_updated_at = ? WHERE id = ?`, [nowIso(), userId]);
}

/** Entfernt abgelaufene Sitzungen und Anmeldetokens (Datensparsamkeit). */
export async function purgeExpired(db: Db, now = Date.now()) {
  await db.run(`DELETE FROM sessions WHERE expires_at < ?`, [nowIso(now)]);
  await db.run(`DELETE FROM login_tokens WHERE expires_at < ?`, [nowIso(now - 24 * 3600_000)]);
}

export async function updateProfile(db: Db, userId: string, p: { firstName: string; lastName: string; notifyBookingUpdates: boolean; notifyNewRequests: boolean; notifyEmail: boolean }) {
  await db.run(`UPDATE users SET first_name = ?, last_name = ?, display_name = ?, notify_booking_updates = ?, notify_new_requests = ?, notify_email = ? WHERE id = ?`, [
    p.firstName,
    p.lastName,
    fullName(p.firstName, p.lastName),
    p.notifyBookingUpdates ? 1 : 0,
    p.notifyNewRequests ? 1 : 0,
    p.notifyEmail ? 1 : 0,
    userId,
  ]);
}

export async function exportUserData(db: Db, userId: string) {
  const user = await db.get(`SELECT id, email, first_name, last_name, display_name, email_verified_at, notify_booking_updates, notify_new_requests, notify_email, created_at FROM users WHERE id = ?`, [userId]);
  const memberships = await db.all(
    `SELECT w.name AS workspace, m.role, m.created_at FROM memberships m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ?`,
    [userId],
  );
  const groups = await db.all(
    `SELECT w.name AS workspace, g.name AS "group" FROM group_members gm
     JOIN memberships m ON m.id = gm.membership_id JOIN ws_groups g ON g.id = gm.group_id
     JOIN workspaces w ON w.id = g.workspace_id WHERE m.user_id = ?`,
    [userId],
  );
  const bookings = await db.all(
    `SELECT w.name AS workspace, o.name AS offering, b.starts_at, b.ends_at, s.timezone, b.status, b.note, b.created_at,
       b.attendance, b.price_cents, b.paid_cents, b.paid_at
     FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN offerings o ON o.id = b.offering_id
     JOIN workspaces w ON w.id = b.workspace_id WHERE b.user_id = ? ORDER BY b.starts_at`,
    [userId],
  );
  const pushDevices = await db.all(`SELECT label, created_at, last_success_at FROM push_subscriptions WHERE user_id = ?`, [userId]);
  return { exportedAt: nowIso(), user, memberships, groups, bookings, pushDevices };
}

/** Konten löschen: Nur möglich, wenn die Person keinen Arbeitsbereich allein besitzt. */
export async function deleteAccount(db: Db, userId: string): Promise<{ ok: true } | { ok: false; reason: 'sole_owner' }> {
  return await db.tx(async () => {
    const soleOwned = (await db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM memberships m WHERE m.user_id = ? AND m.role = 'owner'
       AND NOT EXISTS (SELECT 1 FROM memberships o WHERE o.workspace_id = m.workspace_id AND o.role = 'owner' AND o.user_id <> m.user_id)`,
      [userId],
    ))!.n;
    if (soleOwned > 0) return { ok: false as const, reason: 'sole_owner' as const };
    const now = nowIso();
    // Zukünftige aktive Buchungen werden abgesagt, damit Plätze frei werden.
    const active = await db.all<{ id: string; workspace_id: string; status: string }>(
      `SELECT b.id, b.workspace_id, b.status FROM bookings b
       WHERE b.user_id = ? AND b.status IN ('requested', 'confirmed') AND b.starts_at > ?`,
      [userId, now],
    );
    for (const b of active) {
      const to = b.status === 'requested' ? 'withdrawn' : 'cancelled';
      await db.run(`UPDATE bookings SET status = ?, updated_at = ? WHERE id = ?`, [to, now, b.id]);
      await db.run(
        `INSERT INTO booking_events (id, booking_id, workspace_id, from_status, to_status, actor_user_id, note, created_at) VALUES (?, ?, ?, ?, ?, NULL, 'Konto gelöscht', ?)`,
        [newId(), b.id, b.workspace_id, b.status, to, now],
      );
    }
    await db.run(`DELETE FROM memberships WHERE user_id = ?`, [userId]);
    await db.run(`DELETE FROM sessions WHERE user_id = ?`, [userId]);
    await db.run(`DELETE FROM push_subscriptions WHERE user_id = ?`, [userId]);
    await db.run(`DELETE FROM api_tokens WHERE user_id = ?`, [userId]);
    await db.run(`UPDATE notifications SET recipient_email = '', payload = '{}' WHERE recipient_user_id = ?`, [userId]);
    // Vergangene Buchungen bleiben für die Anbieter erhalten, aber ohne personenbezogene Daten.
    await db.run(
      `UPDATE users SET email = ?, display_name = 'Gelöschtes Konto', first_name = 'Gelöschtes', last_name = 'Konto', password_hash = NULL, calendar_token = NULL, deleted_at = ? WHERE id = ?`,
      [`deleted-${userId}@invalid`, now, userId],
    );
    return { ok: true as const };
  });
}
