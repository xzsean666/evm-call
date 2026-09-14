import { createEvmCallClient } from "../src";

async function main(): Promise<void> {
  // Initialize client with Ethereum mainnet
  const client = createEvmCallClient({
    chainId: "ethereum",
  });

  console.log("=== 1. Batch Query Multiple Blocks in 1 RPC Batch ===");
  const latestBlock = await client.findLatestBlockNumber();
  const latestNum = BigInt(latestBlock.blockNumber);

  // Fetch 3 consecutive blocks in a single network roundtrip
  const blocks = await client.getBlocks([
    latestNum - 2n,
    latestNum - 1n,
    latestNum,
  ]);
  for (const block of blocks) {
    if (block) {
      console.log(`Block ${block.number}: hash = ${block.hash}, txs count = ${(block.transactions as unknown[])?.length}`);
    }
  }

  console.log("\n=== 2. Batch Query Multiple Transactions and Receipts ===");
  // Take first 3 transaction hashes from the latest block
  const txHashes = ((blocks[2]?.transactions as string[]) ?? []).slice(0, 3);
  if (txHashes.length > 0) {
    // Batch fetch transaction details
    const txs = await client.getTransactions(txHashes);
    console.log(`Fetched ${txs.length} transactions in batch.`);

    // Batch fetch transaction receipts
    const receipts = await client.getTransactionReceipts(txHashes);
    for (let i = 0; i < receipts.length; i += 1) {
      const r = receipts[i];
      console.log(`Tx ${txHashes[i]}: status = ${r?.status}, gasUsed = ${r?.gasUsed}`);
    }

    // Simultaneously fetch tx details and receipt in 1 roundtrip
    const combined = await client.getTransactionWithReceipt(txHashes[0]!);
    console.log(`Combined lookup for ${txHashes[0]}: tx.from = ${combined.transaction?.from}, rc.status = ${combined.receipt?.status}`);
  }

  console.log("\n=== 3. Block Receipts (with auto-fallback) ===");
  // Modern L2/nodes use eth_getBlockReceipts; legacy nodes automatically fallback to batch getTransactionReceipts
  const allReceipts = await client.getBlockReceipts(latestNum);
  console.log(`Block ${latestNum} has ${allReceipts.length} total receipts.`);

  console.log("\n=== 4. Batch Account Nonces & Contract Detection ===");
  const addresses = [
    "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", // Vitalik EOA
    "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT Contract
  ];

  // Batch query nonces
  const nonces = await client.getTransactionCounts(addresses);
  console.log(`Nonces: Vitalik = ${nonces[0]}, USDT = ${nonces[1]}`);

  // Batch query bytecode (identify contract vs EOA)
  const bytecodes = await client.getCodes(addresses);
  console.log(`Is Vitalik a contract? ${bytecodes[0] !== "0x"}`);
  console.log(`Is USDT a contract? ${bytecodes[1] !== "0x"}`);

  console.log("\n=== 5. Gas Estimation & EIP-1559 Fee History ===");
  const gasEstimate = await client.estimateGas({
    to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    value: 1000000000000000n, // 0.001 ETH
  });
  console.log(`Estimated gas for transfer: ${gasEstimate.toString(10)} gas`);

  const feeHistory = await client.getFeeHistory(4, "latest", [25, 50, 75]);
  console.log(`Oldest block in fee history: ${feeHistory.oldestBlock}`);
  console.log(`Base fee per gas (wei):`, feeHistory.baseFeePerGas.map((v) => v.toString(10)));

  client.close();
}

main().catch(console.error);
