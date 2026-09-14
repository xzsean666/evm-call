import type { CooldownState } from "../execution/CooldownTracker";
import type { SqliteStorageAdapter } from "./SqliteStorageAdapter";

export interface PersistedCooldownRecord {
  readonly endpointId: string;
  readonly consecutiveFailures: number;
  readonly currentCooldownMs: number;
  readonly cooldownUntil: number | null;
  readonly firstFailureAt: number | null;
  readonly updatedAt: number;
}

export class SqliteCooldownStore {
  constructor(private readonly storage: SqliteStorageAdapter) {}

  loadAll(): readonly PersistedCooldownRecord[] {
    try {
      const rows = this.storage.all<{
        endpoint_id: string;
        consecutive_failures: number | bigint;
        current_cooldown_ms: number | bigint;
        cooldown_until: number | bigint | null;
        first_failure_at: number | bigint | null;
        updated_at: number | bigint;
      }>(
        "SELECT endpoint_id, consecutive_failures, current_cooldown_ms, cooldown_until, first_failure_at, updated_at FROM evm_cooldown_states",
      );

      return rows.map((row) => ({
        endpointId: row.endpoint_id,
        consecutiveFailures: Number(row.consecutive_failures),
        currentCooldownMs: Number(row.current_cooldown_ms),
        cooldownUntil: row.cooldown_until !== null && row.cooldown_until !== undefined ? Number(row.cooldown_until) : null,
        firstFailureAt: row.first_failure_at !== null && row.first_failure_at !== undefined ? Number(row.first_failure_at) : null,
        updatedAt: Number(row.updated_at),
      }));
    } catch {
      return Object.freeze([]);
    }
  }

  save(
    endpointId: string,
    state: CooldownState,
    now = Date.now(),
  ): void {
    const sql = `INSERT OR REPLACE INTO evm_cooldown_states (
      endpoint_id, consecutive_failures, current_cooldown_ms, cooldown_until, first_failure_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`;

    try {
      this.storage.run(sql, [
        endpointId,
        state.consecutiveFailures,
        state.currentCooldownMs,
        state.cooldownUntil,
        state.firstFailureAt,
        now,
      ]);
    } catch {
      // safe fallback if storage uninitialized
    }
  }

  delete(endpointId: string): void {
    try {
      this.storage.run("DELETE FROM evm_cooldown_states WHERE endpoint_id = ?", [endpointId]);
    } catch {
      // safe fallback
    }
  }
}
