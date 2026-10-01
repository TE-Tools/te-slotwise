// Rollen und Rechte. Neue Rollen (z. B. Lehrkraft) werden hier ergänzt,
// ohne Routen anzufassen: Routen fragen immer ein Recht ab, nie eine Rolle.

export type Role = 'owner' | 'admin' | 'staff' | 'member';

export type Permission =
  | 'workspace.manage' // Einstellungen, öffentlicher Link
  | 'workspace.delete'
  | 'members.manage' // Mitglieder, Rollen, Einladungen
  | 'groups.manage'
  | 'offerings.manage'
  | 'slots.manage'
  | 'bookings.manage'
  | 'notifications.manage'
  | 'book';

const ALL: Permission[] = [
  'workspace.manage',
  'workspace.delete',
  'members.manage',
  'groups.manage',
  'offerings.manage',
  'slots.manage',
  'bookings.manage',
  'notifications.manage',
  'book',
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(ALL),
  admin: new Set(ALL.filter((p) => p !== 'workspace.delete')),
  // Mitarbeitende: Slots und Buchungen verwalten, aber keine Mitglieder, Angebote oder Einstellungen.
  staff: new Set<Permission>(['slots.manage', 'bookings.manage', 'book']),
  member: new Set<Permission>(['book']),
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Eigentümer:in',
  admin: 'Administrator:in',
  staff: 'Mitarbeiter:in',
  member: 'Mitglied',
};

/** Rollen, die über die Oberfläche vergeben werden können. */
export const ASSIGNABLE_ROLES: Role[] = ['admin', 'staff', 'member'];

export function can(role: Role | null | undefined, perm: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].has(perm);
}

export function isManager(role: Role | null | undefined) {
  return can(role, 'slots.manage') || can(role, 'members.manage');
}

export type Visibility = 'public' | 'groups' | 'people' | 'internal';

export const VISIBILITY_LABELS: Record<Visibility, string> = {
  public: 'Öffentlich (jeder mit dem Link)',
  groups: 'Ausgewählte Gruppen (und Personen)',
  people: 'Ausgewählte Personen (und Gruppen)',
  internal: 'Intern (alle Mitglieder des Arbeitsbereichs)',
};

/** Zielgruppen-Prüfung: Person direkt eingetragen oder Mitglied einer eingetragenen Gruppe. */
function audienceMatch(table: 'offering_audience' | 'slot_audience', fk: string, ref: string) {
  return `EXISTS (
      SELECT 1 FROM ${table} a
      LEFT JOIN group_members gm ON gm.group_id = a.group_id AND gm.workspace_id = a.workspace_id AND gm.membership_id = @mid
      WHERE a.${fk} = ${ref} AND (a.membership_id = @mid OR gm.membership_id IS NOT NULL))`;
}

function visibleFor(vis: string, table: 'offering_audience' | 'slot_audience', fk: string, ref: string) {
  // 'groups' und 'people' nutzen dieselbe Zielgruppenliste (Gruppen + Einzelpersonen).
  // So bleibt z. B. eine Einladung zu einem Angebot wirksam, egal welche der beiden Arten gewählt ist.
  return `(${vis} = 'public'
     OR (@mid IS NOT NULL AND ${vis} = 'internal')
     OR (@mid IS NOT NULL AND ${vis} IN ('groups', 'people') AND ${audienceMatch(table, fk, ref)}))`;
}

/**
 * SQL-Bedingung: Ist Slot "s" (mit Angebot "o") für die Mitgliedschaft @mid sichtbar?
 * @mid = NULL steht für öffentliche Besucher bzw. Personen ohne Mitgliedschaft.
 * Slots mit visibility = 'inherit' übernehmen Sichtbarkeit und Zielgruppe des Angebots.
 */
export const SLOT_VISIBLE_SQL = `(
  (s.visibility = 'inherit' AND ${visibleFor('o.visibility', 'offering_audience', 'offering_id', 'o.id')})
  OR (s.visibility <> 'inherit' AND ${visibleFor('s.visibility', 'slot_audience', 'slot_id', 's.id')})
)`;

/** SQL-Bedingung: Ist Angebot "o" selbst (unabhängig von Slots) für @mid sichtbar? */
export const OFFERING_VISIBLE_SQL = visibleFor('o.visibility', 'offering_audience', 'offering_id', 'o.id');

/** Sichere Weiterleitungsziele: nur relative Pfade dieser Anwendung. */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== 'string') return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.length > 500) return null;
  return next;
}
