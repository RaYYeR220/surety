import { explorerUrl, getDeployment, MEZO_MAINNET_ID, MEZO_TESTNET_ID, type SuretyDeployment } from "@surety/sdk";
import Link from "next/link";
import type { CSSProperties } from "react";

import { CHAIN_NAMES } from "@/lib/networks";
import { CONTRACT_NAMES, sourcifyUrl, TEST_COUNTS } from "@/lib/proof";

import s from "./Landing.module.css";
import styles from "./ProofStrip.module.css";

function deploymentOf(chainId: number): SuretyDeployment | null {
  try {
    return getDeployment(chainId) ?? null;
  } catch {
    return null;
  }
}

const fmt = (n: number | bigint) => n.toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Ext({ href, children, label }: { href: string; children: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      {children}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

export function ProofStrip() {
  const testnet = deploymentOf(MEZO_TESTNET_ID);
  const mainnet = deploymentOf(MEZO_MAINNET_ID);
  const shown = mainnet ?? testnet;
  const shownChain = mainnet ? MEZO_MAINNET_ID : MEZO_TESTNET_ID;
  const contracts = shown ? CONTRACT_NAMES.map(([key, name]) => ({ key, name, address: shown.contracts[key] })) : [];
  const txs = testnet?.proof.txs ?? [];

  return (
    <section className={`${s.sec} ${styles.proof}`} id="proof" aria-labelledby="pf-h">
      <div className={s.wrap}>
        <div className={`${styles.head} ${s.io}`}>
          <h2 className={`${s.h2} ${styles.h2}`} id="pf-h">
            Check it yourself.
          </h2>
          <p>
            Every contract is verified source. Figures on this page are tagged live or illustrative; the app reads
            everything from chain.
          </p>
        </div>

        <div className={`${styles.receipt} ${s.io}`} style={{ "--d": ".1s" } as CSSProperties}>
          <div>
            <span className={styles.k}>Contracts</span>
            <span className={styles.v}>{shown ? `${contracts.length} verified on Sourcify` : "Verified on Sourcify"}</span>
            <span className={`${s.tag} ${shown ? s.tagLive : ""} ${styles.tag}`}>{shown ? "Exact match" : "Pending"}</span>
          </div>
          <div>
            <span className={styles.k}>Tests</span>
            <span className={styles.v}>
              {TEST_COUNTS.foundry} Foundry · {TEST_COUNTS.typescript} TypeScript
            </span>
            <span className={styles.sub}>
              Incl. {TEST_COUNTS.invariants} invariants over {fmt(TEST_COUNTS.invariantCalls)} calls each
            </span>
            <span className={`${s.tag} ${styles.tag}`}>forge · vitest</span>
          </div>
          <div>
            <span className={styles.k}>Testnet</span>
            <span className={styles.v}>{testnet ? "Live on Mezo testnet" : "Deployed on Mezo testnet"}</span>
            {testnet ? (
              <span className={styles.sub}>
                <Ext href={explorerUrl(MEZO_TESTNET_ID, "block", testnet.deployedAt)}>{`Since block ${fmt(testnet.deployedAt)}`}</Ext>
              </span>
            ) : null}
            <span className={`${s.tag} ${testnet ? s.tagLive : ""} ${styles.tag}`}>{testnet ? "Deployed" : "Pending"}</span>
          </div>
          <div>
            <span className={styles.k}>Mainnet</span>
            <span className={styles.v}>{mainnet ? "Live on Mezo mainnet" : "Deployed on Mezo mainnet"}</span>
            <span className={`${s.tag} ${mainnet ? s.tagLive : ""} ${styles.tag}`}>{mainnet ? "Deployed" : "Pending"}</span>
          </div>
          <div>
            <span className={styles.k}>Audit</span>
            <span className={styles.v}>Not audited yet</span>
            <span className={`${s.tag} ${styles.tag}`}>Said plainly</span>
          </div>
        </div>

        <div className={`${styles.ledger} ${s.io}`}>
          <div className={styles.block}>
            <h3>
              Verified contracts{shown ? ` · ${CHAIN_NAMES[shownChain]}` : ""}
            </h3>
            {shown ? (
              <ul className={styles.contracts}>
                {contracts.map((c) => (
                  <li key={c.key}>
                    <span className={styles.cn}>{c.name}</span>
                    <span className={styles.addr} title={c.address}>
                      {short(c.address)}
                    </span>
                    <span className={styles.links}>
                      <Ext href={sourcifyUrl(shownChain, c.address)} label={`${c.name} source on Sourcify`}>
                        Sourcify
                      </Ext>
                      <Ext href={explorerUrl(shownChain, "address", c.address)} label={`${c.name} on the Mezo explorer`}>
                        Explorer
                      </Ext>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>
                <span className={s.tag}>Pending</span> Addresses appear here once the deployment is published.
              </p>
            )}
          </div>
          <div className={styles.block}>
            <h3>Testnet proof transactions</h3>
            {txs.length ? (
              <ol className={styles.txs}>
                {txs.map((t) => (
                  <li key={t.hash}>
                    <span className={styles.cn}>{t.label}</span>
                    <span className={styles.links}>
                      <Ext href={explorerUrl(MEZO_TESTNET_ID, "tx", t.hash)} label={`${t.label}: transaction ${t.hash}`}>
                        {short(t.hash)}
                      </Ext>
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={styles.empty}>
                <span className={s.tag}>Pending</span> The lifecycle run lands here as it is recorded: deposit, vote,
                rebalance, loan, price shock, auction, cover, claim.
              </p>
            )}
            <p className={styles.more}>
              <Link href="/app/proof">Every address and transaction in the app</Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
