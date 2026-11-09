#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import axios, { type AxiosInstance } from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const POOL_DIR = path.resolve(REPO_ROOT, "src", "pool");

// Standard Multicall3 contract deployed across EVM networks
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
// Multicall3 getBlockNumber() function selector: keccak256("getBlockNumber()").slice(0, 10)
const MULTICALL3_GET_BLOCK_NUMBER = "0x42cbb15c";

export interface ChainMetadata {
  readonly chainId: number;
  readonly name: string;
  readonly slug: string;
  readonly fileBasename: string;
  readonly constantName: string;
  readonly aliases: readonly string[];
  readonly isTestnet?: boolean;
}

export const KNOWN_CHAINS: readonly ChainMetadata[] = [
  // --- Mainnets ---
  {
    chainId: 1,
    name: "Ethereum Mainnet",
    slug: "ethereum",
    fileBasename: "builtinEthereumRpcs.ts",
    constantName: "BUILTIN_ETHEREUM_RPCS",
    aliases: ["1", "eth", "ethereum", "mainnet"],
    isTestnet: false,
  },
  {
    chainId: 8453,
    name: "Base",
    slug: "base",
    fileBasename: "builtinBaseRpcs.ts",
    constantName: "BUILTIN_BASE_RPCS",
    aliases: ["8453", "base"],
    isTestnet: false,
  },
  {
    chainId: 42161,
    name: "Arbitrum One",
    slug: "arbitrum",
    fileBasename: "builtinArbitrumRpcs.ts",
    constantName: "BUILTIN_ARBITRUM_RPCS",
    aliases: ["42161", "arbitrum", "arbitrum-one", "arb"],
    isTestnet: false,
  },
  {
    chainId: 10,
    name: "Optimism",
    slug: "optimism",
    fileBasename: "builtinOptimismRpcs.ts",
    constantName: "BUILTIN_OPTIMISM_RPCS",
    aliases: ["10", "optimism", "op"],
    isTestnet: false,
  },
  {
    chainId: 137,
    name: "Polygon PoS",
    slug: "polygon",
    fileBasename: "builtinPolygonRpcs.ts",
    constantName: "BUILTIN_POLYGON_RPCS",
    aliases: ["137", "polygon", "matic"],
    isTestnet: false,
  },
  {
    chainId: 56,
    name: "BNB Smart Chain",
    slug: "bsc",
    fileBasename: "builtinBscRpcs.ts",
    constantName: "BUILTIN_BSC_RPCS",
    aliases: ["56", "bsc", "binance", "bnb"],
    isTestnet: false,
  },
  {
    chainId: 43114,
    name: "Avalanche C-Chain",
    slug: "avalanche",
    fileBasename: "builtinAvalancheRpcs.ts",
    constantName: "BUILTIN_AVALANCHE_RPCS",
    aliases: ["43114", "avalanche", "avax"],
    isTestnet: false,
  },
  {
    chainId: 59144,
    name: "Linea",
    slug: "linea",
    fileBasename: "builtinLineaRpcs.ts",
    constantName: "BUILTIN_LINEA_RPCS",
    aliases: ["59144", "linea"],
    isTestnet: false,
  },
  {
    chainId: 534352,
    name: "Scroll",
    slug: "scroll",
    fileBasename: "builtinScrollRpcs.ts",
    constantName: "BUILTIN_SCROLL_RPCS",
    aliases: ["534352", "scroll"],
    isTestnet: false,
  },
  {
    chainId: 1868,
    name: "Soneium Mainnet",
    slug: "soneium",
    fileBasename: "builtinSoneiumRpcs.ts",
    constantName: "BUILTIN_SONEIUM_RPCS",
    aliases: ["1868", "soneium"],
    isTestnet: false,
  },
  {
    chainId: 100,
    name: "Gnosis",
    slug: "gnosis",
    fileBasename: "builtinGnosisRpcs.ts",
    constantName: "BUILTIN_GNOSIS_RPCS",
    aliases: ["100", "gnosis", "xdai"],
    isTestnet: false,
  },
  {
    chainId: 250,
    name: "Fantom Opera",
    slug: "fantom",
    fileBasename: "builtinFantomRpcs.ts",
    constantName: "BUILTIN_FANTOM_RPCS",
    aliases: ["250", "fantom", "ftm"],
    isTestnet: false,
  },
  {
    chainId: 324,
    name: "zkSync Era",
    slug: "zksync",
    fileBasename: "builtinZkSyncRpcs.ts",
    constantName: "BUILTIN_ZKSYNC_RPCS",
    aliases: ["324", "zksync", "era"],
    isTestnet: false,
  },

  // --- Popular Testnets ---
  {
    chainId: 1946,
    name: "Soneium Minato Testnet",
    slug: "soneium-minato",
    fileBasename: "builtinSoneiumMinatoRpcs.ts",
    constantName: "BUILTIN_SONEIUM_MINATO_RPCS",
    aliases: ["1946", "minato", "soneium-minato"],
    isTestnet: true,
  },
  {
    chainId: 11155111,
    name: "Ethereum Sepolia",
    slug: "sepolia",
    fileBasename: "builtinSepoliaRpcs.ts",
    constantName: "BUILTIN_SEPOLIA_RPCS",
    aliases: ["11155111", "sepolia", "eth-sepolia"],
    isTestnet: true,
  },
  {
    chainId: 17000,
    name: "Ethereum Holesky",
    slug: "holesky",
    fileBasename: "builtinHoleskyRpcs.ts",
    constantName: "BUILTIN_HOLESKY_RPCS",
    aliases: ["17000", "holesky", "eth-holesky"],
    isTestnet: true,
  },
  {
    chainId: 84532,
    name: "Base Sepolia",
    slug: "base-sepolia",
    fileBasename: "builtinBaseSepoliaRpcs.ts",
    constantName: "BUILTIN_BASE_SEPOLIA_RPCS",
    aliases: ["84532", "base-sepolia"],
    isTestnet: true,
  },
  {
    chainId: 421614,
    name: "Arbitrum Sepolia",
    slug: "arbitrum-sepolia",
    fileBasename: "builtinArbitrumSepoliaRpcs.ts",
    constantName: "BUILTIN_ARBITRUM_SEPOLIA_RPCS",
    aliases: ["421614", "arbitrum-sepolia", "arb-sepolia"],
    isTestnet: true,
  },
  {
    chainId: 11155420,
    name: "OP Sepolia",
    slug: "op-sepolia",
    fileBasename: "builtinOpSepoliaRpcs.ts",
    constantName: "BUILTIN_OP_SEPOLIA_RPCS",
    aliases: ["11155420", "op-sepolia", "optimism-sepolia"],
    isTestnet: true,
  },
  {
    chainId: 80002,
    name: "Polygon Amoy",
    slug: "polygon-amoy",
    fileBasename: "builtinPolygonAmoyRpcs.ts",
    constantName: "BUILTIN_POLYGON_AMOY_RPCS",
    aliases: ["80002", "amoy", "polygon-amoy"],
    isTestnet: true,
  },
  {
    chainId: 97,
    name: "BNB Chain Testnet",
    slug: "bsc-testnet",
    fileBasename: "builtinBscTestnetRpcs.ts",
    constantName: "BUILTIN_BSC_TESTNET_RPCS",
    aliases: ["97", "bsc-testnet", "chapel"],
    isTestnet: true,
  },
  {
    chainId: 43113,
    name: "Avalanche Fuji",
    slug: "avalanche-fuji",
    fileBasename: "builtinAvalancheFujiRpcs.ts",
    constantName: "BUILTIN_AVALANCHE_FUJI_RPCS",
    aliases: ["43113", "fuji", "avax-fuji"],
    isTestnet: true,
  },
  {
    chainId: 10143,
    name: "Monad Testnet",
    slug: "monad-testnet",
    fileBasename: "builtinMonadTestnetRpcs.ts",
    constantName: "BUILTIN_MONAD_TESTNET_RPCS",
    aliases: ["10143", "monad-testnet", "monad"],
    isTestnet: true,
  },
];

