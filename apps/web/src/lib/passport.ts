// Mezo Passport's Bitcoin wallets (Unisat, OKX, Xverse): each signs with the Bitcoin wallet itself and acts on
// Mezo through its own smart account, so a Bitcoin-only user needs no EVM wallet. Only the wagmi connectors are
// used: Passport's RainbowKit modal and account dropdown target React 18 and are not needed here. This module is
// only ever reached through a dynamic import from the wallet dialog, so none of it ships in the first bundle.
import { getOKXWallet, getUnisatWallet, getXverseWallet } from "@mezo-org/passport/dist/src/wallet";
import type { CreateConnectorFn } from "wagmi";

import { rpcUrls } from "./rpc";

export interface PassportWallet {
  id: string;
  name: string;
  /** Whether the browser extension is present right now. */
  installed: boolean;
  downloadUrl: string | null;
  connector: CreateConnectorFn;
}

const NAMES: Record<string, string> = {
  "orangekit-unisat": "Unisat",
  "orangekit-okx": "OKX Wallet (Bitcoin)",
  "orangekit-xverse": "Xverse",
};

const DOWNLOADS: Record<string, string> = {
  "orangekit-unisat": "https://unisat.io/download",
  "orangekit-okx": "https://www.okx.com/web3",
  "orangekit-xverse": "https://www.xverse.app/download",
};

export function isPassportConnectorId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("orangekit-");
}

/** Passport's Bitcoin wallets for `chainId`, as wagmi connectors ready to pass to `connect`. */
export function passportWallets(chainId: number): PassportWallet[] {
  const config = { rpcUrl: rpcUrls(chainId)[0]!, chainId };
  return [getUnisatWallet(config), getOKXWallet(config), getXverseWallet(config)].map((create) => {
    const wallet = create();
    return {
      id: wallet.id,
      name: NAMES[wallet.id] ?? wallet.name,
      installed: wallet.installed === true,
      downloadUrl: wallet.downloadUrls?.desktop ?? DOWNLOADS[wallet.id] ?? null,
      // Passport's connectors ignore RainbowKit's wallet details.
      connector: wallet.createConnector({} as never) as CreateConnectorFn,
    };
  });
}
