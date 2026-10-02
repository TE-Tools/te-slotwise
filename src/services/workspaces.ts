import type { Role } from '../authz.ts';
import type { Db } from '../db.ts';
import { hashToken, newId, newToken, nowIso } from '../ids.ts';
import { isOfflineEmail, OFFLINE_DOMAIN } from '../offline.ts';

export interface Workspace {
  id: string;
  name: string;
  kind: 'personal' | 'organization';
  description: string;
  timezone: string;
  public_enabled: number;
  public_token: string;
  show_booked_public: BookedDisplay;
  show_booked_members: BookedDisplay;
  /** Standardpreis in Cent (NULL = nicht festgelegt), siehe services/billing.ts. */
  default_price_cents: number | null;
  price_unit: 'lesson' | 'hour';
  created_at: string;
}

/** Anzeige belegter Termine für andere: gar nicht, anonym ("Belegt") oder mit Vornamen. */
export type BookedDisplay = 'hidden' | 'anonymous' | 'names';

export interface Membership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
}

export interface Group {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
}

export const INVITATION_TTL_MS = 7 * 24 * 3600_000;

export async function createWorkspace(db: Db, userId: string, p: { name: string; kind: Workspace['kind']; timezone: string; description: string }) {
  return await db.tx(async () => {
    const id = newId();
    const now = nowIso();
    await db.run(
      `INSERT INTO workspaces (id, name, kind, description, timezone, public_enabled, public_token, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [id, p.name, p.kind, p.description, p.timezone, newToken(), userId, now],
    );
    await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)`, [newId(), id, userId, now]);
    return id;
  });
}

export async function updateWorkspace(db: Db, wsId: string, p: { name: string; kind: Workspace['kind']; timezone: string; description: string; publicEnabled: boolean }) {
  await db.run(`UPDATE workspaces SET name = ?, kind = ?, timezone = ?, description = ?, public_enabled = ? WHERE id = ?`, [
    p.name,
    p.kind,
    p.timezone,
    p.description,
    p.publicEnabled ? 1 : 0,
    wsId,
  ]);
}

export async function setBookedDisplay(db: Db, wsId: string, publicMode: BookedDisplay, membersMode: BookedDisplay) {
  await db.run(`UPDATE workspaces SET show_booked_public = ?, show_booked_members = ? WHERE id = ?`, [publicMode, membersMode, wsId]);
}

/** Neuer öffentlicher Link – der alte funktioniert danach nicht mehr. */
export async function rotatePublicToken(db: Db, wsId: string) {
  await db.run(`UPDATE workspaces SET public_token = ? WHERE id = ?`, [newToken(), wsId]);
}

export async function deleteWorkspace(db: Db, wsId: string) {
  await db.tx(async () => {
    // booking_events/notifications hängen per ON DELETE CASCADE am Arbeitsbereich.
    await db.run(`DELETE FROM bookings WHERE workspace_id = ?`, [wsId]);
    await db.run(`DELETE FROM workspaces WHERE id = ?`, [wsId]);
  });
}

export async function getWorkspaceForUser(db: Db, wsId: string, userId: string) {
  return await db.get<Workspace & { membership_id: string; role: Role }>(
    `SELECT w.*, m.id AS membership_id, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
     WHERE w.id = ? AND m.user_id = ?`,
    [wsId, userId],
  );
}

export async function getWorkspaceByPublicToken(db: Db, token: string) {
  if (!token || token.length > 100) return undefined;
  return await db.get<Workspace>(`SELECT * FROM workspaces WHERE public_token = ? AND public_enabled = 1`, [token]);
}

export async function listWorkspacesForUser(db: Db, userId: string) {
  return await db.all<Workspace & { role: Role; membership_id: string }>(
    `SELECT w.*, m.role, m.id AS membership_id FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
     WHERE m.user_id = ? ORDER BY w.name COLLATE NOCASE`,
    [userId],
  );
}

export interface MemberRow {
  membership_id: string;
  user_id: string;
  role: Role;
  display_name: string;
  email: string;
  created_at: string;
}

export async function listMembers(db: Db, wsId: string) {
  return await db.all<MemberRow>(
    `SELECT m.id AS membership_id, m.user_id, m.role, u.display_name, u.email, m.created_at
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'staff' THEN 2 ELSE 3 END, u.display_name COLLATE NOCASE`,
    [wsId],
  );
}

