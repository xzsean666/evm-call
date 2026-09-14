import type { BuiltinRpcEndpoint } from "./builtinEthereumRpcs";

export const BUILTIN_BASE_RPCS: readonly BuiltinRpcEndpoint[] = Object.freeze([
  Object.freeze({ id: "base-org-public", url: "https://mainnet.base.org" }),
  Object.freeze({ id: "base-developer-public", url: "https://developer-access-mainnet.base.org" }),
  Object.freeze({ id: "base-tenderly-public", url: "https://base.gateway.tenderly.co" }),
  Object.freeze({ id: "base-blastapi", url: "https://base-mainnet.public.blastapi.io" }),
  Object.freeze({ id: "base-drpc", url: "https://base.drpc.org" }),
  Object.freeze({ id: "base-meowrpc", url: "https://base.meowrpc.com" }),
  Object.freeze({ id: "base-publicnode", url: "https://base-rpc.publicnode.com" }),
  Object.freeze({ id: "base-llamarpc", url: "https://base.llamarpc.com" }),
  Object.freeze({ id: "base-1rpc", url: "https://1rpc.io/base" }),
]);