// Fallback RPC Presets
const FALLBACK_RPCS: Record<number, string[]> = {
  1868: [
    "https://lb.routeme.sh/rpc/evm/1868",
    "https://rpc.nodeflare.app/soneium/public",
    "https://rpc.soneium.org",
    "https://soneium.drpc.org",
    "https://soneium-mainnet.rpc.sentio.xyz",
    "https://rpc.swiftnodes.io/rpc/soneium",
  ],
  1946: [
    "https://rpc.minato.soneium.org",
    "https://soneium-minato.drpc.org",
    "https://lb.routeme.sh/rpc/evm/1946",
    "https://soneium-minato.rpc.sentio.xyz",
  ],
};

export interface CandidateEndpoint {
  readonly url: string;
  readonly source: "chainlist" | "ethereum-lists" | "existing-builtin" | "preset-fallback";
}

export interface PreflightResult {
  readonly url: string;
  readonly chainIdValid: boolean;
  readonly archiveSupported: boolean;
  readonly multicallSupported: boolean;
  readonly tag: "archive" | "full";
  readonly error?: string;
}

export interface LatencyPercentiles {
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
}

export interface BenchmarkStats {
  readonly url: string;
  readonly tag: "archive" | "full";
  readonly multicallSupported: boolean;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  availabilityRate: number;
  latencies: number[];
  latencyPercentiles: LatencyPercentiles;
  latestBlock: number | null;
  blockLags: number[];
  avgBlockLag: number;
  flappingCount: number;
  rateLimitHits: number;
  disqualifiedReasons: string[];
  score: number;
  rank?: number;
}

