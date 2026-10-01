// Einfache Begrenzung im Arbeitsspeicher (feste Zeitfenster). Reicht für einen
// einzelnen Serverprozess; bei mehreren Instanzen durch einen geteilten Speicher ersetzen.

export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  /** true = erlaubt, false = Grenze erreicht. */
  take(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    entry.count++;
    return entry.count <= limit;
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
