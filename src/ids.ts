import { createHash, randomBytes } from 'node:crypto';

/** Zufällige, nicht erratbare ID (96 Bit). */
export const newId = () => randomBytes(12).toString('base64url');

/** Geheimes Token für Links und Sitzungen (256 Bit). Gespeichert wird nur der Hash. */
export const newToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export const nowIso = (now = Date.now()) => new Date(now).toISOString();
