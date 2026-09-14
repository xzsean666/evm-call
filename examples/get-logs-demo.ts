import { createEvmCallClient } from "../src";

async function main(): Promise<void> {
  // Initialize client with Ethereum mainnet (or Base)
  const client = createEvmCallClient({
    chainId: "ethereum",
  });

  const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  console.log("=== 1. Standard Single Query getLogs ===");
  const latestBlock = await client.findLatestBlockNumber();
  const latestNum = BigInt(latestBlock.blockNumber);
  console.log(`Current latest block: ${latestNum.toString(10)}`);

  // Query USDT Transfer events in the last 10 blocks
  const recentLogs = await client.getLogs({
    address: USDT_ADDRESS,
    topics: [TRANSFER_TOPIC],
    fromBlock: latestNum - 10n,
    toBlock: latestNum,
  });
  console.log(`Found ${recentLogs.length} logs in the last 10 blocks.`);

  console.log("\n=== 2. Large Block Range Query via getLogsChunked ===");
  // Automatically slices into chunks (e.g. 1,000 blocks per chunk), executes concurrently,
  // adaptively halves ranges if an RPC returns 10,000-results limits, and returns sorted logs.
  const chunkedLogs = await client.getLogsChunked(
    {
      address: USDT_ADDRESS,
      topics: [TRANSFER_TOPIC],
      fromBlock: latestNum - 200n,
      toBlock: latestNum,
    },
    {
      maxBlockRange: 100,
      chunkConcurrency: 2,
      onChunkProgress: (progress) => {
        console.log(
          `Chunk [${progress.fromBlock}..${progress.toBlock}] completed: +${progress.chunkLogsCount} logs (Total so far: ${progress.totalLogsSoFar})`,
        );
      },
    },
  );
  console.log(`Total collected logs: ${chunkedLogs.length}`);

  console.log("\n=== 3. Streaming Event Indexing via iterateLogs ===");
  // Stream logs chunk by chunk in sequential block order without keeping everything in memory.
  let totalStreamed = 0;
  for await (const chunk of client.iterateLogs(
    {
      address: USDT_ADDRESS,
      topics: [TRANSFER_TOPIC],
      fromBlock: latestNum - 50n,
      toBlock: latestNum,
    },
    { maxBlockRange: 25 },
  )) {
    totalStreamed += chunk.length;
    console.log(`Streamed chunk with ${chunk.length} logs.`);
  }
  console.log(`Finished streaming: ${totalStreamed} total logs processed.`);

  client.close();
}

main().catch(console.error);
