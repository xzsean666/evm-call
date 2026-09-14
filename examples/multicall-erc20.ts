import { createEvmCallClient } from "../src";

const USDC_ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const DAI_ADDRESS = "0x6b175474e89094c44da98b954eedeac495271d0f";
const VITALIK_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

async function main(): Promise<void> {
  const client = createEvmCallClient({
    chainId: "ethereum",
  });

  console.log("=== Multicall3 ERC-20 Batch Query ===");

  // Batch query multiple tokens and accounts in a single RPC network roundtrip
  const result = await client.multicallErc20({
    chain: "ethereum",
    // blockNumber is optional: omitted defaults to latest block with auto-resolution
    calls: [
      { id: "usdc-name", tokenAddress: USDC_ADDRESS, method: "name" },
      { id: "usdc-symbol", tokenAddress: USDC_ADDRESS, method: "symbol" },
      { id: "usdc-decimals", tokenAddress: USDC_ADDRESS, method: "decimals" },
      { id: "usdc-vitalik-bal", tokenAddress: USDC_ADDRESS, method: "balanceOf", owner: VITALIK_ADDRESS },
      { id: "dai-name", tokenAddress: DAI_ADDRESS, method: "name" },
      { id: "dai-symbol", tokenAddress: DAI_ADDRESS, method: "symbol" },
      { id: "dai-vitalik-bal", tokenAddress: DAI_ADDRESS, method: "balanceOf", owner: VITALIK_ADDRESS },
    ],
  });

  console.log(`Executed across ${result.multicallBatches} batch at block ${result.blockNumber}`);
  console.log(`Block Hash: ${result.blockHash}`);
  console.log(`Block Timestamp: ${new Date(Number(result.blockTimestamp) * 1000).toISOString()}`);

  for (const item of result.results) {
    if (item.success) {
      console.log(`  [${item.id}] ${item.tokenAddress} -> ${item.method}: ${item.value}`);
    } else {
      console.error(`  [${item.id}] ${item.tokenAddress} -> ${item.method} failed with error: ${item.error}`);
    }
  }

  client.close();
}

main().catch(console.error);