export async function changeRole(db: Db, wsId: string, membershipId: string, role: Role): Promise<'ok' | 'not_found' | 'last_owner'> {
  return await db.tx(async () => {
    const m = await db.get<Membership>(`SELECT * FROM memberships WHERE id = ? AND workspace_id = ?`, [membershipId, wsId]);
    if (!m) return 'not_found';
    if (m.role === 'owner' && role !== 'owner' && await ownerCount(db, wsId) <= 1) return 'last_owner';
    await db.run(`UPDATE memberships SET role = ? WHERE id = ? AND workspace_id = ?`, [role, membershipId, wsId]);
    return 'ok';
  });
}

export async function removeMember(db: Db, wsId: string, membershipId: string): Promise<'ok' | 'not_found' | 'last_owner'> {
  return await db.tx(async () => {
    const m = await db.get<Membership>(`SELECT * FROM memberships WHERE id = ? AND workspace_id = ?`, [membershipId, wsId]);
    if (!m) return 'not_found';
    if (m.role === 'owner' && await ownerCount(db, wsId) <= 1) return 'last_owner';
    await db.run(`DELETE FROM memberships WHERE id = ? AND workspace_id = ?`, [membershipId, wsId]);
    return 'ok';
  });
}

async function ownerCount(db: Db, wsId: string) {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memberships WHERE workspace_id = ? AND role = 'owner'`, [wsId]))!.n;
}

/** Mitglieder, die über neue Anfragen informiert werden möchten (Anbieterseite). */
export async function providerRecipients(db: Db, wsId: string) {
  return await db.all<{ user_id: string; email: string }>(
    `SELECT u.id AS user_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = ? AND m.role IN ('owner', 'admin', 'staff') AND u.notify_new_requests = 1 AND u.deleted_at IS NULL`,
    [wsId],
  );
}

// ---------- Gruppen ----------

export async function listGroups(db: Db, wsId: string) {
  return await db.all<Group & { member_count: number }>(
    `SELECT g.*, (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
     FROM ws_groups g WHERE g.workspace_id = ? ORDER BY g.name COLLATE NOCASE`,
    [wsId],
  );
}

export async function getGroup(db: Db, wsId: string, groupId: string) {
  return await db.get<Group>(`SELECT * FROM ws_groups WHERE id = ? AND workspace_id = ?`, [groupId, wsId]);
}

export async function saveGroup(db: Db, wsId: string, groupId: string | null, p: { name: string; description: string }) {
  if (groupId) {
    await db.run(`UPDATE ws_groups SET name = ?, description = ? WHERE id = ? AND workspace_id = ?`, [p.name, p.description, groupId, wsId]);
    return groupId;
  }
  const id = newId();
  await db.run(`INSERT INTO ws_groups (id, workspace_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`, [id, wsId, p.name, p.description, nowIso()]);
  return id;
}

export async function deleteGroup(db: Db, wsId: string, groupId: string) {
  return await db.run(`DELETE FROM ws_groups WHERE id = ? AND workspace_id = ?`, [groupId, wsId]);
}

export async function groupMemberIds(db: Db, wsId: string, groupId: string) {
  return new Set(
    (await db.all<{ membership_id: string }>(`SELECT membership_id FROM group_members WHERE group_id = ? AND workspace_id = ?`, [groupId, wsId])).map(
      (r) => r.membership_id,
    ),
  );
}

/** Setzt die Mitglieder einer Gruppe. Fremde Mitgliedschafts-IDs scheitern am zusammengesetzten Fremdschlüssel. */
export async function setGroupMembers(db: Db, wsId: string, groupId: string, membershipIds: string[]) {
  await db.tx(async () => {
    const valid = new Set((await listMembers(db, wsId)).map((m) => m.membership_id));
    await db.run(`DELETE FROM group_members WHERE group_id = ? AND workspace_id = ?`, [groupId, wsId]);
    for (const mid of new Set(membershipIds)) {
      if (!valid.has(mid)) continue;
      await db.run(`INSERT INTO group_members (group_id, membership_id, workspace_id, created_at) VALUES (?, ?, ?, ?)`, [groupId, mid, wsId, nowIso()]);
    }
  });
}

export async function addToGroup(db: Db, wsId: string, groupId: string, membershipId: string) {
  await db.run(`INSERT OR IGNORE INTO group_members (group_id, membership_id, workspace_id, created_at) VALUES (?, ?, ?, ?)`, [
    groupId,
    membershipId,
    wsId,
    nowIso(),
  ]);
}

/** Gruppen, in denen eine Person selbst Mitglied ist (nur ihre eigenen). */
export async function myGroups(db: Db, wsId: string, membershipId: string) {
  return await db.all<Group>(
    `SELECT g.* FROM ws_groups g JOIN group_members gm ON gm.group_id = g.id WHERE g.workspace_id = ? AND gm.membership_id = ? ORDER BY g.name`,
    [wsId, membershipId],
  );
}

// ---------- Einladungen ----------

export interface Invitation {
  id: string;
  workspace_id: string;
  email: string;
  role: Role;
  group_id: string | null;
  offering_id: string | null;
  status: 'pending' | 'accepted' | 'revoked';
  expires_at: string;
  send_count: number;
  last_sent_at: string | null;
  created_at: string;
}

export async function createInvitation(
  db: Db,
  wsId: string,
  invitedBy: string,
  p: { email: string; role: Role; groupId: string | null; offeringId: string | null },
  now = Date.now(),
) {
  const token = newToken();
  const id = newId();
  await db.run(
    `INSERT INTO invitations (id, workspace_id, email, role, group_id, offering_id, token_hash, status, expires_at, invited_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [id, wsId, p.email, p.role, p.groupId, p.offeringId, hashToken(token), nowIso(now + INVITATION_TTL_MS), invitedBy, nowIso(now)],
  );
  return { id, token };
}

/** Erneut senden: neues Token, neue Frist. Der vorherige Link wird damit ungültig. */
export async function renewInvitation(db: Db, wsId: string, invitationId: string, now = Date.now()) {
  const token = newToken();
  const changed = await db.run(
    `UPDATE invitations SET token_hash = ?, expires_at = ? WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
    [hashToken(token), nowIso(now + INVITATION_TTL_MS), invitationId, wsId],
  );
  return changed ? token : null;
}

export async function markInvitationSent(db: Db, invitationId: string) {
  await db.run(`UPDATE invitations SET send_count = send_count + 1, last_sent_at = ? WHERE id = ?`, [nowIso(), invitationId]);
}

export async function revokeInvitation(db: Db, wsId: string, invitationId: string) {
  return await db.run(`UPDATE invitations SET status = 'revoked' WHERE id = ? AND workspace_id = ? AND status = 'pending'`, [invitationId, wsId]);
}

export async function listInvitations(db: Db, wsId: string) {
  return await db.all<Invitation & { group_name: string | null; offering_name: string | null }>(
    `SELECT i.*, g.name AS group_name, o.name AS offering_name FROM invitations i
     LEFT JOIN ws_groups g ON g.id = i.group_id LEFT JOIN offerings o ON o.id = i.offering_id
     WHERE i.workspace_id = ? AND i.status = 'pending' ORDER BY i.created_at DESC`,
    [wsId],
  );
}

export async function invitationsCreatedSince(db: Db, wsId: string, sinceMs: number) {
  return (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM invitations WHERE workspace_id = ? AND created_at > ?`, [wsId, nowIso(sinceMs)]))!.n;
}

export async function findInvitationByToken(db: Db, token: string, now = Date.now()) {
  if (!token || token.length > 100) return undefined;
  return await db.get<Invitation & { workspace_name: string; offering_name: string | null }>(
    `SELECT i.*, w.name AS workspace_name, o.name AS offering_name FROM invitations i
     JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN offerings o ON o.id = i.offering_id
     WHERE i.token_hash = ? AND i.status = 'pending' AND i.expires_at > ?`,
    [hashToken(token), nowIso(now)],
  );
}

/** Offene Einladungen an eine (bestätigte) E-Mail-Adresse – für die Übersicht der Person. */
export async function pendingInvitationsForEmail(db: Db, email: string, now = Date.now()) {
  return await db.all<{ id: string; workspace_name: string; offering_name: string | null; group_name: string | null }>(
    `SELECT i.id, w.name AS workspace_name, o.name AS offering_name, g.name AS group_name FROM invitations i
     JOIN workspaces w ON w.id = i.workspace_id LEFT JOIN offerings o ON o.id = i.offering_id LEFT JOIN ws_groups g ON g.id = i.group_id
     WHERE i.email = ? AND i.status = 'pending' AND i.expires_at > ?`,
    [email, nowIso(now)],
  );
}

/**
 * Nimmt eine Einladung an. Voraussetzung: Die angemeldete Person hat genau die eingeladene
 * Adresse bestätigt. Der Link allein berechtigt zu nichts.
 */
export async function acceptInvitation(
  db: Db,
  inv: Pick<Invitation, 'id' | 'workspace_id' | 'email' | 'role' | 'group_id' | 'offering_id'>,
  user: { id: string; email: string },
): Promise<'ok' | 'wrong_email' | 'gone'> {
  if (user.email.toLowerCase() !== inv.email.toLowerCase()) return 'wrong_email';
  return await db.tx(async () => {
    const changed = await db.run(`UPDATE invitations SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ? AND status = 'pending'`, [
      user.id,
      nowIso(),
      inv.id,
    ]);
    if (!changed) return 'gone';
    let m = await db.get<Membership>(`SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?`, [inv.workspace_id, user.id]);
    if (!m) {
      const id = newId();
      await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, [id, inv.workspace_id, user.id, inv.role, nowIso()]);
      m = { id, workspace_id: inv.workspace_id, user_id: user.id, role: inv.role };
    } else if (rank(inv.role) < rank(m.role)) {
      // Eine Einladung kann Rechte erweitern, aber nie kürzen.
      await db.run(`UPDATE memberships SET role = ? WHERE id = ?`, [inv.role, m.id]);
    }
    if (inv.group_id) await addToGroup(db, inv.workspace_id, inv.group_id, m.id);
    if (inv.offering_id) {
      await db.run(`INSERT OR IGNORE INTO offering_audience (id, offering_id, workspace_id, membership_id) VALUES (?, ?, ?, ?)`, [
        newId(),
        inv.offering_id,
        inv.workspace_id,
        m.id,
      ]);
    }
    return 'ok';
  });
}

