"use client";

import { shareFillPrice, type Board, type ShareListing, type ShareMarketView } from "@surety/sdk";
import { useState } from "react";

import { isPaused, useGateReason } from "@/components/gate/DepositGate";
import { V2Notice } from "@/components/gate/V2Notice";
import { Split, Stack } from "@/components/layout/Layout";
import { AppLink } from "@/components/shell/AppLink";
import { EnvGate, ReadError } from "@/components/shell/EnvGate";
import { useWalletDialog } from "@/components/shell/WalletDialog";
import { useTx, type TxPlan, type TxStep } from "@/components/tx/TxProvider";
import { Empty, KeyValues, Muted, Notice, PageHead, Pill, Skeleton, Stat } from "@/components/ui/Bits";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AmountField, DataTable, Pager, SelectField, Slider, type Column } from "@/components/ui/Controls";
import type { ReadyEnv } from "@/lib/env";
import { formatBps, formatMusd, formatPerShare, parseAmount, shortAddress, toInput } from "@/lib/format";
import { listingPricePerShare, maxAssetsFor, minAssetsFor, PAGE_SIZE, pageInfo, pricePerShare } from "@/lib/market";
import { isV2, useBoard, useMyListings, useShareMarket, useShareQuote, useWallet } from "@/lib/queries";
import { readAllowance } from "@/lib/reads";

import styles from "./Market.module.css";

const SLIPPAGE = [
  { value: "10", label: "0.1%" },
  { value: "50", label: "0.5%" },
  { value: "100", label: "1%" },
] as const;
type Slippage = (typeof SLIPPAGE)[number]["value"];

/** Floor on what cancel-and-redeem accepts, below the shares' value now (the share price only moves slowly). */
const REDEEM_SLIPPAGE_BPS = 50;

export function MarketPage() {
  return <EnvGate>{(env) => <MarketView env={env} />}</EnvGate>;
}

function MarketView({ env }: { env: ReadyEnv }) {
  const v2 = isV2(env);
  const board = useBoard();
  const [start, setStart] = useState(0);
  const market = useShareMarket(start, PAGE_SIZE);
  const [buying, setBuying] = useState<ShareListing | null>(null);
  const m = market.data;
  // Listings close as they fill: keep the page inside what is still open.
  const total = m ? Number(m.openCount) : 0;
  if (m && start > 0 && start >= total) setStart(Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE));

  return (
    <Stack gap={6}>
      <PageHead
        title="Share market"
        lead="Leave while the vault's cash is lent out: list srMUSD at a discount to the live share price, and buyers fill it for MUSD, in part or in full. Buyers get vault shares below their value."
      />
      {!v2 ? (
        <V2Notice what="The share market" />
      ) : market.error ? (
        <ReadError what="the share market" error={market.error} onRetry={() => void market.refetch()} />
      ) : !m ? (
        <Stack gap={5}>
          <Skeleton height={120} label="Reading the share market" />
          <Skeleton height={320} />
        </Stack>
      ) : (
        <>
          <Summary m={m} />
          {!m.isOpen ? <PausedNotice board={board.data} /> : null}
          <Card
            flat
            title="Open listings"
            description="Every price follows the live share price; a fill is priced when it lands. The cheapest offer is the one with the deepest discount."
          >
            <Listings
              env={env}
              m={m}
              onBuy={(l) => {
                setBuying(l);
                requestAnimationFrame(() => document.getElementById("buy")?.scrollIntoView({ behavior: "smooth", block: "start" }));
              }}
            />
            {total > PAGE_SIZE ? (
              <div className={styles.pager}>
                <Pager
                  label="Listing pages"
                  status={(() => {
                    const p = pageInfo(total, start);
                    return `Listings ${p.start}–${p.end} of ${p.total}`;
                  })()}
                  hasPrev={pageInfo(total, start).hasPrev}
                  hasNext={pageInfo(total, start).hasNext}
                  onPrev={() => setStart(Math.max(0, start - PAGE_SIZE))}
                  onNext={() => setStart(start + PAGE_SIZE)}
                />
              </div>
            ) : null}
          </Card>
          <Split main="1fr" side="1fr" gap={5}>
            <div id="buy">
              <Buy env={env} m={m} listing={buying} onDone={() => setBuying(null)} />
            </div>
            <ListShares env={env} m={m} />
          </Split>
          <MyListings env={env} m={m} board={board.data} />
        </>
      )}
    </Stack>
  );
}

