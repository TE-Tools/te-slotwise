import type { Db } from '../db.ts';
import { hashToken, newId, newToken, nowIso } from '../ids.ts';

export interface User {
  id: string;
  email: string;
  display_name: string;
  email_verified_at: string | null;
  notify_booking_updates: number;
  notify_new_requests: number;
  created_at: string;
}

export const LOGIN_TOKEN_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const SESSION_COOKIE = 'sw_session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

/** Legt ein einmal verwendbares Anmeldetoken an. Gibt das Klartext-Token zurück (nur für den Link). */
export async function createLoginToken(db: Db, email: string, nextPath: string | null, now = Date.now()) {
  const token = newToken();
  await db.run(
    `INSERT INTO login_tokens (id, token_hash, email, next_path, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [newId(), hashToken(token), email, nextPath, nowIso(now), nowIso(now + LOGIN_TOKEN_TTL_MS)],
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
    let user = await db.get<User>(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, [row.email]);
    if (!user) {
      const id = newId();
      await db.run(`INSERT INTO users (id, email, email_verified_at, created_at) VALUES (?, ?, ?, ?)`, [id, row.email, nowIso(now), nowIso(now)]);
      user = (await db.get<User>(`SELECT * FROM users WHERE id = ?`, [id]))!;
    } else if (!user.email_verified_at) {
      await db.run(`UPDATE users SET email_verified_at = ? WHERE id = ?`, [nowIso(now), user.id]);
    }
    const session = await createSession(db, user.id, now);
    return { user, sessionToken: session, nextPath: row.next_path };
  });
}

export async function createSession(db: Db, userId: string, now = Date.now()) {
  const token = newToken();
  await db.run(`INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`, [
    newId(),
    hashToken(token),
    userId,
    nowIso(now),
    nowIso(now + SESSION_TTL_MS),
    nowIso(now),
  ]);
  return token;
}

export async function userForSession(db: Db, token: string | undefined, now = Date.now()): Promise<User | null> {
  if (!token || token.length > 100) return null;
  const row = await db.get<User & { session_id: string; last_seen_at: string }>(
    `SELECT u.*, s.id AS session_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL`,
    [hashToken(token), nowIso(now)],
  );
  if (!row) return null;
  // Gleitende Verlängerung höchstens einmal pro Stunde, um Schreibzugriffe zu sparen.
  if (now - Date.parse(row.last_seen_at) > 3600_000) {
    await db.run(`UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?`, [nowIso(now), nowIso(now + SESSION_TTL_MS), row.session_id]);
  }
  const { session_id: _s, last_seen_at: _l, ...user } = row;
  return user;
}

export async function destroySession(db: Db, token: string | undefined) {
  if (token) await db.run(`DELETE FROM sessions WHERE token_hash = ?`, [hashToken(token)]);
}

/** Entfernt abgelaufene Sitzungen und Anmeldetokens (Datensparsamkeit). */
export async function purgeExpired(db: Db, now = Date.now()) {
  await db.run(`DELETE FROM sessions WHERE expires_at < ?`, [nowIso(now)]);
  await db.run(`DELETE FROM login_tokens WHERE expires_at < ?`, [nowIso(now - 24 * 3600_000)]);
}

export async function updateProfile(db: Db, userId: string, p: { displayName: string; notifyBookingUpdates: boolean; notifyNewRequests: boolean }) {
  await db.run(`UPDATE users SET display_name = ?, notify_booking_updates = ?, notify_new_requests = ? WHERE id = ?`, [
    p.displayName,
    p.notifyBookingUpdates ? 1 : 0,
    p.notifyNewRequests ? 1 : 0,
    userId,
  ]);
}

export async function exportUserData(db: Db, userId: string) {
  const user = await db.get(`SELECT id, email, display_name, email_verified_at, notify_booking_updates, notify_new_requests, created_at FROM users WHERE id = ?`, [userId]);
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
    `SELECT w.name AS workspace, o.name AS offering, b.starts_at, b.ends_at, s.timezone, b.status, b.note, b.created_at
     FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN offerings o ON o.id = b.offering_id
     JOIN workspaces w ON w.id = b.workspace_id WHERE b.user_id = ? ORDER BY b.starts_at`,
    [userId],
  );
  return { exportedAt: nowIso(), user, memberships, groups, bookings };
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
    await db.run(`UPDATE notifications SET recipient_email = '', payload = '{}' WHERE recipient_user_id = ?`, [userId]);
    // Vergangene Buchungen bleiben für die Anbieter erhalten, aber ohne personenbezogene Daten.
    await db.run(`UPDATE users SET email = ?, display_name = 'Gelöschtes Konto', deleted_at = ? WHERE id = ?`, [`deleted-${userId}@invalid`, now, userId]);
    return { ok: true as const };
  });
}
