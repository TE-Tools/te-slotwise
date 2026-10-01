import type { Hono } from 'hono';
import { requireUser, type AppEnv, type Ctx } from '../context.ts';
import { deleteSubscription, deviceLabel, isAllowedEndpoint, pushToUser, saveSubscription } from '../services/push.ts';
import { back } from './common.ts';

// Push-Benachrichtigungen: Der Browser meldet sein Push-Abo (JSON), der Server speichert es pro Person.

/** JSON-Anfragen prüft die CSRF-Middleware nicht – deshalb hier die Herkunft selbst prüfen. */
function sameOrigin(c: Ctx) {
  return c.req.header('origin') === c.get('deps').config.appOrigin;
}

export function registerPushRoutes(app: Hono<AppEnv>) {
  app.post('/push/subscribe', async (c) => {
    if (!sameOrigin(c)) return c.json({ ok: false, error: 'origin' }, 403);
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'login' }, 401);
    const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : '';
    const p256dh = typeof body?.keys?.p256dh === 'string' ? body.keys.p256dh : '';
    const auth = typeof body?.keys?.auth === 'string' ? body.keys.auth : '';
    const b64 = /^[A-Za-z0-9_-]+$/;
    if (!isAllowedEndpoint(endpoint) || !b64.test(p256dh) || p256dh.length > 100 || !b64.test(auth) || auth.length > 50) {
      return c.json({ ok: false, error: 'invalid' }, 400);
    }
    const { db, limiter } = c.get('deps');
    if (!limiter.take(`push-sub:${user.id}`, 20, 3600_000)) return c.json({ ok: false, error: 'rate' }, 429);
    await saveSubscription(db, user.id, { endpoint, p256dh, auth, label: deviceLabel(c.req.header('user-agent') ?? '') });
    return c.json({ ok: true });
  });

  app.post('/push/unsubscribe', async (c) => {
    if (!sameOrigin(c)) return c.json({ ok: false, error: 'origin' }, 403);
    const user = c.get('user');
    if (!user) return c.json({ ok: false, error: 'login' }, 401);
    const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint === 'string') await deleteSubscription(c.get('deps').db, user.id, body.endpoint.slice(0, 1000));
    return c.json({ ok: true });
  });

  app.post('/push/test', async (c) => {
    const user = requireUser(c);
    const { db, push, limiter } = c.get('deps');
    if (!limiter.take(`push-test:${user.id}`, 5, 600_000)) return back(c, '/profile', 'push_rate');
    const r = await pushToUser(db, push, user.id, {
      title: 'TE-Slotwise: Test',
      body: 'Push-Benachrichtigungen funktionieren auf diesem Gerät.',
      url: '/profile',
      tag: 'test',
    });
    return back(c, '/profile', r.delivered ? 'push_test_ok' : r.devices ? 'push_test_failed' : 'push_none');
  });

  app.post('/push/devices/:id/delete', async (c) => {
    const user = requireUser(c);
    await deleteSubscription(c.get('deps').db, user.id, c.req.param('id'));
    return back(c, '/profile', 'push_device_removed');
  });
}
