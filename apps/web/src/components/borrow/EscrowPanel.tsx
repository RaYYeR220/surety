"use client";

// Everything a borrower can do with the escrowed veBTC: harvest its Mezo rewards into repayment (v2), vote it on
// Mezo's gauges with chosen weights, reset that vote, and claim its fees, bribes and rebase to the wallet.
import type { LoanView } from "@surety/sdk";
import { useState } from "react";
import type { Address } from "viem";

import { Stack } from "@/components/layout/Layout";
import { ReadError } from "@/components/shell/EnvGate";
import { useTx, type TxPlan } from "@/components/tx/TxProvider";
import { Muted, Notice, Pill, Skeleton } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { CheckList } from "@/components/ui/Controls";
import { buildEscrowClaim, buildEscrowClaimRebase, buildEscrowReset, buildEscrowVote } from "@/lib/builders";
import type { ReadyEnv } from "@/lib/env";
import { formatAmount, formatBtc, formatDateTime, formatMusd, shortAddress } from "@/lib/format";
import { isV2, useEscrowVoting, useHarvest, useMezoPools } from "@/lib/queries";
import type { MezoPool } from "@/lib/reads";
import { percentSplit, weightsValid } from "@/lib/weights";

import styles from "./Borrow.module.css";

export function EscrowPanel({ env, loan }: { env: ReadyEnv; loan: LoanView }) {
  const pools = useMezoPools();
  const voting = useEscrowVoting(loan.tokenId, pools.data);
  const inAuction = loan.state === "Auction";
  const err = pools.error ?? voting.error;
  return (
    <Stack gap={6}>
      <Muted small>
        The escrow can only vote, reset, claim, extend and add BTC for this one NFT, and only on your instruction (or, with
        auto-repay on, harvest into repayment for anyone). Rewards it claims are forwarded to you.
      </Muted>
      {inAuction ? (
        <Notice tone="warning" title="Mezo voting is off during the auction">
          Mezo allows one vote or reset per NFT per Mezo epoch, so a vote now would leave the buyer an NFT it cannot
          reset, withdraw or merge for up to a week. The line refuses both until the loan is repaid. Fees, bribes and
          the rebase the NFT already earned stay yours to claim or harvest.
        </Notice>
      ) : null}
      {err ? (
        <ReadError
          what="Mezo's pools"
          error={err}
          onRetry={() => {
            void pools.refetch();
            void voting.refetch();
          }}
        />
      ) : null}
      {isV2(env) ? <Harvest env={env} loan={loan} pools={pools.data} /> : null}
      <Vote env={env} loan={loan} pools={pools.data} poolsPending={pools.isPending} voting={voting} />
      <Claims env={env} loan={loan} voting={voting} />
    </Stack>
  );
}

type Voting = ReturnType<typeof useEscrowVoting>;

/* ---------- Harvest (v2) ---------- */

