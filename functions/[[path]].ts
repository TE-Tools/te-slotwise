// Cloudflare Pages: alle Anfragen, die keine statische Datei sind, gehen an die Anwendung.
import { handle } from 'hono/cloudflare-pages';
import { app } from '../src/worker.ts';

export const onRequest = handle(app);
