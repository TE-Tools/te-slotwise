import { NodeDb, migrate } from '../src/db-node.ts';
import { newId, nowIso } from '../src/ids.ts';
import { createWorkspace, getWorkspaceForUser } from '../src/services/workspaces.ts';
import { saveOffering, type OfferingInput } from '../src/services/offerings.ts';

export async function freshDb() {
  const db = new NodeDb(':memory:');
  await migrate(db);
  return db;
}

export async function makeUser(db: NodeDb, email: string, name = email.split('@')[0]) {
  const id = newId();
  const [first, ...rest] = name.split(' ');
  await db.run(`INSERT INTO users (id, email, first_name, last_name, display_name, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [
    id,
    email,
    first,
    rest.join(' ') || 'Test',
    name,
    nowIso(),
    nowIso(),
  ]);
  return { id, email, display_name: name };
}

export async function addMember(db: NodeDb, wsId: string, userId: string, role = 'member') {
  const id = newId();
  await db.run(`INSERT INTO memberships (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)`, [id, wsId, userId, role, nowIso()]);
  return id;
}
export const baseOffering: OfferingInput = {
  name: 'Einzelstunde',
  description: '',
  duration_min: 60,
  buffer_min: 0,
  location: 'Raum 1',
  online_info: '',
  default_capacity: 1,
  confirmation_mode: 'manual',
  hold_on_request: 0,
  allow_self_cancel: 1,
  cancel_cutoff_hours: 24,
  min_notice_hours: 0,
  visibility: 'public',
};

export async function setupWorkspace(db: NodeDb, offering: Partial<OfferingInput> = {}) {
  const owner = await makeUser(db, `owner-${newId()}@example.com`, 'Owner');
  const wsId = await createWorkspace(db, owner.id, { name: 'Testbereich', kind: 'personal', timezone: 'Europe/Berlin', description: '' });
  const ws = (await getWorkspaceForUser(db, wsId, owner.id))!;
  const offeringId = (await saveOffering(db, wsId, null, { ...baseOffering, ...offering }, { groupIds: [], membershipIds: [] }))!;
  return { owner, wsId, ws, offeringId };
}

/** Ein Datum (YYYY-MM-DD) n Tage in der Zukunft. */
export function futureDate(days = 10) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
