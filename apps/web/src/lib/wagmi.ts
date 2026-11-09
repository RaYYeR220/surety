import { mezoMainnet, mezoTestnet } from "@surety/sdk";
import type { Chain } from "viem";
import { createConfig, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { burner } from "./burner";
import { rpcTransport, rpcUrls } from "./rpc";

/** Optional: set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID at build time to offer WalletConnect. */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || null;

export const APP_URL = "https://surety-credit.vercel.app";
export const APP_DESCRIPTION = "veBTC holders vote where MUSD credit goes, and their rewards take the first loss.";

/** The SDK's chain with our tested RPC list, so wallets that add Mezo get endpoints that answer. */
function withRpcs<const C extends Chain>(chain: C): C {
  return { ...chain, rpcUrls: { ...chain.rpcUrls, default: { http: [...rpcUrls(chain.id)] } } };
}

// Injected wallets (EIP-6963 announces each one), the testnet key of this browser, and WalletConnect when a
// project id is set. Mezo Passport's Bitcoin wallets are not listed here: the wallet dialog loads them on demand
// (lib/passport.ts) so their code never ships in the first bundle.
const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true }), burner()];
if (WALLETCONNECT_PROJECT_ID) {
  connectors.push(
    walletConnect({
      projectId: WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: { name: "Surety", description: APP_DESCRIPTION, url: APP_URL, icons: [`${APP_URL}/icon.svg`] },
    }),
  );
}

export const wagmiConfig = createConfig({
  // Mainnet first: it is the default view of the app. Reads go through the same time-boxed fallback as the SDK.
  chains: [withRpcs(mezoMainnet), withRpcs(mezoTestnet)],
  connectors,
  transports: {
    [mezoMainnet.id]: rpcTransport(mezoMainnet.id),
    [mezoTestnet.id]: rpcTransport(mezoTestnet.id),
  },
  ssr: true,
  multiInjectedProviderDiscovery: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