function Harvest({ env, loan, pools }: { env: ReadyEnv; loan: LoanView; pools: MezoPool[] | undefined }) {
  const tx = useTx();
  const harvest = useHarvest(loan.loanId, pools);
  const h = harvest.data;
  const others = h ? h.items.filter((i) => !i.repays) : [];
  const repays = h ? (h.musd < loan.debt ? h.musd : loan.debt) : 0n;
  const excess = h && h.musd > loan.debt ? h.musd - loan.debt : 0n;

  const plan = (): TxPlan => ({
    title: `Harvest veBTC #${loan.tokenId}'s rewards into loan #${loan.loanId}`,
    summary: `Claims the escrow's Mezo fees and bribes to the line: ${formatMusd(repays)} MUSD repays the loan${excess > 0n ? ` (the ${formatMusd(excess)} MUSD left over goes to you)` : ""}, ${others.length ? `${others.length} other token${others.length === 1 ? "" : "s"} go to your wallet, ` : ""}and the veBTC rebase compounds into the lock.`,
    rows: [
      ...h!.items.map((i) => ({
        label: `${i.pool ?? shortAddress(i.reward)}${i.kind ? ` · ${i.kind === "fees" ? "fees" : "bribe"}` : ""}`,
        value: `${formatAmount(i.amount, { decimals: i.decimals, max: 6 })} ${i.symbol}${i.repays ? " → repays" : " → you"}`,
      })),
      h!.plan.claimableRebase > 0n && {
        label: "veBTC rebase",
        value: `${formatBtc(h!.plan.claimableRebase)} BTC → the lock`,
      },
      { rule: true, label: "", value: "" },
      { label: "Debt now", value: `${formatMusd(loan.debt)} MUSD` },
      { label: "Debt after", value: `${formatMusd(loan.debt - repays)} MUSD` },
    ],
    notes: [
      loan.autoRepay
        ? "Auto-repay is on, so anyone could send this; the keeper does after each Mezo epoch flip."
        : "Auto-repay is off, so only you can harvest this loan.",
      "Only what the claim pays counts: the line measures its own balance around the claim.",
      "Never reads the price feed or the MUSD peg, and works while the loan is in auction.",
    ],
    steps: [
      {
        label: `Harvest from ${h!.plan.rewards.length} reward contract${h!.plan.rewards.length === 1 ? "" : "s"}`,
        detail: "VeBTCCreditLine.harvest(loanId, rewards, tokens)",
        tx: env.client.buildHarvest({ loanId: loan.loanId, rewards: h!.plan.rewards, tokens: h!.plan.tokens }),
      },
    ],
    confirmLabel: "Harvest",
  });

  return (
    <Stack gap={3}>
      <div className={styles.escrowHead}>
        <span className={styles.escrowTitle}>Harvest into repayment</span>
        <Muted small>{loan.autoRepay ? "Auto-repay on: anyone may harvest" : "Auto-repay off: only you can harvest"}</Muted>
      </div>
      {harvest.error ? (
        <ReadError what="what a harvest would claim" error={harvest.error} onRetry={() => void harvest.refetch()} />
      ) : !h ? (
        <Skeleton height={96} label="Reading what a harvest would claim" />
      ) : !h.plan.worthHarvesting ? (
        <Muted small>
          Nothing to harvest yet. A Mezo vote earns its pools&apos; fees and bribes once that Mezo epoch ends, and the
          rebase accrues weekly.
        </Muted>
      ) : (
        <ul className={styles.rewardList} aria-label="What a harvest would claim">
          {h.items.map((i) => (
            <li key={`${i.reward}:${i.token}`}>
              <span>
                {i.pool ?? shortAddress(i.reward)}{" "}
                <Muted small>· {i.kind === "fees" ? "trading fees" : i.kind === "bribe" ? "bribe" : "reward"}</Muted>
              </span>
              <span className={styles.rewardAmount}>
                <span className="num">
                  {formatAmount(i.amount, { decimals: i.decimals, max: 6 })} {i.symbol}
                </span>
                {i.repays ? <Pill tone="positive">repays</Pill> : <Pill tone="outline">to you</Pill>}
              </span>
            </li>
          ))}
          {h.plan.claimableRebase > 0n ? (
            <li>
              <span>
                veBTC rebase <Muted small>· Mezo distributor</Muted>
              </span>
              <span className={styles.rewardAmount}>
                <span className="num">{formatBtc(h.plan.claimableRebase)} BTC</span>
                <Pill tone="accent">to the lock</Pill>
              </span>
            </li>
          ) : null}
        </ul>
      )}
      {h && h.plan.worthHarvesting ? (
        <p className={styles.harvestSum}>
          A harvest now repays <strong className="num">{formatMusd(repays)} MUSD</strong> of the{" "}
          <span className="num">{formatMusd(loan.debt)}</span> MUSD debt.
        </p>
      ) : null}
      <div className={styles.escrowActions}>
        <Button disabled={!h || !h.plan.worthHarvesting} onClick={() => tx.review(plan())}>
          Harvest into repayment
        </Button>
      </div>
    </Stack>
  );
}

/* ---------- Vote on Mezo with weights ---------- */

