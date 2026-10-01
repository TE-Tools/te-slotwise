import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { can, type Permission, type Role } from './authz.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { Mailer } from './mail/mailer.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { User } from './services/auth.ts';
import { getWorkspaceForUser, type Workspace } from './services/workspaces.ts';

export interface Deps {
  db: Db;
  config: Config;
  mailer: Mailer;
  limiter: RateLimiter;
  /** Stößt den Versand ausstehender Benachrichtigungen an (nach Commit). */
  kick: () => void;
}

export type AppEnv = { Variables: { user: User | null; deps: Deps } };
export type Ctx = Context<AppEnv>;

export type WsContext = Workspace & { membership_id: string; role: Role };

export function notFound(): never {
  throw new HTTPException(404, { message: 'not_found' });
}

/** Erfordert eine Anmeldung; leitet sonst zur Anmeldung mit Rücksprung weiter. */
export function requireUser(c: Ctx): User {
  const user = c.get('user');
  if (!user) {
    const next = c.req.method === 'GET' ? c.req.path + (new URL(c.req.url).search || '') : '/dashboard';
    throw new HTTPException(302, { res: c.redirect(`/login?next=${encodeURIComponent(next)}`) });
  }
  if (!user.display_name && c.req.path !== '/profile') {
    throw new HTTPException(302, { res: c.redirect(`/profile?setup=1&next=${encodeURIComponent(c.req.path)}`) });
  }
  return user;
}

/**
 * Lädt den Arbeitsbereich aus der URL – aber nur, wenn die angemeldete Person Mitglied ist
 * und (optional) das geforderte Recht hat. Andernfalls 404, damit nicht einmal die
 * Existenz eines fremden Arbeitsbereichs erkennbar ist.
 */
export async function requireWs(c: Ctx, perm?: Permission): Promise<{ user: User; ws: WsContext }> {
  const user = requireUser(c);
  const ws = await getWorkspaceForUser(c.get('deps').db, c.req.param('wid') ?? '', user.id);
  if (!ws || (perm && !can(ws.role, perm))) notFound();
  return { user, ws };
}

export function clientIp(c: Ctx, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) return fwd.split(',')[0].trim();
  }
  // Bei @hono/node-server liegt die Verbindung unter env.incoming.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

// ---------- Formularwerte ----------

export type Form = Record<string, string | File | (string | File)[]>;

export async function readForm(c: Ctx): Promise<Form> {
  return (await c.req.parseBody({ all: true })) as Form;
}

export function str(f: Form, key: string, max = 500): string {
  const v = f[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

export function int(f: Form, key: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(str(f, key, 20), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function bool(f: Form, key: string): boolean {
  const v = str(f, key, 10);
  return v === '1' || v === 'on' || v === 'true';
}

export function list(f: Form, key: string): string[] {
  const v = f[key];
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 100);
}

export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
