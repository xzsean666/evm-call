export interface BuiltinRpcEndpoint {
  readonly id: string;
  readonly url: string;
}

export const BUILTIN_ETHEREUM_RPCS: readonly BuiltinRpcEndpoint[] = Object.freeze([
  Object.freeze({ id: "drpc-public", url: "https://eth.drpc.org" }),
  Object.freeze({ id: "blastapi-public", url: "https://eth-mainnet.public.blastapi.io" }),
  Object.freeze({ id: "mevblocker-public", url: "https://rpc.mevblocker.io" }),
  Object.freeze({ id: "nodies-public", url: "https://eth-pokt.nodies.app" }),
  Object.freeze({ id: "tenderly-public", url: "https://mainnet.gateway.tenderly.co" }),
]);