function Vote({
  env,
  loan,
  pools,
  poolsPending,
  voting,
}: {
  env: ReadyEnv;
  loan: LoanView;
  pools: MezoPool[] | undefined;
  poolsPending: boolean;
  voting: Voting;
}) {
  const tx = useTx();
  const [picked, setPicked] = useState<Address[] | null>(null);
  const [edited, setEdited] = useState<Record<string, string> | null>(null);

  const all = pools ?? [];
  const byPool = new Map(all.map((p) => [p.pool.toLowerCase(), p]));
  const label = (a: Address) => byPool.get(a.toLowerCase())?.label ?? shortAddress(a);
  const currentVotes = voting.data?.votes ?? [];
  const current = currentVotes.map((v) => v.pool);
  // Start from the NFT's current Mezo vote until the borrower changes the selection.
  const selected = picked ?? current;
  const listed = all.filter((p) => p.alive || current.includes(p.pool));
  const max = voting.data?.maxVotingNum ?? 30;

  // Weights default to the current split while the selection is the current vote, else an even split.
  const sameAsCurrent =
    selected.length === current.length && selected.every((a) => current.some((c) => c.toLowerCase() === a.toLowerCase()));
  const defaults = sameAsCurrent
    ? percentSplit(selected.map((a) => Number(currentVotes.find((v) => v.pool.toLowerCase() === a.toLowerCase())?.votes ?? 0n)))
    : percentSplit(selected.map(() => 1));
  const shown = selected.map((a, i) => edited?.[a.toLowerCase()] ?? String(defaults[i] ?? 0));
  const weights = shown.map((w) => Number(w));
  const total = weights.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  const valid = weightsValid(weights);

  // The line refuses escrowVote / escrowReset once the loan is in auction (claims stay open): Mezo allows one vote
  // or reset per NFT per Mezo epoch, and a vote just before a bid would hand the bidder an NFT it cannot reset.
  const inAuction = loan.state === "Auction";
  const blocked = inAuction
    ? "No Mezo vote or reset while the loan is in auction: the buyer must get an NFT that can still act this Mezo epoch. Claims still work."
    : !voting.data
      ? undefined
      : voting.data.votedThisEpoch
        ? "Mezo takes one vote or reset per NFT per Mezo epoch, and this veBTC has used it. It can vote again after Mezo's weekly flip (Thursday 00:00 UTC)."
        : !voting.data.inVoteWindow
          ? `Mezo's voting window is closed right now (it opens ${formatDateTime(voting.data.voteStart)} and closes ${formatDateTime(voting.data.voteEnd)}).`
          : undefined;

  const vote = (): TxPlan => ({
    title: `Vote veBTC #${loan.tokenId} on Mezo`,
    summary: `Votes the escrowed NFT's full boosted power on Mezo's PoolsVoter across ${selected.length === 1 ? "this pool" : `these ${selected.length} pools`}. It replaces the NFT's current Mezo vote. Only you, the borrower, can do this.`,
    rows: selected.map((a, i) => ({ label: label(a), value: `${weights[i]}% of the power` })),
    notes: [
      "Fees and bribes from this vote become claimable after the Mezo epoch ends. Claim them to your wallet or harvest them into the loan.",
    ],
    blocked,
    steps: [
      {
        label: "Vote through the escrow",
        detail: "VeBTCCreditLine.escrowVote(loanId, pools, weights)",
        tx: buildEscrowVote(env.deployment, {
          loanId: loan.loanId,
          pools: selected,
          weights: weights.map((w) => BigInt(w) * 100n),
        }),
      },
    ],
    confirmLabel: "Vote",
  });

  const reset = (): TxPlan => ({
    title: "Clear the escrow's Mezo votes",
    summary: "Removes the NFT's current PoolsVoter votes. Mezo counts a reset as the NFT's one action this epoch.",
    blocked,
    steps: [
      { label: "Reset votes", detail: "VeBTCCreditLine.escrowReset(loanId)", tx: buildEscrowReset(env.deployment, { loanId: loan.loanId }) },
    ],
    confirmLabel: "Reset",
  });

  return (
    <Stack gap={3}>
      <div className={styles.escrowHead}>
        <span className={styles.escrowTitle}>Vote on Mezo</span>
        <Muted small>
          {voting.data
            ? current.length
              ? `Votes now: ${currentVotes
                  .map((v, i) => `${label(v.pool)} ${percentSplit(currentVotes.map((x) => Number(x.votes)))[i]}%`)
                  .join(", ")}`
              : "No Mezo vote right now"
            : "Reading the NFT's vote…"}
        </Muted>
      </div>
      {blocked && !inAuction ? <Notice tone="warning">{blocked}</Notice> : null}
      {poolsPending ? (
        <Skeleton height={180} label="Loading Mezo's pools" />
      ) : listed.length === 0 ? (
        <Muted small>Mezo&apos;s PoolsVoter lists no live gauge right now.</Muted>
      ) : (
        <div className={styles.poolList}>
          <CheckList
            label="Mezo pools to vote for"
            values={selected}
            onChange={(next) => {
              setPicked(next as Address[]);
              setEdited(null);
            }}
            options={listed.map((p) => ({
              value: p.pool,
              content: (
                <span className={styles.poolRow}>
                  <span className={styles.poolName}>{p.label}</span>
                  <span className={`num ${styles.poolAddr}`}>{shortAddress(p.pool)}</span>
                  {current.includes(p.pool) ? <Pill tone="accent">Voted</Pill> : null}
                  {!p.alive ? <Pill tone="warning">Gauge killed</Pill> : null}
                </span>
              ),
            }))}
          />
        </div>
      )}
      {selected.length > 0 ? (
        <fieldset className={styles.weights}>
          <legend className={styles.weightsLegend}>Weights</legend>
          {selected.map((a, i) => (
            <label key={a} className={styles.weightRow}>
              <span className={styles.weightName}>{label(a)}</span>
              <span className={styles.weightInput}>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  step={1}
                  value={shown[i]}
                  aria-label={`Weight for ${label(a)}, percent`}
                  onChange={(e) => setEdited({ ...Object.fromEntries(selected.map((s, k) => [s.toLowerCase(), shown[k]!])), [a.toLowerCase()]: e.target.value })}
                />
                <span aria-hidden="true">%</span>
              </span>
            </label>
          ))}
          <div className={styles.weightFoot}>
            <span className={valid ? styles.weightOk : styles.weightBad} role="status">
              {valid ? "Total 100%" : `Total ${total}%: whole percents from 1 to 100 that add up to 100`}
            </span>
            <Button size="sm" variant="quiet" onClick={() => setEdited(Object.fromEntries(selected.map((s, k) => [s.toLowerCase(), String(percentSplit(selected.map(() => 1))[k])])))}>
              Split evenly
            </Button>
          </div>
        </fieldset>
      ) : null}
      <div className={styles.escrowActions}>
        <Button
          disabled={selected.length === 0 || selected.length > max || !valid || !!blocked || !voting.data}
          onClick={() => tx.review(vote())}
        >
          Review Mezo vote
        </Button>
        <Button size="sm" variant="secondary" disabled={current.length === 0 || !!blocked} onClick={() => tx.review(reset())}>
          Reset Mezo votes
        </Button>
        <Muted small>
          {selected.length > max ? `Mezo allows at most ${max} pools per vote.` : `${selected.length} picked`}
        </Muted>
      </div>
    </Stack>
  );
}

