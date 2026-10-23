// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {SuretyFixture} from "../utils/SuretyFixture.sol";
import {SuretyHandler} from "./handlers/SuretyHandler.sol";

/// @notice System invariants of the integrated deployment under random sequences of lender, voter, sponsor,
/// borrower, liquidator, price-shock and keeper actions (see SuretyHandler).
/// @dev The testnet stress configuration: one-hour epochs with the production season, so cohorts season, get
/// slashed and mature within a run. Seeded with 100,000 MUSD of deposits, three permanent voters and one timed voter
/// whose power decays (all voted and rebalanced once), a Morpho borrower, a veBTC loan and incentives on both lines.
/// Every handler action is expected to succeed, so any revert (a rebalance, checkpoint or cover that blocks) fails.
/// forge-config: default.invariant.fail-on-revert = true
contract SuretyInvariants is SuretyFixture {
    uint256 internal constant SEED_DEPOSIT = 100_000e18;

    SuretyHandler internal handler;

    function setUp() public override {
        EPOCH_LENGTH = 1 hours;
        super.setUp();

        address[] memory voterAddrs = new address[](4);
        uint256[] memory tokens = new uint256[](4);
        voterAddrs[0] = alice;
        voterAddrs[1] = bob;
        voterAddrs[2] = carol;
        voterAddrs[3] = makeAddr("dave");
        tokens[0] = _lockPermanent(alice, 3e18);
        tokens[1] = _lockPermanent(bob, 2e18);
        tokens[2] = _lockPermanent(carol, 1e18);
        tokens[3] = _lockVeBTC(voterAddrs[3], 2e18, 28 days);
        _deposit(lender, SEED_DEPOSIT);

        _warpEpochs(1);
        _voteAll(alice, tokens[0], MORPHO_LINE);
        _voteAll(bob, tokens[1], VE_LINE);
        _vote(carol, tokens[2], _arr(MORPHO_LINE, VE_LINE), _arr(5000, 5000));
        _vote(voterAddrs[3], tokens[3], _arr(MORPHO_LINE, VE_LINE), _arr(2000, 8000));
        _rebalance();

        handler = new SuretyHandler(
            SuretyHandler.System({
                vault: vault,
                musd: musd,
                btc: btc,
                ve: ve,
                voter: voter,
                allocator: allocator,
                pool: pool,
                line: line,
                morpho: morpho,
                btcMarket: btcMarket,
                stressed: stressedSource
            }),
            voterAddrs,
            tokens
        );
        vm.label(address(handler), "SuretyHandler");

        // Open books before fuzzing: a Morpho borrower at 50% LTV, a veBTC loan at 40% LTV and 1,000 MUSD of
        // incentives on each line. Through the handler, so its ledger sees the pool flows.
        handler.borrowMorpho(0, 0.5e18, 5000);
        handler.open(0, 0.5e18, 8000, false);
        handler.postIncentive(MORPHO_LINE, 1_000e18);
        handler.postIncentive(VE_LINE, 1_000e18);
        assertEq(line.loanCount(), 1);

        targetContract(address(handler));
    }

    /// @dev Invariants read time-dependent views (interest accrual); evaluate them at the handler's clock.
    modifier synced() {
        vm.warp(handler.currentTime());
        vm.roll(handler.currentBlock());
        _;
    }

    /// @notice VaultV2 never reports more assets than it holds idle plus what its adapters hold, and the allocator and
    /// pool never keep MUSD or (allocator) vault shares.
    function invariant_vaultAssetsBacked() public synced {
        uint256 backing = musd.balanceOf(address(vault)) + morphoAdapter.realAssets() + line.realAssets();
        assertLe(vault.totalAssets(), backing, "vault assets backed");
        assertEq(musd.balanceOf(address(allocator)), 0, "allocator holds no MUSD");
        assertEq(vault.balanceOf(address(allocator)), 0, "allocator holds no shares");
        assertEq(musd.balanceOf(address(pool)), 0, "pool holds no MUSD between calls");
    }

    /// @notice The veBTC line's books: `realAssets == cash + totalDebt`, its MUSD covers `cash`, and the per-loan
    /// debts sum to `totalDebt` up to one wei of rounding per open loan.
    function invariant_lineAccounting() public synced {
        uint256 totalDebt = line.totalDebt();
        assertEq(line.realAssets(), line.cash() + totalDebt, "realAssets == cash + debt");
        assertGe(musd.balanceOf(address(line)), line.cash(), "cash is held");

        uint256 sum = 0;
        uint256 open = 0;
        uint256 count = line.loanCount();
        for (uint256 id = 1; id <= count; ++id) {
            VeBTCCreditLine.LoanState state = line.loan(id).state;
            if (state != VeBTCCreditLine.LoanState.Active && state != VeBTCCreditLine.LoanState.Auction) {
                assertEq(line.debtOf(id), 0, "closed loans owe nothing");
                continue;
            }
            sum += line.debtOf(id);
            ++open;
        }
        assertGe(sum, totalDebt, "loan debts cover the total");
        assertLe(sum, totalDebt + open, "rounding at most one wei per loan");
    }

    /// @notice Every share that entered a cohort is claimed, slashed, refunded or still held; the reserve equals its
    /// inflows minus what covers took; cohorts plus reserve are exactly the pool's accounted shares, all backed.
    function invariant_cohortConservation() public synced {
        SuretyHandler.Ledger memory led = handler.ledgerOf();
        uint256 held = 0;
        for (uint256 e = handler.firstEpoch(); e <= handler.currentEpoch(); e += EPOCH_LENGTH) {
            for (uint256 lineId; lineId < 2; ++lineId) {
                (uint256 shares,,) = pool.cohort(lineId, e);
                held += shares;
            }
        }
        assertEq(
            led.incentives + led.feesToCohorts,
            led.claimedToOwners + led.claimedToReserve + led.slashed + led.refunded + held,
            "cohort inflows == claimed + slashed + refunded + held"
        );
        assertEq(pool.reserveShares(), led.feesToReserve + led.claimedToReserve - led.fromReserve, "reserve ledger");
        assertEq(held + pool.reserveShares(), pool.accountedShares(), "accounted shares");
        assertLe(pool.accountedShares(), vault.balanceOf(address(pool)), "accounted shares are held");
    }

    /// @notice Covers never exceed recorded losses (in loss units, which is what `lossCovered` counts and what
    /// Covered events report), and the veBTC line's recorded loss never exceeds its bad debt.
    function invariant_coverNeverExceedsLoss() public synced {
        uint256 covered = 0;
        for (uint256 lineId; lineId < 2; ++lineId) {
            assertLe(pool.lossCovered(lineId), pool.lossRecorded(lineId), "covered <= recorded");
            covered += pool.lossCovered(lineId);
        }
        SuretyHandler.Ledger memory led = handler.ledgerOf();
        assertEq(led.lossUnitsCovered, covered, "lossCovered == loss units of Covered events");
        assertEq(led.coverAssets == 0, covered == 0, "MUSD moves exactly when loss units are covered");
        assertLe(pool.lossRecorded(VE_LINE), line.badDebtTotal(), "recorded <= bad debt");
    }

    /// @notice Per epoch, line tallies sum to the epoch total and each line's tally is the sum of its ballots.
    function invariant_tallyConservation() public synced {
        uint256[] memory tokens = handler.voterTokenIds();
        uint256 from = handler.firstEpoch() - EPOCH_LENGTH;
        for (uint256 e = from; e <= handler.currentEpoch(); e += EPOCH_LENGTH) {
            uint256 lineSum = 0;
            for (uint256 lineId; lineId < 2; ++lineId) {
                uint256 votes = voter.lineVotes(e, lineId);
                lineSum += votes;
                uint256 ballots = 0;
                for (uint256 t; t < tokens.length; ++t) {
                    ballots += voter.tokenVotes(e, tokens[t], lineId);
                }
                assertEq(ballots, votes, "line tally == sum of ballots");
            }
            assertEq(lineSum, voter.totalVotes(e), "epoch total == sum of line tallies");
        }
    }

    /// @notice Every open loan's escrow holds its NFT; settled loans' escrows hold nothing.
    function invariant_escrowsHoldTheirNFT() public view {
        uint256 count = line.loanCount();
        for (uint256 id = 1; id <= count; ++id) {
            VeBTCCreditLine.Loan memory l = line.loan(id);
            bool open = l.state == VeBTCCreditLine.LoanState.Active || l.state == VeBTCCreditLine.LoanState.Auction;
            if (open) assertEq(ve.ownerOf(l.tokenId), l.escrow, "escrow holds the NFT");
            else assertTrue(ve.ownerOf(l.tokenId) != l.escrow, "settled escrow released the NFT");
            assertEq(line.borrowerOfEscrow(l.escrow), l.borrower);
        }
    }

    /// @dev What a run reached, for `-vv` runs: loans opened and liquidated, losses recorded and covered, claims.
    function afterInvariant() public view {
        uint256 liquidated = 0;
        for (uint256 id = 1; id <= line.loanCount(); ++id) {
            if (line.loan(id).state == VeBTCCreditLine.LoanState.Liquidated) ++liquidated;
        }
        SuretyHandler.Ledger memory led = handler.ledgerOf();
        console2.log(
            string.concat(
                "run: loans=",
                vm.toString(line.loanCount()),
                " liquidated=",
                vm.toString(liquidated),
                " lossMorpho=",
                vm.toString(pool.lossRecorded(MORPHO_LINE) / 1e18),
                " lossVe=",
                vm.toString(pool.lossRecorded(VE_LINE) / 1e18),
                " covered=",
                vm.toString((pool.lossCovered(MORPHO_LINE) + pool.lossCovered(VE_LINE)) / 1e18),
                " claimed=",
                vm.toString(led.claimedToOwners / 1e18),
                " slashed=",
                vm.toString(led.slashed / 1e18),
                " epochs=",
                vm.toString((handler.currentEpoch() - handler.firstEpoch()) / EPOCH_LENGTH)
            )
        );
    }
}
