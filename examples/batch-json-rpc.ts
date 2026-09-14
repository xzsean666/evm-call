import { createEvmCallClient } from "../src";

async function main(): Promise<void> {
  // Initialize client with Ethereum mainnet and default SQLite cache at ./data/evm-call.db
  const client = createEvmCallClient({
    chainId: "ethereum",
  });

  console.log("=== 1. Generic Batch JSON-RPC Call ===");
  // Automatically slices into chunks (batchChunkSize: 100) and executes with bounded concurrency (3)
  const results = await client.batch([
    { id: "block-num", method: "eth_blockNumber" },
    { id: "gas-price", method: "eth_gasPrice" },
    { id: "chain-id", method: "eth_chainId" },
    {
      id: "vitalik-balance",
      method: "eth_getBalance",
      params: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"],
    },
  ]);

  for (const item of results) {
    if (item.success) {
      console.log(`[${item.id}] Result:`, item.result);
    } else {
      console.error(`[${item.id}] Error:`, item.error);
    }
  }

  console.log("\n=== 2. Strict Batch (Throws on first failure) ===");
  try {
    const strictResults = await client.strictBatch<string>([
      { id: "req-1", method: "eth_blockNumber" },
      { id: "req-2", method: "eth_chainId" },
    ]);
    console.log("Strict Results:", strictResults);
  } catch (error) {
    console.error("Strict batch failed:", error);
  }

  client.close();
}

main().catch(console.error);