/* ---------- Claim to the wallet ---------- */

function Claims({ env, loan, voting }: { env: ReadyEnv; loan: LoanView; voting: Voting }) {
  const tx = useTx();
  const rewards = voting.data?.rewards ?? [];

  const claim = (): TxPlan => {
    const grouped = new Map<Address, Address[]>();
    for (const r of rewards) grouped.set(r.reward, [...(grouped.get(r.reward) ?? []), r.token]);
    return {
      title: `Claim Mezo fees and bribes of veBTC #${loan.tokenId}`,
      summary:
        "Claims what the escrowed NFT earned from its Mezo votes. The escrow forwards exactly what the claim paid to your wallet; nothing goes to the loan.",
      rows: rewards.map((r) => ({
        label: `${r.label} · ${r.kind === "fees" ? "fees" : "bribe"}`,
        value: `${formatAmount(r.earned, { decimals: r.decimals, max: 6 })} ${r.symbol}`,
      })),
      steps: [
        {
          label: `Claim from ${grouped.size} reward contract${grouped.size === 1 ? "" : "s"}`,
          detail: "VeBTCCreditLine.escrowClaim(loanId, rewards, tokens)",
          tx: buildEscrowClaim(env.deployment, {
            loanId: loan.loanId,
            rewards: [...grouped.keys()],
            tokens: [...grouped.values()],
          }),
        },
      ],
      confirmLabel: "Claim",
    };
  };

  const rebase = (): TxPlan => ({
    title: "Claim the veBTC rebase",
    summary:
      "Claims the NFT's rebase: it compounds into the lock while the lock is live (raising your collateral), and is paid to you once the lock has ended.",
    steps: [
      {
        label: "Claim rebase",
        detail: "VeBTCCreditLine.escrowClaimRebase(loanId)",
        tx: buildEscrowClaimRebase(env.deployment, { loanId: loan.loanId }),
      },
    ],
    confirmLabel: "Claim",
  });

  return (
    <Stack gap={3}>
      <div className={styles.escrowHead}>
        <span className={styles.escrowTitle}>{isV2(env) ? "Or claim to your wallet" : "Fees and bribes"}</span>
        <Muted small>Earned by this NFT&apos;s Mezo votes, claimable now</Muted>
      </div>
      {voting.isPending && !voting.error ? (
        <Skeleton height={64} label="Reading claimable rewards" />
      ) : rewards.length === 0 ? (
        <Muted small>Nothing to claim yet. A Mezo vote earns its pools&apos; fees and bribes once that Mezo epoch ends.</Muted>
      ) : (
        <ul className={styles.rewardList} aria-label="Claimable fees and bribes">
          {rewards.map((r) => (
            <li key={`${r.reward}:${r.token}`}>
              <span>
                {r.label} <Muted small>· {r.kind === "fees" ? "trading fees" : "bribe"}</Muted>
              </span>
              <span className="num">
                {formatAmount(r.earned, { decimals: r.decimals, max: 6 })} {r.symbol}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.escrowActions}>
        <Button variant={isV2(env) ? "secondary" : "primary"} disabled={rewards.length === 0} onClick={() => tx.review(claim())}>
          Claim fees and bribes{rewards.length ? ` (${rewards.length})` : ""}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => tx.review(rebase())}>
          Claim rebase
        </Button>
      </div>
    </Stack>
  );
}