export interface CliOptions {
  chainInput: string;
  durationSeconds: number;
  topCount: number; // 0 = all qualified
  intervalMs: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  let chainInput = "";
  let durationSeconds = 60;
  let topCount = 0; // Default 0: include ALL qualified endpoints!
  let intervalMs = 3000;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--chain") {
      chainInput = args[++i] || "";
    } else if (arg.startsWith("--chain=")) {
      chainInput = arg.split("=")[1];
    } else if (arg === "-d" || arg === "--duration") {
      durationSeconds = Math.max(5, parseInt(args[++i] || "60", 10));
    } else if (arg.startsWith("--duration=")) {
      durationSeconds = Math.max(5, parseInt(arg.split("=")[1], 10));
    } else if (arg === "-n" || arg === "--top") {
      topCount = Math.max(0, parseInt(args[++i] || "0", 10));
    } else if (arg.startsWith("--top=")) {
      topCount = Math.max(0, parseInt(arg.split("=")[1], 10));
    } else if (arg === "--interval") {
      intervalMs = Math.max(1000, parseInt(args[++i] || "3000", 10));
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
  }

  if (!chainInput) {
    console.error("❌ Error: Missing required --chain argument.\n");
    printHelp();
    process.exit(1);
  }

  return { chainInput, durationSeconds, topCount, intervalMs, dryRun, force };
}

function printHelp() {
  console.log(`
Usage:
  node scripts/update-builtin-rpcs.ts --chain <chain-name-or-id> [options]

Examples:
  node scripts/update-builtin-rpcs.ts --chain bsc
  node scripts/update-builtin-rpcs.ts --chain polygon --duration 60
  node scripts/update-builtin-rpcs.ts --chain arbitrum --dry-run
  node scripts/update-builtin-rpcs.ts --chain 1946 --top 10

Options:
  -c, --chain <chain>       Target chain name or chain ID (e.g. "bsc", "polygon", "arbitrum", "minato", "sepolia")
  -d, --duration <seconds>  Duration for the endurance benchmark in seconds (default: 60)
  -n, --top <count>         Limit to top N endpoints (default: 0 = ALL qualified endpoints that pass the test)
  --interval <ms>           Polling interval between rounds (default: 3000ms)
  --dry-run                 Run benchmark and show report without writing file
  --force                   Write file even if fewer than 2 RPCs pass the strict threshold
  -h, --help                Show this help message
`);
}

function createMetadataFromNameAndId(name: string, chainId: number): ChainMetadata {
  const safeSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const pascalName = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  const upperName = safeSlug.replace(/-/g, "_").toUpperCase();
  const isTestnet = /testnet|sepolia|holesky|goerli|amoy|fuji|devnet|minato|mumbai/i.test(name);

  return {
    chainId,
    name,
    slug: safeSlug,
    fileBasename: `builtin${pascalName}Rpcs.ts`,
    constantName: `BUILTIN_${upperName}_RPCS`,
    aliases: [chainId.toString(), safeSlug],
    isTestnet,
  };
}

async function resolveChain(chainInput: string): Promise<ChainMetadata> {
  const normalized = chainInput.trim().toLowerCase();

  // 1. Direct match against KNOWN_CHAINS
  const found = KNOWN_CHAINS.find(
    (c) => c.slug === normalized || c.chainId.toString() === normalized || c.aliases.includes(normalized),
  );
  if (found) {
    return found;
  }

  // 2. Numeric chain ID lookup from ethereum-lists
  const parsedId = parseInt(normalized, 10);
  if (!isNaN(parsedId) && parsedId > 0) {
    try {
      console.log(`🔍 Chain ID ${parsedId} not in local presets, querying ethereum-lists...`);
      const res = await axios.get(
        `https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-${parsedId}.json`,
        { timeout: 8000 },
      );
      if (res.data && res.data.name) {
        return createMetadataFromNameAndId(String(res.data.name).trim(), parsedId);
      }
    } catch {
      // Continue to next strategy
    }

    return {
      chainId: parsedId,
      name: `Chain ${parsedId}`,
      slug: `chain-${parsedId}`,
      fileBasename: `builtinChain${parsedId}Rpcs.ts`,
      constantName: `BUILTIN_CHAIN_${parsedId}_RPCS`,
      aliases: [parsedId.toString()],
      isTestnet: false,
    };
  }

  // 3. Dynamic search in chainid.network
  try {
    console.log(`🔍 Searching for chain "${chainInput}" in global chainid.network registry...`);
    const res = await axios.get("https://chainid.network/chains.json", { timeout: 10000 });
    if (Array.isArray(res.data)) {
      interface ChainRecord {
        chainId: number;
        name: string;
        shortName?: string;
        chain?: string;
      }
      const chains = res.data as ChainRecord[];

      const exactMatch = chains.find(
        (c) =>
          c.shortName?.toLowerCase() === normalized ||
          c.name.toLowerCase() === normalized ||
          c.chain?.toLowerCase() === normalized,
      );

      const fuzzyMatch =
        exactMatch ||
        chains.find(
          (c) =>
            c.name.toLowerCase().includes(normalized) ||
            (c.shortName && c.shortName.toLowerCase().includes(normalized)),
        );

      if (fuzzyMatch && fuzzyMatch.chainId) {
        console.log(`✓ Resolved "${chainInput}" -> [${fuzzyMatch.chainId}] ${fuzzyMatch.name}`);
        return createMetadataFromNameAndId(fuzzyMatch.name, fuzzyMatch.chainId);
      }
    }
  } catch (err) {
    console.warn(`[WARN] chainid.network query failed: ${(err as Error).message}`);
  }

  throw new Error(`Unable to resolve chain "${chainInput}". Please provide a valid Chain ID or supported chain name.`);
}

