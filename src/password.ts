// Passwort-Hashing mit PBKDF2-SHA-256 über die Web-Crypto-Schnittstelle (Node und Cloudflare).
// Cloudflare erlaubt höchstens 100 000 Iterationen; zusammen mit Zufalls-Salt und
// Sperre nach Fehlversuchen ist das für diesen Einsatz angemessen.

const ITERATIONS = 100_000;
const enc = new TextEncoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    // Gleich viel Rechenzeit wie bei einem echten Vergleich – verrät nicht, ob es das Konto gibt.
    await derive(password, new Uint8Array(16), ITERATIONS);
    return false;
  }
  const [scheme, iter, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256') return false;
  const expected = unb64(hashB64);
  const actual = await derive(password, unb64(saltB64), Number(iter));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen haben.`;
  if (pw.length > 200) return 'Das Passwort ist zu lang.';
  return null;
}