/* ---------- Summary ---------- */

function Summary({ m }: { m: ShareMarketView }) {
  return (
    <Card>
      <div className={styles.summary}>
        <Stat label="Share price" value={formatPerShare(m.sharePrice)} unit="MUSD" hint="per srMUSD, from the vault" />
        <Stat
          label="Best offer"
          value={m.best ? formatPerShare(m.best.pricePerShare) : "—"}
          unit={m.best ? "MUSD" : undefined}
          hint={m.best ? `${formatBps(m.best.discountBps, 2)} below · listing #${m.best.id}` : "Nothing listed"}
        />
        <Stat label="Open listings" value={m.openCount.toString()} />
        <Stat label="Fee" value={formatBps(m.feeBps, 2)} hint="of each fill, from the seller, to the treasury" />
        <div className={styles.status}>
          {m.isOpen ? (
            <Pill tone="positive" dot>
              Open
            </Pill>
          ) : (
            <Pill tone="warning" dot>
              Paused while a loss is covered
            </Pill>
          )}
        </div>
      </div>
    </Card>
  );
}

function PausedNotice({ board }: { board: Board | undefined }) {
  const reason = useGateReason(board);
  return (
    <Notice tone="warning" title="The market is paused while a loss is being covered" role="status">
      A credit line took a loss, and the voters&apos; cover is on its way to the lenders who took it. Until it is
      covered and back in the share price, the vault takes no new srMUSD holders, so nobody can buy into that cover at
      a discount. Listing, buying and plain cancelling wait. <strong>Cancel and redeem</strong> stays open: it takes your
      listing down and redeems the shares for MUSD from the vault&apos;s idle cash.
      {reason ? (
        <>
          {" "}
          <strong>Now:</strong> {reason}
        </>
      ) : null}
    </Notice>
  );
}

/* ---------- Listings ---------- */