async function fetchCandidateEndpoints(chain: ChainMetadata): Promise<CandidateEndpoint[]> {
  const candidates: CandidateEndpoint[] = [];
  const seenUrls = new Set<string>();

  const addUrl = (rawUrl: string, source: CandidateEndpoint["source"]) => {
    if (!rawUrl || typeof rawUrl !== "string") return;
    let url = rawUrl.trim();

    if (!url.startsWith("https://")) return;

    if (url.includes("${") || url.includes("API_KEY") || url.includes("YOUR-API-KEY") || url.includes("your-key")) {
      return;
    }

    url = url.replace(/\/+$/, "");

    try {
      const parsed = new URL(url);
      if (parsed.search || parsed.hash || parsed.username || parsed.password) return;
      if (["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname)) return;

      const key = url.toLowerCase();
      if (!seenUrls.has(key)) {
        seenUrls.add(key);
        candidates.push({ url, source });
      }
    } catch {
      // ignore
    }
  };

  // 1. Existing file in src/pool
  const existingFilePath = path.join(POOL_DIR, chain.fileBasename);
  if (fs.existsSync(existingFilePath)) {
    try {
      const content = fs.readFileSync(existingFilePath, "utf-8");
      const urlMatches = content.match(/url:\s*"(https:\/\/[^"]+)"/g);
      if (urlMatches) {
        for (const match of urlMatches) {
          const u = match.replace(/url:\s*"/, "").replace(/"$/, "");
          addUrl(u, "existing-builtin");
        }
      }
    } catch (e) {
      console.warn(`[WARN] Could not parse existing builtins: ${(e as Error).message}`);
    }
  }

  // 2. Preset Fallbacks
  const presets = FALLBACK_RPCS[chain.chainId];
  if (presets) {
    for (const url of presets) {
      addUrl(url, "preset-fallback");
    }
  }

  // 3. Chainlist.org
  try {
    console.log(`🌐 Fetching live RPC endpoints from chainlist.org/chain/${chain.chainId}...`);
    const res = await axios.get(`https://chainlist.org/chain/${chain.chainId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeout: 10000,
    });

    if (res.status === 200 && typeof res.data === "string") {
      const match = res.data.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (match && match[1]) {
        const nextData = JSON.parse(match[1]);
        const rpcList = nextData?.props?.pageProps?.chain?.rpc;
        if (Array.isArray(rpcList)) {
          for (const item of rpcList) {
            const url = typeof item === "string" ? item : item?.url;
            addUrl(url, "chainlist");
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[WARN] Chainlist fetch failed: ${(err as Error).message}`);
  }

  // 4. Ethereum-lists fallback
  try {
    console.log(`🌐 Fetching fallback RPC endpoints from ethereum-lists/chains for chain ${chain.chainId}...`);
    const res = await axios.get(
      `https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-${chain.chainId}.json`,
      { timeout: 8000 },
    );
    if (res.status === 200 && res.data && Array.isArray(res.data.rpc)) {
      for (const item of res.data.rpc) {
        const url = typeof item === "string" ? item : item?.url;
        addUrl(url, "ethereum-lists");
      }
    }
  } catch (err) {
    console.warn(`[WARN] Ethereum-lists fetch failed: ${(err as Error).message}`);
  }

  return candidates;
}

async function rpcCall(
  client: AxiosInstance,
  url: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 4000,
): Promise<{ success: boolean; result?: unknown; error?: string; status?: number; latencyMs: number }> {
  const start = performance.now();
  try {
    const res = await client.post(
      url,
      {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1000000),
        method,
        params,
      },
      {
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      },
    );

    const latencyMs = Math.round(performance.now() - start);

    if (res.status !== 200) {
      return { success: false, status: res.status, error: `HTTP ${res.status}`, latencyMs };
    }

    if (res.data?.error) {
      return {
        success: false,
        status: res.status,
        error: `RPC Error ${res.data.error.code}: ${res.data.error.message}`,
        latencyMs,
      };
    }

    return { success: true, result: res.data?.result, latencyMs };
  } catch (err: unknown) {
    const latencyMs = Math.round(performance.now() - start);
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const msg = err.code === "ECONNABORTED" ? `Timeout after ${timeoutMs}ms` : err.message;
      return { success: false, status, error: status ? `HTTP ${status}` : msg, latencyMs };
    }
    return { success: false, error: (err as Error).message, latencyMs };
  }
}

