import { describe, expect, it } from "vitest";

import { SqliteStorageAdapter } from "../../src/storage/SqliteStorageAdapter";
import { SqliteCooldownStore } from "../../src/storage/SqliteCooldownStore";

describe("SqliteStorageAdapter", () => {
  it("initializes in-memory database and creates tables", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    adapter.initialize();
    expect(adapter.isOpen()).toBe(true);

    const tables = adapter.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("evm_cooldown_states");
    expect(tableNames).toContain("evm_rpc_cache");

    adapter.close();
    expect(adapter.isOpen()).toBe(false);
  });

  it("supports basic DML and queries", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    adapter.initialize();

    const insertResult = adapter.run(
      "INSERT INTO evm_cooldown_states (endpoint_id, consecutive_failures, current_cooldown_ms, updated_at) VALUES (?, ?, ?, ?)",
      ["node-1", 2, 300_000, 1_000_000],
    );
    expect(insertResult.changes).toBe(1);

    const row = adapter.get<{ endpoint_id: string; consecutive_failures: number }>(
      "SELECT endpoint_id, consecutive_failures FROM evm_cooldown_states WHERE endpoint_id = ?",
      ["node-1"],
    );
    expect(row).toEqual({ endpoint_id: "node-1", consecutive_failures: 2 });

    const allRows = adapter.all("SELECT * FROM evm_cooldown_states");
    expect(allRows).toHaveLength(1);

    adapter.close();
  });

  it("handles transactions with commit and rollback", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    adapter.initialize();

    adapter.transaction((tx) => {
      tx.run(
        "INSERT INTO evm_cooldown_states (endpoint_id, consecutive_failures, current_cooldown_ms, updated_at) VALUES (?, ?, ?, ?)",
        ["tx-node-1", 1, 60_000, 100],
      );
    });

    expect(adapter.all("SELECT * FROM evm_cooldown_states")).toHaveLength(1);

    expect(() => {
      adapter.transaction((tx) => {
        tx.run(
          "INSERT INTO evm_cooldown_states (endpoint_id, consecutive_failures, current_cooldown_ms, updated_at) VALUES (?, ?, ?, ?)",
          ["tx-node-2", 1, 60_000, 100],
        );
        throw new Error("force rollback");
      });
    }).toThrow("force rollback");

    expect(adapter.all("SELECT * FROM evm_cooldown_states")).toHaveLength(1);

    adapter.close();
  });
});

describe("SqliteCooldownStore", () => {
  it("saves, loads and deletes cooldown state records", () => {
    const adapter = new SqliteStorageAdapter({ path: ":memory:" });
    adapter.initialize();
    const store = new SqliteCooldownStore(adapter);

    expect(store.loadAll()).toHaveLength(0);

    store.save("node-a", {
      consecutiveFailures: 3,
      currentCooldownMs: 900_000,
      cooldownUntil: 2_000_000,
      firstFailureAt: 1_100_000,
      isCoolingDown: true,
      isMaxCooldown: false,
      totalCooldownDurationMs: 400_000,
    }, 1_500_000);

    const loaded = store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({
      endpointId: "node-a",
      consecutiveFailures: 3,
      currentCooldownMs: 900_000,
      cooldownUntil: 2_000_000,
      firstFailureAt: 1_100_000,
      updatedAt: 1_500_000,
    });

    store.delete("node-a");
    expect(store.loadAll()).toHaveLength(0);

    adapter.close();
  });
});