function Listings({ env, m, onBuy }: { env: ReadyEnv; m: ShareMarketView; onBuy: (l: ShareListing) => void }) {
  const mine = (l: ShareListing) => !!env.account && l.seller.toLowerCase() === env.account.toLowerCase();
  if (m.listings.length === 0) {
    return (
      <div className={styles.pad}>
        <Empty title="Nothing listed">
          Lenders list shares here when they want out before the vault has idle cash. List yours below.
        </Empty>
      </div>
    );
  }
  const rows = [...m.listings].sort((a, b) => b.discountBps - a.discountBps || Number(a.id - b.id));
  const columns: Column<ShareListing>[] = [
    { key: "id", header: "Listing", cell: (l) => <span className="num">#{l.id.toString()}</span> },
    {
      key: "seller",
      header: "Seller",
      cell: (l) => (mine(l) ? <Pill tone="accent">You</Pill> : <span className="num">{shortAddress(l.seller)}</span>),
    },
    { key: "discount", header: "Discount", align: "end", cell: (l) => <span className="num">{formatBps(l.discountBps, 2)}</span> },
    { key: "shares", header: "srMUSD", align: "end", cell: (l) => <span className="num">{formatMusd(l.shares)}</span> },
    { key: "value", header: "Worth", align: "end", cell: (l) => <span className="num">{formatMusd(l.value)} MUSD</span> },
    { key: "price", header: "Price for all", align: "end", cell: (l) => <span className="num">{formatMusd(l.price)} MUSD</span> },
    {
      key: "per",
      header: "Per share",
      align: "end",
      cell: (l) => <span className="num">{formatPerShare(listingPricePerShare(l))}</span>,
    },
    {
      key: "buy",
      header: "",
      align: "end",
      cell: (l) => (
        <Button
          size="sm"
          variant="secondary"
          disabled={!m.isOpen || mine(l)}
          onClick={() => onBuy(l)}
          aria-label={`Buy from listing ${l.id}`}
          title={!m.isOpen ? "Paused while a loss is covered" : mine(l) ? "Your own listing" : undefined}
        >
          Buy
        </Button>
      ),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(l) => l.id.toString()} caption="Open srMUSD listings" />;
}

/* ---------- Buy (partial fill) ---------- */

function Buy({
  env,
  m,
  listing,
  onDone,
}: {
  env: ReadyEnv;
  m: ShareMarketView;
  listing: ShareListing | null;
  onDone: () => void;
}) {
  const tx = useTx();
  const wallet = useWallet();
  const dialog = useWalletDialog();
  const [input, setInput] = useState("");
  const [slippage, setSlippage] = useState<Slippage>("50");
  const shares = parseAmount(input);
  const live = listing ? (m.listings.find((l) => l.id === listing.id) ?? listing) : null;
  const quote = useShareQuote(live?.id ?? null, shares);
  const q = quote.data && live && quote.data.id === live.id ? quote.data : null;
  const maxAssets = q ? maxAssetsFor(q.assets, Number(slippage)) : null;
  const musd = wallet.data?.musd;

  if (!live) {
    return (
      <Card title="Buy shares" description="Pick a listing above to buy from it.">
        <Muted small>
          You can buy all of a listing or part of it. Shares you buy are ordinary srMUSD: they earn as the vault earns
          and withdraw like any other.
        </Muted>
      </Card>
    );
  }

  const error =
    input && shares === null
      ? "Enter a number of shares."
      : shares !== null && shares > live.shares
        ? `This listing has ${formatMusd(live.shares)} srMUSD left.`
        : q && q.filled === 0n && shares !== null && shares > 0n
          ? "Too small to fill: the least is 0.000001 srMUSD."
          : maxAssets !== null && musd !== undefined && maxAssets > musd
            ? `With the slippage bound you need ${formatMusd(maxAssets)} MUSD; your wallet holds ${formatMusd(musd)}.`
            : null;

  const plan = async (): Promise<TxPlan> => {
    const market = env.deployment.contracts.shareMarket!;
    const [approve, fill] = env.client.buildFillListing({ id: live.id, shares: q!.filled, maxAssets: maxAssets! });
    const steps: TxStep[] = [];
    const allowance = env.account ? await readAllowance(env.client, env.deployment.external.musd, env.account, market) : 0n;
    if (allowance < maxAssets!) {
      steps.push({
        label: `Allow the market to take up to ${formatMusd(maxAssets!)} MUSD`,
        detail: "MUSD.approve(market, maxAssets)",
        tx: approve!,
      });
    }
    steps.push({
      label: `Buy ${formatMusd(q!.filled)} srMUSD from listing #${live.id}`,
      detail: "ShareMarket.fill(id, shares, maxAssets)",
      tx: fill!,
    });
    return {
      title: `Buy srMUSD from listing #${live.id}`,
      summary: `You pay about ${formatMusd(q!.assets)} MUSD for ${formatMusd(q!.filled)} srMUSD worth ${formatMusd((q!.filled * m.sharePrice) / 10n ** 18n)} MUSD at today's share price. The price is fixed when the fill lands, never above your bound.`,
      rows: [
        { label: "You receive", value: `${formatMusd(q!.filled)} srMUSD` },
        { label: "You pay now", value: `${formatMusd(q!.assets)} MUSD` },
        { label: "Your bound", value: `${formatMusd(maxAssets!)} MUSD (+${formatBps(Number(slippage), 1)})` },
        { label: "Discount", value: formatBps(live.discountBps, 2) },
        { label: "Seller receives", value: `${formatMusd(q!.sellerReceives)} MUSD` },
        { label: "Treasury fee (from the seller)", value: `${formatMusd(q!.fee)} MUSD` },
      ],
      notes: [
        "The vault's share price only rises between paydays, so the bound mostly covers interest accrued before the fill lands.",
        "If less than 0.000001 srMUSD would be left in the listing, it goes back to the seller and the listing closes.",
      ],
      blocked: !m.isOpen ? "The market is paused while a loss is being covered; buying waits until it reopens." : undefined,
      steps,
      confirmLabel: steps.length > 1 ? "Approve and buy" : "Buy",
      successMessage: "Bought. The srMUSD is in your wallet; it earns and withdraws like any other.",
    };
  };

  return (
    <Card
      title={`Buy from listing #${live.id}`}
      description={`${formatMusd(live.shares)} srMUSD at ${formatBps(live.discountBps, 2)} below the share price.`}
      actions={
        <Button size="sm" variant="quiet" onClick={onDone}>
          Close
        </Button>
      }
    >
      <Stack gap={4}>
        <AmountField
          label="Shares to buy"
          unit="srMUSD"
          value={input}
          onChange={setInput}
          aside={`Listed: ${formatMusd(live.shares)}`}
          onMax={() => setInput(toInput(live.shares))}
          error={error}
          help="Buy all of it or part of it."
        />
        <SelectField
          label="Slippage bound"
          value={slippage}
          onChange={setSlippage}
          options={SLIPPAGE.map((s) => ({ value: s.value, label: `${s.label} above the quote` }))}
          help="The most above today's quote you agree to pay if the share price moves first."
        />
        {quote.error ? <ReadError what="the quote" error={quote.error} onRetry={() => void quote.refetch()} /> : null}
        {q && q.filled > 0n ? (
          <div className={styles.quote}>
            <KeyValues
              label="Fill quote"
              items={[
                { label: "You pay now", value: `${formatMusd(q.assets)} MUSD` },
                { label: "Per share", value: `${formatPerShare(pricePerShare(q.assets, q.filled))} MUSD` },
                { label: "Share price", value: `${formatPerShare(m.sharePrice)} MUSD` },
                { label: "Max you pay", value: `${formatMusd(maxAssets)} MUSD` },
                { label: "Fee to the treasury", value: `${formatMusd(q.fee)} MUSD, from the seller's side` },
              ]}
            />
          </div>
        ) : shares && quote.isFetching ? (
          <Skeleton height={120} label="Quoting" />
        ) : null}
        {!env.account ? (
          <Button onClick={dialog.open}>Connect a wallet to buy</Button>
        ) : (
          <Button block disabled={!q || q.filled === 0n || !!error || !m.isOpen} onClick={() => tx.review(plan)}>
            Review purchase
          </Button>
        )}
      </Stack>
    </Card>
  );
}

/* ---------- List shares ---------- */

function ListShares({ env, m }: { env: ReadyEnv; m: ShareMarketView }) {
  const tx = useTx();
  const wallet = useWallet();
  const dialog = useWalletDialog();
  const [input, setInput] = useState("");
  const [discount, setDiscount] = useState(100);
  const shares = parseAmount(input);
  const held = wallet.data?.shares;
  const value = shares === null ? null : (shares * m.sharePrice) / 10n ** 18n;
  const priced = value === null ? null : shareFillPrice(value, discount, m.feeBps);
  const error =
    input && shares === null
      ? "Enter a number of shares."
      : shares !== null && held !== undefined && shares > held
        ? `Your wallet holds ${formatMusd(held)} srMUSD.`
        : shares !== null && shares > 0n && shares < 10n ** 12n
          ? "The least you can list is 0.000001 srMUSD."
          : null;

  const plan = async (): Promise<TxPlan> => {
    const market = env.deployment.contracts.shareMarket!;
    const [approve, list] = env.client.buildListShares({ shares: shares!, discountBps: discount });
    const steps: TxStep[] = [];
    const allowance = await readAllowance(env.client, env.deployment.contracts.vault, env.account!, market);
    if (allowance < shares!) {
      steps.push({ label: `Allow the market to hold ${formatMusd(shares!)} srMUSD`, detail: "srMUSD.approve(market, shares)", tx: approve! });
    }
    steps.push({
      label: `List ${formatMusd(shares!)} srMUSD at ${formatBps(discount, 2)} off`,
      detail: "ShareMarket.list(shares, discountBps)",
      tx: list!,
    });
    return {
      title: "List srMUSD for sale",
      summary: `Your ${formatMusd(shares!)} srMUSD move into the market and sell at ${formatBps(discount, 2)} below the share price at the moment each fill lands. Cancel any time to take the unsold part back.`,
      rows: [
        { label: "Worth now", value: `${formatMusd(value)} MUSD` },
        { label: "Buyers pay now", value: `${formatMusd(priced!.assets)} MUSD` },
        { label: `You receive (after the ${formatBps(m.feeBps, 2)} fee)`, value: `${formatMusd(priced!.sellerReceives)} MUSD` },
      ],
      notes: [
        "Listed shares keep earning: a fill is priced off the share price when it happens.",
        "If a loss has to be covered while you are listed, the market pauses; you can still cancel and redeem for MUSD.",
      ],
      blocked: !m.isOpen ? "The market is paused while a loss is being covered, so it cannot take shares now. Withdrawing from the vault stays open." : undefined,
      steps,
      confirmLabel: steps.length > 1 ? "Approve and list" : "List",
    };
  };

  return (
    <Card title="Sell your shares" description="Name a discount; buyers can fill it in parts.">
      {!env.account ? (
        <Empty title="Connect a wallet to list" action={<Button onClick={dialog.open}>Connect wallet</Button>}>
          You list srMUSD you hold. Each fill pays you MUSD straight away.
        </Empty>
      ) : (
        <Stack gap={4}>
          <AmountField
            label="Shares to list"
            unit="srMUSD"
            value={input}
            onChange={setInput}
            aside={held !== undefined ? `Wallet: ${formatMusd(held)} srMUSD` : undefined}
            onMax={held ? () => setInput(toInput(held)) : undefined}
            error={error}
          />
          <div className={styles.discount}>
            <div className={styles.discountHead}>
              <span>Discount</span>
              <span className="num">{formatBps(discount, 2)}</span>
            </div>
            <Slider
              value={discount}
              onChange={setDiscount}
              min={0}
              max={2000}
              step={25}
              label="Discount to the share price"
              valueText={formatBps(discount, 2)}
            />
            <Muted small>
              Up to 20%. {m.best ? `The best offer now is ${formatBps(m.best.discountBps, 2)} off; a deeper discount sells first.` : "Nothing is listed now."}
            </Muted>
          </div>
          {priced && shares && shares > 0n ? (
            <div className={styles.quote}>
              <KeyValues
                label="Listing preview"
                items={[
                  { label: "Worth now", value: `${formatMusd(value)} MUSD` },
                  { label: "Buyers pay", value: `${formatMusd(priced.assets)} MUSD` },
                  { label: "Treasury fee", value: `${formatMusd(priced.fee)} MUSD` },
                  { label: "You receive", value: `${formatMusd(priced.sellerReceives)} MUSD` },
                ]}
              />
            </div>
          ) : null}
          <Button block disabled={!shares || shares === 0n || !!error || !m.isOpen} onClick={() => tx.review(plan)}>
            {m.isOpen ? "Review listing" : "Listing paused"}
          </Button>
          {!m.isOpen ? (
            <Muted small>
              Listing waits while a loss is covered. To leave now, withdraw from the vault&apos;s idle cash on the{" "}
              <AppLink href="/app/lend">Lend page</AppLink>.
            </Muted>
          ) : null}
        </Stack>
      )}
    </Card>
  );
}

/* ---------- Your listings ---------- */

function MyListings({ env, m, board }: { env: ReadyEnv; m: ShareMarketView; board: Board | undefined }) {
  const tx = useTx();
  const mine = useMyListings();
  if (!env.account) return null;
  const idle = board?.vault.idle ?? null;
  const paused = !m.isOpen || isPaused(board);

  const cancel = (l: ShareListing): TxPlan => ({
    title: `Cancel listing #${l.id}`,
    summary: `Takes your ${formatMusd(l.shares)} unsold srMUSD back to your wallet.`,
    blocked: !m.isOpen
      ? "Plain cancelling waits while the market is paused (your wallet cannot receive srMUSD now). Use cancel and redeem to get MUSD instead."
      : undefined,
    steps: [{ label: "Cancel the listing", detail: "ShareMarket.cancel(id)", tx: env.client.buildCancelListing({ id: l.id }) }],
    confirmLabel: "Cancel listing",
  });

  const redeem = (l: ShareListing): TxPlan => {
    const min = minAssetsFor(l.value, REDEEM_SLIPPAGE_BPS);
    return {
      title: `Cancel listing #${l.id} and redeem`,
      summary: `Takes your listing down and redeems its ${formatMusd(l.shares)} srMUSD for about ${formatMusd(l.value)} MUSD from the vault's idle cash. Works while the market is paused.`,
      rows: [
        { label: "You receive (about)", value: `${formatMusd(l.value)} MUSD` },
        { label: "At least", value: `${formatMusd(min)} MUSD` },
        idle !== null && { label: "Vault idle cash now", value: `${formatMusd(idle)} MUSD` },
      ],
      warnings:
        idle !== null && l.value > idle
          ? ["The vault holds less idle MUSD than this redemption needs, so it would fail now. Wait for repayments or the next rebalance."]
          : undefined,
      steps: [
        {
          label: "Cancel and redeem",
          detail: "ShareMarket.cancelAndRedeem(id, minAssets)",
          tx: env.client.buildCancelAndRedeem({ id: l.id, minAssets: min }),
        },
      ],
      confirmLabel: "Cancel and redeem",
    };
  };

  const columns: Column<ShareListing>[] = [
    { key: "id", header: "Listing", cell: (l) => <span className="num">#{l.id.toString()}</span> },
    { key: "discount", header: "Discount", align: "end", cell: (l) => <span className="num">{formatBps(l.discountBps, 2)}</span> },
    { key: "shares", header: "Unsold srMUSD", align: "end", cell: (l) => <span className="num">{formatMusd(l.shares)}</span> },
    { key: "value", header: "Worth", align: "end", cell: (l) => <span className="num">{formatMusd(l.value)} MUSD</span> },
    {
      key: "actions",
      header: "",
      align: "end",
      cell: (l) => (
        <span className={styles.rowActions}>
          {!paused ? (
            <Button size="sm" variant="secondary" onClick={() => tx.review(cancel(l))}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" variant={paused ? "primary" : "quiet"} onClick={() => tx.review(redeem(l))}>
            Cancel and redeem
          </Button>
        </span>
      ),
    },
  ];

  return (
    <Card
      flat
      title="Your listings"
      description={
        paused
          ? "While the market is paused, cancel and redeem is the way out: it takes the listing down and pays you MUSD."
          : "Cancel to take unsold shares back, or cancel and redeem them for MUSD in one step."
      }
    >
      {mine.error ? (
        <div className={styles.pad}>
          <ReadError what="your listings" error={mine.error} onRetry={() => void mine.refetch()} />
        </div>
      ) : !mine.data ? (
        <div className={styles.pad}>
          <Skeleton height={80} label="Reading your listings" />
        </div>
      ) : mine.data.length === 0 ? (
        <div className={styles.pad}>
          <Muted small>You have no open listings.</Muted>
        </div>
      ) : (
        <DataTable columns={columns} rows={mine.data} rowKey={(l) => l.id.toString()} caption="Your listings" />
      )}
    </Card>
  );
}