async function runPreflight(
  client: AxiosInstance,
  candidate: CandidateEndpoint,
  expectedChainId: number,
): Promise<PreflightResult> {
  // 1. Verify chain ID
  const chainIdCall = await rpcCall(client, candidate.url, "eth_chainId", [], 4000);
  if (!chainIdCall.success || typeof chainIdCall.result !== "string") {
    return {
      url: candidate.url,
      chainIdValid: false,
      archiveSupported: false,
      multicallSupported: false,
      tag: "full",
      error: chainIdCall.error || "eth_chainId returned invalid response",
    };
  }

  const reportedChainId = parseInt(chainIdCall.result, 16);
  if (reportedChainId !== expectedChainId) {
    return {
      url: candidate.url,
      chainIdValid: false,
      archiveSupported: false,
      multicallSupported: false,
      tag: "full",
      error: `Chain ID mismatch (reported ${reportedChainId}, expected ${expectedChainId})`,
    };
  }

  // 2. Check Archive capability (Block 1 query)
  let archiveSupported = false;
  try {
    const archiveCall = await rpcCall(client, candidate.url, "eth_getBlockByNumber", ["0x1", false], 4000);
    if (archiveCall.success && archiveCall.result && typeof archiveCall.result === "object") {
      archiveSupported = true;
    }
  } catch {
    archiveSupported = false;
  }

  // 3. Check Multicall3 capability
  let multicallSupported = false;
  try {
    const mcCall = await rpcCall(
      client,
      candidate.url,
      "eth_call",
      [{ to: MULTICALL3_ADDRESS, data: MULTICALL3_GET_BLOCK_NUMBER }, "latest"],
      4000,
    );
    if (mcCall.success && typeof mcCall.result === "string" && mcCall.result.length === 66) {
      multicallSupported = true;
    }
  } catch {
    multicallSupported = false;
  }

  return {
    url: candidate.url,
    chainIdValid: true,
    archiveSupported,
    multicallSupported,
    tag: archiveSupported ? "archive" : "full",
  };
}

