// Network helpers shared by the browser wallet and the Node scripts.
import { createPublicClient, createWalletClient, http, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, foundry } from "viem/chains";

export function chainFor(chainId) {
  if (chainId === 11155111) return sepolia;
  if (chainId === 31337) return foundry;
  return defineChain({ id: chainId, name: "chain-" + chainId, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
}

export const explorerFor = (chainId) => (chainId === 11155111 ? "https://sepolia.etherscan.io" : null);

export function makeClients(rpcUrl, chainId, privateKey) {
  const chain = chainFor(chainId);
  const transport = http(rpcUrl, { retryCount: 3 });
  const pub = createPublicClient({ chain, transport, pollingInterval: 1500 });
  const wallet = privateKey ? createWalletClient({ chain, transport, account: privateKeyToAccount(privateKey) }) : null;
  return { pub, wallet, chain };
}

export async function clients(rpcUrl, privateKey) {
  const probe = createPublicClient({ transport: http(rpcUrl) });
  return makeClients(rpcUrl, await probe.getChainId(), privateKey);
}