function rank(role: Role) {
  return { owner: 0, admin: 1, staff: 2, member: 3 }[role];
}

/**
 * Schüler:in ohne App anlegen (nur Name, optional Gruppe/Instrument): Konto mit Platzhalter-Adresse,
 * Mitgliedschaft im Bereich. Termine trägt die Lehrkraft danach direkt als fest ein.
 */
export async function createOfflineStudent(
  db: Db,
  wsId: string,
  p: { firstName: string; lastName: string; groupId: string | null; newGroupName: string },
): Promise<string> {
  return await db.tx(async () => {
    const userId = newId();
    const now = nowIso();
    const name = `${p.firstName} ${p.lastName}`.trim();
    await db.run(
      `INSERT INTO users (id, email, first_name, last_name, display_name, notify_booking_updates, notify_new_requests, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
      [userId, `${userId}@${OFFLINE_DOMAIN}`, p.firstName, p.lastName, name, now],
    );
    const membershipId = newId();
    await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)`, [membershipId, wsId, userId, now]);
    let groupId = p.groupId;
    if (!groupId && p.newGroupName) {
      const existing = await db.get<{ id: string }>(`SELECT id FROM ws_groups WHERE workspace_id = ? AND name = ? COLLATE NOCASE`, [wsId, p.newGroupName]);
      groupId = existing?.id ?? (await saveGroup(db, wsId, null, { name: p.newGroupName, description: '' }));
    }
    if (groupId) await addToGroup(db, wsId, groupId, membershipId);
    return userId;
  });
}

/**
 * Name einer Schüler:in ohne App ändern oder eine E-Mail nachtragen. Mit E-Mail kann sich die Person
 * danach selbst registrieren und übernimmt dabei dieses Konto samt allen Terminen.
 */
export async function updateOfflineStudent(
  db: Db,
  userId: string,
  p: { firstName: string; lastName: string; email: string },
): Promise<'ok' | 'email_taken' | 'not_offline'> {
  const u = await db.get<{ email: string }>(`SELECT email FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
  if (!u || !isOfflineEmail(u.email)) return 'not_offline';
  if (p.email && (await db.get(`SELECT 1 FROM users WHERE email = ? AND id <> ?`, [p.email, userId]))) return 'email_taken';
  await db.run(
    `UPDATE users SET first_name = ?, last_name = ?, display_name = ?, email = ?, notify_booking_updates = ?, notify_new_requests = 1 WHERE id = ?`,
    [p.firstName, p.lastName, `${p.firstName} ${p.lastName}`.trim(), p.email || u.email, p.email ? 1 : 0, userId],
  );
  return 'ok';
}
