import { createEvmCallClient } from "../src";

async function main(): Promise<void> {
  const client = createEvmCallClient({
    chainId: "ethereum",
    storagePath: "./data/evm-call-cache-demo.db",
  });

  console.log("=== Tiered Caching Demonstration ===");

  // 1. Latest/Volatile calls (e.g. eth_blockNumber, eth_call at 'latest')
  // Default TTL: 10 seconds to prevent hammering RPCs while staying reasonably fresh
  console.log("Fetching latest block (1st time: network query)...");
  const block1 = await client.call<string>({ id: 1, method: "eth_blockNumber" });
  console.log("Block 1:", block1);

  console.log("Fetching latest block immediately (2nd time: hits 10s short-term cache)...");
  const block2 = await client.call<string>({ id: 2, method: "eth_blockNumber" });
  console.log("Block 2 (from cache):", block2);

  // Bypass cache explicitly when needed
  console.log("Fetching latest block with cacheTtlMs: 0 (bypasses cache)...");
  const block3 = await client.call<string>(
    { id: 3, method: "eth_blockNumber" },
    { cacheTtlMs: 0 },
  );
  console.log("Block 3 (forced refresh):", block3);

  // 2. Historical calls (specific block height / block hash)
  // Default TTL: 30 days because historical state is immutable
  console.log("\nFetching historical balance at block 18,000,000 (30-day cache)...");
  const balance = await client.call<string>({
    id: "hist-bal",
    method: "eth_getBalance",
    params: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "0x112a880"],
  });
  console.log("Historical Balance:", balance);

  // Clean expired records
  const cleaned = client.cleanExpiredCache();
  console.log(`Cleaned ${cleaned} expired cache entries from SQLite.`);

  client.close();
}

main().catch(console.error);
