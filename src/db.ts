// Gemeinsame Datenbank-Schnittstelle. Zwei Umsetzungen:
// - src/db-node.ts: SQLite über node:sqlite (lokale Entwicklung, Tests, eigener Server)
// - src/db-d1.ts:   Cloudflare D1 (Veröffentlichung auf Cloudflare Workers)

export type Param = string | number | null;
export type Params = Param[] | Record<string, Param>;
// Zeilen kommen aus SQLite als einfache Objekte; die Feldtypen legen die Aufrufer fest.
export type Row = Record<string, any>;

export interface Db {
  get<T = Row>(sql: string, params?: Params): Promise<T | undefined>;
  all<T = Row>(sql: string, params?: Params): Promise<T[]>;
  /** Führt einen Schreibbefehl aus und liefert die Zahl geänderter Zeilen. */
  run(sql: string, params?: Params): Promise<number>;
  /**
   * Zusammengehörige Schritte. Unter Node echte Transaktion (BEGIN IMMEDIATE), parallele Anfragen
   * warten. Unter D1 gibt es keine interaktiven Transaktionen: Dort sichern Trigger und eindeutige
   * Indizes die entscheidenden Regeln (keine Überbuchung, keine Doppelbuchung) direkt in der Datenbank.
   */
  tx<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Wandelt benannte Parameter (@name) in nummerierte (?1, ?2 …) um – D1 kennt nur diese.
 * Text in einfachen Anführungszeichen (z. B. '%@ohne-app.invalid') bleibt unverändert.
 */
export function toOrdered(sql: string, params: Record<string, Param>): { sql: string; values: Param[] } {
  const names: string[] = [];
  const out = sql.replace(/'(?:[^']|'')*'|@([A-Za-z_]\w*)/g, (match, name: string | undefined) => {
    if (name === undefined) return match;
    let i = names.indexOf(name);
    if (i < 0) {
      if (!(name in params)) throw new Error(`SQL-Parameter @${name} fehlt`);
      names.push(name);
      i = names.length - 1;
    }
    return `?${i + 1}`;
  });
  return { sql: out, values: names.map((n) => params[n]) };
}
