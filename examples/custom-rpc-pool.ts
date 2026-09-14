import { createEvmCallClient } from "../src";

async function main(): Promise<void> {
  // Inject private high-tier endpoints alongside built-in high-availability fallbacks
  const client = createEvmCallClient({
    chainId: "ethereum",
    customRpcUrls: [
      process.env.ALCHEMY_RPC_URL ?? "https://eth-mainnet.g.alchemy.com/v2/demo",
      process.env.INFURA_RPC_URL ?? "https://mainnet.infura.io/v3/demo",
    ],
    // 10-level cooldown penalty settings (1m, 2m, 5m, 10m, ..., up to 24h)
    maxRpcAttempts: 5,
    attemptTimeoutMs: 8_000,
    totalTimeoutMs: 30_000,
  });

  console.log("=== Custom Pool & Health Probing ===");
  // Explicitly warm up pool and probe all endpoints
  await client.init();

  const healthy = client.getHealthyEndpoints();
  console.log(`Healthy RPC endpoints in pool: ${healthy.length}`);
  for (const ep of healthy) {
    console.log(`  - ${ep.id}`);
  }

  // Execute a query over randomly selected healthy endpoint
  const blockNumber = await client.call<string>({ id: "latest", method: "eth_blockNumber" });
  console.log("Latest block number:", blockNumber);

  client.close();
}

main().catch(console.error);
