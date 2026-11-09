// One SDK client per chain and deployment over the time-boxed fallback transport (lib/rpc.ts), shared by the app,
// the landing and the try-it flow. Kept apart from lib/chain.ts so pages that only need the selected network do not
// load the whole SDK client up front (the landing imports this on its first live read).
import { createSuretyClient, type SuretyClient, type SuretyDeployment } from "@surety/sdk";

import { createReadClient } from "./rpc";

const clients = new Map<string, SuretyClient>();

export function liveClient(chainId: number, deployment: SuretyDeployment): SuretyClient {
  const key = `${chainId}:${deployment.version}:${deployment.contracts.vault}`;
  let client = clients.get(key);
  if (!client) {
    client = createSuretyClient({ chainId, deployment, publicClient: createReadClient(chainId) });
    clients.set(key, client);
  }
  return client;
}
