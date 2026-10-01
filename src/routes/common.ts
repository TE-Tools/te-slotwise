import type { Ctx } from '../context.ts';
import { listWorkspacesForUser } from '../services/workspaces.ts';
import { layout, type LayoutOpts } from '../views/ui.ts';

export async function render(c: Ctx, o: Omit<LayoutOpts, 'user' | 'workspaces'>, status: 200 | 400 | 403 | 404 | 429 | 500 = 200) {
  const user = c.get('user');
  const workspaces = user ? (await listWorkspacesForUser(c.get('deps').db, user.id)).map((w) => ({ id: w.id, name: w.name })) : [];
  c.header('Cache-Control', 'no-store');
  return c.html(layout({ ...o, user, workspaces }), status);
}

/** Weiterleitung mit fester Rückmeldung (siehe MESSAGES in views/ui.ts). */
export function back(c: Ctx, path: string, msg?: string) {
  if (!msg) return c.redirect(path, 303);
  const sep = path.includes('?') ? '&' : '?';
  return c.redirect(`${path}${sep}msg=${encodeURIComponent(msg)}`, 303);
}
