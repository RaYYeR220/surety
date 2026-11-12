# Business

Who pays whom in Surety, what each fee pays for, and what the fees add up to at today's caps and at larger sizes. The short version: borrowers pay lenders, lenders pay veBTC voters for standing first in line for losses, and a few small fees fund the keeper, operations and security reviews. At the current mainnet caps those fees come to about 20 MUSD a year. That pays for nothing yet, and this document says so plainly.

The same figures are live in the app at `/app/business`, with the fee rates read from the contracts.

## Who pays whom

| Stream | Who pays | How much | Who receives | What it pays for |
| --- | --- | --- | --- | --- |
| Interest | Borrowers, on both lines | Each line's rate curve | Lenders, through the srMUSD share price | The lenders' yield |
| Voters' fee | Lenders, out of interest | 10% of interest | veBTC voters, as seasoning rewards in the SuretyPool | First-loss capital: slashed first if the line they back goes bad |
| Origination fee | veBTC borrowers, once per amount borrowed | 0.25% | Treasury | Operations and security reviews |
| Liquidation fee | A defaulted borrower, out of the auction proceeds | Up to 3% of the debt | 80% lenders, 10% treasury, 10% the keeper that started the auction | Lenders first, then the keeper's gas and reviews |
| Management fee | Lenders, as a slightly slower share price | 0.20% of vault assets a year | Treasury, minted as srMUSD | Operations and security reviews |
| Share market fee | Lenders who sell srMUSD on the share market | 0.10% of each fill | Treasury | Operations |
| Sponsor incentives | Anyone who wants credit to go to a line | Whatever they post | That line's voters | Votes for the line; refunded if it draws none |

How each one is taken:

- **Origination.** `VeBTCCreditLine.open` and `borrowMore` send `originationFeeBps` of the amount to the treasury. The borrower receives the rest and owes the full amount. Extending a lock or adding collateral pays nothing.
- **Liquidation.** On a winning bid the line keeps the debt plus up to `liqFeeBps` of it. Of that fee `protocolShareBps` (20%) leaves the line: `keeperShareBps` (50%) of it to the address that called `startAuction`, the rest to the treasury. Lenders keep the other 80%. Anything above the debt and the fee goes back to the borrower. The trigger (65% LTV) and the floor (85% of the collateral value) leave an 18-point cushion, so an auction started at the trigger repays the debt plus the fee even if it clears at the floor.
- **Management.** Morpho VaultV2's own management fee, 0.20% a year of total assets, minted as srMUSD to the treasury for the time elapsed. The deposit gate lets the treasury receive it even while new shares are held back after a loss; over a cover recognised in a week it dilutes that cover by about 0.0038%.
- **Share market.** `ShareMarket.fill` sends `feeBps` of the price to the treasury from the seller's side: the buyer pays exactly the quoted price.
- **Savings.** Idle MUSD is parked in Mezo's sMUSD. Its yield comes in lumps: close to zero from 23 Oct to 9 Nov apart from one payment, then 0.00086 MUSD on the vault's 2.5 MUSD over 10–12 Nov (about 5.6% a year). The voters' fee on it goes to the pool reserve, not to any line's voters, and the rest raises the share price. It is not protocol income.

## The treasury

One address receives every protocol fee (`treasury` in the deployment file; the line and the share market fix it at deployment). Today it is the deployer's key. Moving it to a multisig is the next step, before the caps go up.

## What the fees pay for, in order

1. **The keeper.** It rebalances at every epoch flip, records and covers losses, harvests auto-repay loans after each Mezo epoch, and starts auctions. Mezo gas is paid in BTC and is cheap. The keeper share of each liquidation fee goes to whoever starts the auction, so running a keeper pays for itself and anyone can run one.
2. **Operations.** Hosting and RPC. Free tiers today; a paid endpoint is budgeted at about 1,200 MUSD a year.
3. **Security reviews.** One independent review per major version, budgeted at about 20,000 MUSD. The reviews so far are in [SECURITY.md](SECURITY.md).

## Unit economics

A year of protocol income at three sizes. Interest is left out: it belongs to lenders and voters.

| MUSD a year | At the caps (4,000 MUSD) | At $1M | At $10M |
| --- | ---: | ---: | ---: |
| veBTC debt outstanding | 1,200 | 300,000 | 3,000,000 |
| Management fee (0.20%) | 8 | 2,000 | 20,000 |
| Origination fees (0.25%) | 12 | 3,000 | 30,000 |
| Liquidation fees, treasury part | 0.07 | 18 | 180 |
| Share market fees (0.10%) | 0.4 | 100 | 1,000 |
| **Treasury income** | **20.5** | **5,118** | **51,180** |
| Keeper share of liquidation fees | 0.07 | 18 | 180 |
| Running costs (ops and one review) | −21,200 | −21,200 | −21,200 |
| **Left over** | **−21,180** | **−16,082** | **29,980** |

Assumptions:

- The caps column is the mainnet configuration: two lines capped at 2,000 MUSD each, fully allocated.
- Half of the vault sits in the veBTC line, and 60% of that is borrowed.
- Each MUSD of veBTC debt is borrowed anew four times a year. veBTC locks run up to four weeks, and extending a lock pays no fee, so this is a guess, not a rule.
- 2% of that debt ends in an auction each year, paying the full liquidation fee.
- 10% of the vault changes hands on the share market each year.
- Costs are estimates, not quotes. 1 MUSD is taken as $1.

What it means:

- **At the caps the protocol earns about 20 MUSD a year.** The caps are there to limit what can go wrong while the contracts are new, not to earn.
- **The fees cover operations and a yearly review from about 4.1M MUSD in the vault.** Below that, the treasury runs at a loss and the team covers the difference.
- **About 0.5% of TVL a year reaches the treasury** under these assumptions: 0.20% from the management fee, 0.30% from origination, and a little from the share market. Origination scales with how much veBTC credit is used, so the veBTC line's utilisation matters more than the vault's size.

## Who pays the team

Nobody, yet. The team builds Surety on its own time, and no fee goes to it today. The treasury pays running costs first: the keeper's gas, operations, then security reviews. Only income above those would pay the team, and at the caps there is none.

Growth comes from raising the caps as the contracts prove themselves on mainnet, and from veBTC holders voting for the lines and bringing sponsors to them. Sponsor incentives reward voters directly; they are not protocol income.
