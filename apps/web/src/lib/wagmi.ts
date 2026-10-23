import { mezoMainnet, mezoTestnet } from "@surety/sdk";
import { createConfig, http, type CreateConnectorFn } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

/** Optional: set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID at build time to offer WalletConnect. */
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
if (walletConnectProjectId) {
  connectors.push(
    walletConnect({
      projectId: walletConnectProjectId,
      showQrModal: true,
      metadata: {
        name: "Surety",
        description: "veBTC holders vote where MUSD credit goes, and their rewards take the first loss.",
        url: "https://surety.app",
        icons: [],
      },
    }),
  );
}

export const wagmiConfig = createConfig({
  // Testnet first: it is the default network of the app.
  chains: [mezoTestnet, mezoMainnet],
  connectors,
  transports: {
    [mezoTestnet.id]: http(),
    [mezoMainnet.id]: http(),
  },
  ssr: true,
  multiInjectedProviderDiscovery: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