function calculatePercentiles(latencies: number[]): LatencyPercentiles {
  if (latencies.length === 0) {
    return { min: 0, max: 0, avg: 0, p50: 0, p95: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const avg = Math.round(sum / sorted.length);

  const getPercentile = (p: number) => {
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    if (lower === upper) return sorted[lower];
    return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
  };

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    p50: getPercentile(50),
    p95: getPercentile(95),
  };
}

/**
 * Score Calculation (0 - 100):
 * Prioritizes Archive nodes (+10 pts) and Multicall3 support (+5 pts)
 */
function calculateCompositeScore(stats: BenchmarkStats): number {
  if (stats.successCalls === 0 || stats.disqualifiedReasons.length > 0) {
    return 0;
  }

  // 1. Availability (max 40 pts)
  const availabilityScore = (stats.availabilityRate / 100) * 40;

  // 2. Latency (max 35 pts)
  const p50 = stats.latencyPercentiles.p50;
  let latencyScore = 0;
  if (p50 > 0) {
    if (p50 <= 200) latencyScore = 35;
    else if (p50 <= 400) latencyScore = 35 - ((p50 - 200) / 200) * 6;
    else if (p50 <= 700) latencyScore = 29 - ((p50 - 400) / 300) * 9;
    else if (p50 <= 1000) latencyScore = 20 - ((p50 - 700) / 300) * 10;
    else latencyScore = Math.max(0, 10 - ((p50 - 1000) / 500) * 10);
  }

  // Jitter penalty
  const jitter = Math.max(0, stats.latencyPercentiles.p95 - p50);
  if (jitter > 400) {
    latencyScore = Math.max(0, latencyScore - Math.min(6, ((jitter - 400) / 400) * 3));
  }

  // 3. Block Freshness (max 25 pts)
  let freshnessScore = 0;
  if (stats.avgBlockLag <= 0.2) freshnessScore = 25;
  else if (stats.avgBlockLag <= 1.0) freshnessScore = 23 - (stats.avgBlockLag * 3);
  else if (stats.avgBlockLag <= 2.5) freshnessScore = 20 - ((stats.avgBlockLag - 1.0) * 4);
  else freshnessScore = Math.max(0, 14 - (stats.avgBlockLag * 3));

  let total = availabilityScore + latencyScore + freshnessScore;

  // First-Class Archive capability bonus (+10 pts for historical archive access)
  if (stats.tag === "archive") total += 10;
  // Multicall support bonus
  if (stats.multicallSupported) total += 5;

  return Math.round(Math.min(100, Math.max(0, total)) * 10) / 10;
}

/**
 * Generate clean, unique, alphanumeric ID conforming to /^[a-z0-9-]+$/
 */
function generateEndpointId(url: string, chainSlug: string, existingIds: Set<string>): string {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  const hostParts = hostname.split(".").filter(Boolean);
  const pathPart = parsed.pathname.replace(/\/+$/, "").replace(/^\/+/, "").toLowerCase();

  const ignored = new Set([
    "com", "org", "net", "io", "app", "xyz", "network", "cloud", "co", "me", "dev", "pro",
    "public", "mainnet", "testnet", "rpc", "evm", "api", "gateway", "v1", "node", "nodes"
  ]);

  const meaningful = hostParts
    .map((p) => p.split("-"))
    .flat()
    .filter((p) => !ignored.has(p) && !chainSlug.includes(p));

  let provider = meaningful[meaningful.length - 1] || meaningful[0];
  if (!provider || provider.length < 2) {
    provider = hostParts[0].replace(/[^a-z0-9]/g, "");
  }

  // Include meaningful sub-path if present (e.g. maxbackrun, fullprivacy)
  const cleanPath = pathPart.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let baseId = `${chainSlug}-${provider}`;
  if (cleanPath && cleanPath !== chainSlug && cleanPath !== "rpc" && !baseId.includes(cleanPath)) {
    baseId = `${baseId}-${cleanPath}`;
  }

  baseId = baseId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (baseId === chainSlug) {
    baseId = `${chainSlug}-org-public`;
  }

  let finalId = baseId;
  let counter = 2;
  while (existingIds.has(finalId)) {
    finalId = `${baseId}-${counter}`;
    counter++;
  }
  existingIds.add(finalId);
  return finalId;
}

async function runBenchmark(chain: ChainMetadata, options: CliOptions) {
  console.log("==========================================================================");
  console.log(`🚀 EVM Builtin RPC Benchmark & Generator`);
  console.log(`🎯 Chain: [${chain.chainId}] ${chain.name} (${chain.slug}) ${chain.isTestnet ? "[Testnet]" : "[Mainnet]"}`);
  const targetDesc = options.topCount > 0 ? `Top ${options.topCount} RPCs` : `ALL Qualified RPCs`;
  console.log(`⏱️ Duration: ${options.durationSeconds}s | Target: ${targetDesc} | Interval: ${options.intervalMs}ms`);
  console.log("==========================================================================\n");

  const client = axios.create({
    headers: {
      "User-Agent": "evm-call-benchmark/1.0",
    },
  });

  // 1. Fetch Candidates
  const rawCandidates = await fetchCandidateEndpoints(chain);
  console.log(`\n📋 Discovered ${rawCandidates.length} potential RPC endpoints.`);
  if (rawCandidates.length === 0) {
    throw new Error(`No RPC endpoints found for chain ${chain.chainId}.`);
  }

  // 2. Preflight Smoke Tests
  console.log(`\n🩺 Stage 1: Running Preflight Health & Capability Checks...`);
  const preflightResults: PreflightResult[] = [];
  const preflightConcurrency = 8;

  for (let i = 0; i < rawCandidates.length; i += preflightConcurrency) {
    const chunk = rawCandidates.slice(i, i + preflightConcurrency);
    const chunkResults = await Promise.all(chunk.map((c) => runPreflight(client, c, chain.chainId)));
    preflightResults.push(...chunkResults);
    process.stdout.write(`\r[Preflight] Progress: ${Math.min(i + preflightConcurrency, rawCandidates.length)} / ${rawCandidates.length}`);
  }
  process.stdout.write("\n");

  const passedPreflight = preflightResults.filter((p) => p.chainIdValid);
  console.log(`✓ Preflight complete: ${passedPreflight.length} / ${rawCandidates.length} endpoints active & verified.`);

  if (passedPreflight.length === 0) {
    throw new Error(`All candidate RPCs failed preflight checks for Chain ${chain.chainId}.`);
  }

  // Check if Multicall3 is deployed on this chain
  const chainHasMulticall3 = passedPreflight.some((p) => p.multicallSupported);
  if (!chainHasMulticall3) {
    console.log(`ℹ️ Multicall3 contract not detected at ${MULTICALL3_ADDRESS} on this network. Skipping strict multicall requirement.`);
  }

  // 3. Stage 2: Endurance Benchmark in Waves
  console.log(`\n⏱️ Stage 2: Starting ${options.durationSeconds}-Second Endurance Benchmark...`);
  console.log(`   (Tracking availability, block height sync, jitter, 429 throttling, and flapping)`);

  const statsMap = new Map<string, BenchmarkStats>();
  for (const p of passedPreflight) {
    statsMap.set(p.url, {
      url: p.url,
      tag: p.tag,
      multicallSupported: p.multicallSupported,
      totalCalls: 0,
      successCalls: 0,
      failedCalls: 0,
      availabilityRate: 100,
      latencies: [],
      latencyPercentiles: { min: 0, max: 0, avg: 0, p50: 0, p95: 0 },
      latestBlock: null,
      blockLags: [],
      avgBlockLag: 0,
      flappingCount: 0,
      rateLimitHits: 0,
      disqualifiedReasons: [],
      score: 0,
    });
  }

  const startTime = Date.now();
  const endTime = startTime + options.durationSeconds * 1000;
  let roundNumber = 0;

  while (Date.now() < endTime) {
    roundNumber++;
    const roundStart = Date.now();
    const remainingSec = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);

    const endpoints = Array.from(statsMap.values());

    // Wave execution: query ALL endpoints concurrently at the same instant
    const waveResults = await Promise.all(
      endpoints.map(async (stat) => {
        const call = await rpcCall(client, stat.url, "eth_blockNumber", [], 4000);
        return { stat, call };
      }),
    );

    // Identify blocks reported in this wave
    const waveBlocks: number[] = [];
    for (const { stat, call } of waveResults) {
      stat.totalCalls++;
      if (call.success && typeof call.result === "string") {
        stat.successCalls++;
        stat.latencies.push(call.latencyMs);

        const blockNum = parseInt(call.result, 16);
        if (!isNaN(blockNum)) {
          waveBlocks.push(blockNum);
          if (stat.latestBlock !== null && blockNum < stat.latestBlock) {
            stat.flappingCount++;
          }
          stat.latestBlock = blockNum;
        }
      } else {
        stat.failedCalls++;
        if (call.status === 429) {
          stat.rateLimitHits++;
        }
      }
    }

    // Determine cluster consensus head block for this wave
    if (waveBlocks.length > 0) {
      const sortedBlocks = [...waveBlocks].sort((a, b) => a - b);
      const clusterPeak = sortedBlocks[Math.min(sortedBlocks.length - 1, Math.floor(sortedBlocks.length * 0.95))];

      for (const { stat, call } of waveResults) {
        if (call.success && stat.latestBlock !== null) {
          const lag = Math.max(0, clusterPeak - stat.latestBlock);
          stat.blockLags.push(lag);
        }
      }
    }

    process.stdout.write(
      `\r[Benchmark ${elapsedSec}s / ${options.durationSeconds}s] Wave #${roundNumber} | Active RPCs: ${endpoints.length} | Cluster Head: #${waveBlocks.length > 0 ? Math.max(...waveBlocks) : "syncing"} | Remaining: ${remainingSec}s `,
    );

    const elapsedRound = Date.now() - roundStart;
    const waitTime = Math.max(0, options.intervalMs - elapsedRound);
    if (Date.now() + waitTime < endTime) {
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  process.stdout.write("\n\n📊 Stage 3: Statistical Analysis & Quality Gate...\n");

  // 4. Quality Gate & Strict Filtering ("不要那种很差的rpc")
  const allStats = Array.from(statsMap.values());
  for (const stat of allStats) {
    stat.availabilityRate = stat.totalCalls > 0 ? Math.round((stat.successCalls / stat.totalCalls) * 1000) / 10 : 0;
    stat.latencyPercentiles = calculatePercentiles(stat.latencies);
    stat.avgBlockLag =
      stat.blockLags.length > 0
        ? Math.round((stat.blockLags.reduce((a, b) => a + b, 0) / stat.blockLags.length) * 10) / 10
        : 99;

    // Rule 1: Minimum Availability >= 95%
    if (stat.availabilityRate < 95) {
      stat.disqualifiedReasons.push(`Low availability (${stat.availabilityRate}% < 95%)`);
    }

    // Rule 2: Zero Tolerance for HTTP 429 Rate Limits
    if (stat.rateLimitHits > 0) {
      stat.disqualifiedReasons.push(`Rate limited (Encountered HTTP 429)`);
    }

    // Rule 3: Zero Tolerance for Cluster Flapping / Reversals
    if (stat.flappingCount > 0) {
      stat.disqualifiedReasons.push(`Load balancer flapping (${stat.flappingCount} block regression events)`);
    }

    // Rule 4: Sync Lag <= 5.0 blocks
    if (stat.avgBlockLag > 5.0) {
      stat.disqualifiedReasons.push(`Out of sync (Avg lag ${stat.avgBlockLag} blocks > 5.0)`);
    }

    // Rule 5: Median Latency <= 1500ms
    if (stat.latencyPercentiles.p50 > 1500) {
      stat.disqualifiedReasons.push(`Excessive latency (P50: ${stat.latencyPercentiles.p50}ms > 1500ms)`);
    }

    // Rule 6: Multicall3 contract call (if chain supports Multicall3)
    if (chainHasMulticall3 && !stat.multicallSupported) {
      stat.disqualifiedReasons.push(`Multicall3 eth_call unsupported`);
    }

    stat.score = calculateCompositeScore(stat);
  }

  // Sort candidates: qualified first (by score descending, archive nodes boosted), then disqualified
  const sorted = [...allStats].sort((a, b) => {
    if (a.disqualifiedReasons.length === 0 && b.disqualifiedReasons.length > 0) return -1;
    if (a.disqualifiedReasons.length > 0 && b.disqualifiedReasons.length === 0) return 1;
    return b.score - a.score;
  });

  // Assign ranks
  sorted.forEach((item, index) => {
    item.rank = index + 1;
  });

  // Output Leaderboard Table
  console.log("--------------------------------------------------------------------------------------------------------------------------------");
  console.log(
    `| ${"Rank".padEnd(4)} | ${"URL".padEnd(45)} | ${"Avail %".padEnd(8)} | ${"P50".padEnd(7)} | ${"P95".padEnd(7)} | ${"Lag".padEnd(6)} | ${"Tag".padEnd(7)} | ${"Score".padEnd(6)} | ${"Status".padEnd(20)} |`,
  );
  console.log("--------------------------------------------------------------------------------------------------------------------------------");

  for (const s of sorted) {
    const statusText = s.disqualifiedReasons.length === 0 ? "✅ QUALIFIED" : `❌ ${s.disqualifiedReasons[0]}`;
    console.log(
      `| ${String(s.rank).padEnd(4)} | ${s.url.slice(0, 45).padEnd(45)} | ${(s.availabilityRate + "%").padEnd(8)} | ${(s.latencyPercentiles.p50 + "ms").padEnd(7)} | ${(s.latencyPercentiles.p95 + "ms").padEnd(7)} | ${s.avgBlockLag.toFixed(1).padEnd(6)} | ${s.tag.padEnd(7)} | ${s.score.toFixed(1).padEnd(6)} | ${statusText.slice(0, 26).padEnd(20)} |`,
    );
  }
  console.log("--------------------------------------------------------------------------------------------------------------------------------\n");

  const qualifiedList = sorted.filter((s) => s.disqualifiedReasons.length === 0);
  const archiveCount = qualifiedList.filter((s) => s.tag === "archive").length;
  const fullCount = qualifiedList.filter((s) => s.tag === "full").length;
  console.log(`🏆 Qualified High-Performance Endpoints: ${qualifiedList.length} / ${sorted.length} (Archive: ${archiveCount}, Full: ${fullCount})`);

  let selectedEndpoints: BenchmarkStats[] = [];

  if (qualifiedList.length >= 2) {
    // If topCount > 0, take top N; otherwise take ALL qualified endpoints!
    selectedEndpoints = options.topCount > 0 ? qualifiedList.slice(0, options.topCount) : qualifiedList;
  } else if (options.force || qualifiedList.length > 0) {
    console.warn(`\n⚠️ [WARNING] Only ${qualifiedList.length} endpoint passed strict filtering.`);
    selectedEndpoints = options.topCount > 0 ? sorted.slice(0, Math.max(2, options.topCount)) : sorted;
  } else {
    throw new Error(
      `No endpoints passed strict quality thresholds for Chain ${chain.chainId}. Benchmark failed to meet quality standards. (Use --force if you wish to override)`,
    );
  }

  // 5. Code Generation & Overwrite
  const targetFilePath = path.join(POOL_DIR, chain.fileBasename);
  console.log(`\n💾 Stage 4: Writing Builtin RPC Registry -> ${targetFilePath}`);
  console.log(`   (Selected: ${selectedEndpoints.length} endpoints | Archive: ${selectedEndpoints.filter(e => e.tag === "archive").length} | Full: ${selectedEndpoints.filter(e => e.tag === "full").length})`);

  const existingIds = new Set<string>();
  const formattedEntries = selectedEndpoints.map((ep) => {
    const id = generateEndpointId(ep.url, chain.slug, existingIds);
    return `  Object.freeze({ id: "${id}", url: "${ep.url}", tag: "${ep.tag}" }),`;
  });

  const nowIso = new Date().toISOString();
  let generatedContent = "";

  if (chain.chainId === 1) {
    // Ethereum defines the BuiltinRpcEndpoint interface
    generatedContent = `// Auto-generated by scripts/update-builtin-rpcs.ts on ${nowIso}
// Benchmarked over ${options.durationSeconds}s against chainlist.org & ethereum-lists.
// Filtered out unstable, flapping, lagging, or rate-limited nodes.

export interface BuiltinRpcEndpoint {
  readonly id: string;
  readonly url: string;
  readonly tag?: "archive" | "full";
}

export const ${chain.constantName}: readonly BuiltinRpcEndpoint[] = Object.freeze([
${formattedEntries.join("\n")}
]);
`;
  } else {
    // Other chains import BuiltinRpcEndpoint from builtinEthereumRpcs
    generatedContent = `// Auto-generated by scripts/update-builtin-rpcs.ts on ${nowIso}
// Benchmarked over ${options.durationSeconds}s against chainlist.org & ethereum-lists.
// Filtered out unstable, flapping, lagging, or rate-limited nodes.

import type { BuiltinRpcEndpoint } from "./builtinEthereumRpcs";

export const ${chain.constantName}: readonly BuiltinRpcEndpoint[] = Object.freeze([
${formattedEntries.join("\n")}
]);
`;
  }

  if (options.dryRun) {
    console.log(`\n[DRY RUN] File content preview for ${chain.fileBasename}:\n`);
    console.log(generatedContent);
  } else {
    fs.writeFileSync(targetFilePath, generatedContent, "utf-8");
    console.log(`✓ Successfully updated ${chain.fileBasename} with ${selectedEndpoints.length} elite endpoints.`);

    // Ensure index.ts re-exports the chain file
    const indexPath = path.join(POOL_DIR, "index.ts");
    if (fs.existsSync(indexPath)) {
      let indexContent = fs.readFileSync(indexPath, "utf-8");
      const exportLine = `export * from "./${chain.fileBasename.replace(/\.ts$/, "")}";`;
      if (!indexContent.includes(exportLine)) {
        indexContent = `${exportLine}\n${indexContent}`;
        fs.writeFileSync(indexPath, indexContent, "utf-8");
        console.log(`✓ Updated src/pool/index.ts to export ${chain.fileBasename}`);
      }
    }
  }

  console.log("\n==========================================================================");
  console.log(`🎉 Builtin RPC generation completed for [${chain.chainId}] ${chain.name}`);
  console.log("==========================================================================\n");
}

async function main() {
  try {
    const options = parseArgs();
    const chain = await resolveChain(options.chainInput);
    await runBenchmark(chain, options);
  } catch (err) {
    console.error(`\n❌ Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
