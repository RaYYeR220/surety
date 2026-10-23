import { MEZO_MAINNET_ID, MEZO_TESTNET_ID } from "@surety/sdk";

/** Display names of the Mezo networks (usable from server and client components). */
export const CHAIN_NAMES: Record<number, string> = {
  [MEZO_TESTNET_ID]: "Mezo Testnet",
  [MEZO_MAINNET_ID]: "Mezo Mainnet",
};
