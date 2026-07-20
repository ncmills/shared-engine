/** One immutable, timestamped row for a money-moving (or money-adjacent) action.
 *  The forensic record for chargebacks/disputes. Append-only — never updated or deleted. */
export interface AuditEntry {
  ts: string; // ISO8601, passed in by the caller (determinism — no Date.now())
  tripId: string;
  itemId: string | null;
  actor: string; // e.g. "orchestrator"
  action: "hold" | "hold_failed" | "book" | "book_failed" | "compensate" | "compensate_failed" | "release" | "release_failed";
  rail: string;
  externalRef: string | null; // holdRef / railRef
  amountCents: number;
  detail?: string;
}

export interface AuditLog {
  append(e: AuditEntry): Promise<void>;
  entries(tripId: string): Promise<AuditEntry[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private log: AuditEntry[] = [];
  async append(e: AuditEntry): Promise<void> {
    this.log.push(e);
  }
  async entries(tripId: string): Promise<AuditEntry[]> {
    return this.log.filter((e) => e.tripId === tripId);
  }
}
