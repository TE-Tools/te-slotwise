import type { Visibility } from '../authz.ts';
import type { Db } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

export interface Offering {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  duration_min: number;
  buffer_min: number;
  location: string;
  online_info: string;
  default_capacity: number;
  confirmation_mode: 'manual' | 'auto';
  hold_on_request: number;
  allow_self_cancel: number;
  cancel_cutoff_hours: number;
  min_notice_hours: number;
  visibility: Visibility;
  archived_at: string | null;
}

export type OfferingInput = Omit<Offering, 'id' | 'workspace_id' | 'archived_at'>;

export interface Audience {
  groupIds: string[];
  membershipIds: string[];
}

export async function listOfferings(db: Db, wsId: string, includeArchived = false) {
  return await db.all<Offering & { upcoming_slots: number }>(
    `SELECT o.*, (SELECT COUNT(*) FROM slots s WHERE s.offering_id = o.id AND s.starts_at > ?) AS upcoming_slots
     FROM offerings o WHERE o.workspace_id = ? ${includeArchived ? '' : 'AND o.archived_at IS NULL'} ORDER BY o.archived_at IS NOT NULL, o.name COLLATE NOCASE`,
    [nowIso(), wsId],
  );
}

export async function getOffering(db: Db, wsId: string, offeringId: string) {
  return await db.get<Offering>(`SELECT * FROM offerings WHERE id = ? AND workspace_id = ?`, [offeringId, wsId]);
}

export async function saveOffering(db: Db, wsId: string, offeringId: string | null, p: OfferingInput, audience: Audience) {
  return await db.tx(async () => {
    const now = nowIso();
    const values = [
      p.name,
      p.description,
      p.duration_min,
      p.buffer_min,
      p.location,
      p.online_info,
      p.default_capacity,
      p.confirmation_mode,
      p.hold_on_request,
      p.allow_self_cancel,
      p.cancel_cutoff_hours,
      p.min_notice_hours,
      p.visibility,
    ];
    let id = offeringId;
    if (id) {
      const changed = await db.run(
        `UPDATE offerings SET name = ?, description = ?, duration_min = ?, buffer_min = ?, location = ?, online_info = ?, default_capacity = ?,
         confirmation_mode = ?, hold_on_request = ?, allow_self_cancel = ?, cancel_cutoff_hours = ?, min_notice_hours = ?, visibility = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
        [...values, now, id, wsId],
      );
      if (!changed) return null;
    } else {
      id = newId();
      await db.run(
        `INSERT INTO offerings (id, workspace_id, name, description, duration_min, buffer_min, location, online_info, default_capacity,
         confirmation_mode, hold_on_request, allow_self_cancel, cancel_cutoff_hours, min_notice_hours, visibility, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, wsId, ...values, now, now],
      );
    }
    await setAudience(db, 'offering', wsId, id, audience);
    return id;
  });
}

export async function setArchived(db: Db, wsId: string, offeringId: string, archived: boolean) {
  return await db.run(`UPDATE offerings SET archived_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`, [
    archived ? nowIso() : null,
    nowIso(),
    offeringId,
    wsId,
  ]);
}

/**
 * Zielgruppe schreiben. Nur IDs aus demselben Arbeitsbereich werden übernommen;
 * zusätzlich verhindern zusammengesetzte Fremdschlüssel jede arbeitsbereichsfremde Zuordnung.
 */
export async function setAudience(db: Db, kind: 'offering' | 'slot', wsId: string, targetId: string, audience: Audience) {
  const table = kind === 'offering' ? 'offering_audience' : 'slot_audience';
  const col = kind === 'offering' ? 'offering_id' : 'slot_id';
  const validGroups = new Set((await db.all<{ id: string }>(`SELECT id FROM ws_groups WHERE workspace_id = ?`, [wsId])).map((r) => r.id));
  const validMembers = new Set((await db.all<{ id: string }>(`SELECT id FROM memberships WHERE workspace_id = ?`, [wsId])).map((r) => r.id));
  await db.run(`DELETE FROM ${table} WHERE ${col} = ? AND workspace_id = ?`, [targetId, wsId]);
  for (const g of new Set(audience.groupIds)) {
    if (validGroups.has(g)) await db.run(`INSERT INTO ${table} (id, ${col}, workspace_id, group_id) VALUES (?, ?, ?, ?)`, [newId(), targetId, wsId, g]);
  }
  for (const m of new Set(audience.membershipIds)) {
    if (validMembers.has(m)) await db.run(`INSERT INTO ${table} (id, ${col}, workspace_id, membership_id) VALUES (?, ?, ?, ?)`, [newId(), targetId, wsId, m]);
  }
}

export async function getAudience(db: Db, kind: 'offering' | 'slot', wsId: string, targetId: string): Promise<Audience> {
  const table = kind === 'offering' ? 'offering_audience' : 'slot_audience';
  const col = kind === 'offering' ? 'offering_id' : 'slot_id';
  const rows = await db.all<{ group_id: string | null; membership_id: string | null }>(
    `SELECT group_id, membership_id FROM ${table} WHERE ${col} = ? AND workspace_id = ?`,
    [targetId, wsId],
  );
  return {
    groupIds: rows.filter((r) => r.group_id).map((r) => r.group_id!),
    membershipIds: rows.filter((r) => r.membership_id).map((r) => r.membership_id!),
  };
}
