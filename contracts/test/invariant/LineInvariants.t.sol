// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {LineFixture} from "../utils/LineFixture.sol";
import {LineHandler} from "./handlers/LineHandler.sol";

/// @notice VeBTCCreditLine invariants under random borrowing, repayment, harvests, auctions, BTC crashes, MUSD depegs
/// and vault (de)allocations (see LineHandler): the books balance, every fee lands where the split says, and no MUSD
/// is lent while the peg is unhealthy.
/// @dev Seeded with 100,000 MUSD allocated to the line and one loan at 80% of the timed limit. Every handler action
/// is expected to succeed, so any revert (a repay, harvest or bid that blocks) fails the run.
/// forge-config: default.invariant.fail-on-revert = true
contract LineInvariants is LineFixture {
    LineHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new LineHandler(
            LineHandler.System({
                vault: vault,
                musd: musd,
                btc: btc,
                ve: ve,
                poolsVoter: poolsVoter,
                line: line,
                stressed: stressedSource,
                lineSource: lineSource,
                peg: peg,
                pegSource: pegSource,
                admin: admin,
                treasury: treasury
            })
        );
        vm.label(address(handler), "LineHandler");
        handler.allocate(100_000e18);
        handler.open(0, 1e18, 8000, false);
        assertEq(line.loanCount(), 1);
        // The harness is not vacuous: a harvest through it repays.
        handler.harvest(0, 10, 1e18);
        assertEq(handler.ledgerOf().harvested, 10e18);
        targetContract(address(handler));
    }

    /// @dev Invariants read time-dependent views (interest accrual); evaluate them at the handler's clock.
    modifier synced() {
        vm.warp(handler.currentTime());
        vm.roll(handler.currentBlock());
        _;
    }

    /// @notice `realAssets == cash + totalDebt`, the line's MUSD covers `cash`, and the per-loan debts sum to
    /// `totalDebt` up to one wei of rounding per open loan.
    function invariant_booksBalance() public synced {
        uint256 totalDebt = line.totalDebt();
        assertEq(line.realAssets(), line.cash() + totalDebt, "realAssets == cash + debt");
        assertGe(musd.balanceOf(address(line)), line.cash(), "cash is held");

        uint256 sum = 0;
        uint256 open = 0;
        for (uint256 id = 1; id <= line.loanCount(); ++id) {
            VeBTCCreditLine.LoanState state = line.loan(id).state;
            if (state != VeBTCCreditLine.LoanState.Active && state != VeBTCCreditLine.LoanState.Auction) {
                assertEq(line.debtOf(id), 0, "settled loans owe nothing");
                continue;
            }
            sum += line.debtOf(id);
            ++open;
        }
        assertGe(sum, totalDebt, "loan debts cover the total");
        assertLe(sum, totalDebt + open, "rounding at most one wei per loan");
    }

    /// @notice Cash moves only by allocations, borrowing, repayments, harvests and the debt-plus-lenders part of bids:
    /// donations, fees paid out and interest never show up in it.
    function invariant_cashMatchesLedger() public view {
        assertEq(line.cash(), handler.ledgerOf().cash);
    }

    /// @notice Every fee lands where the split says: the treasury holds exactly the origination fees plus its part of
    /// liquidation fees, the keepers exactly theirs, and what lenders keep is the remainder (which the cash ledger
    /// already checks stays in the line), so treasury + keepers + lenders == fee kept.
    function invariant_feeConservation() public synced {
        LineHandler.Ledger memory led = handler.ledgerOf();
        assertEq(musd.balanceOf(treasury), led.originationFees + led.toTreasury, "treasury");
        uint256 keepers = 0;
        for (uint256 i; i < handler.keeperCount(); ++i) {
            keepers += musd.balanceOf(handler.keepers(i));
        }
        assertEq(keepers, led.toKeepers, "keepers");
        assertEq(led.toLenders + led.toTreasury + led.toKeepers, led.liquidationFeesKept, "split adds up");
        assertGe(line.interestEarnedTotal(), led.toLenders, "lenders' part is income");
    }

    /// @notice Shortfalls are exactly what bids below the debt left, and none came from anywhere else.
    function invariant_badDebtIsShortfalls() public view {
        assertEq(line.badDebtTotal(), handler.ledgerOf().shortfalls);
    }

    /// @notice No `open` or `borrowMore` ever went through while the peg was unhealthy.
    function invariant_noBorrowingWhileUnhealthy() public view {
        assertEq(handler.ledgerOf().borrowsWhileUnhealthy, 0);
    }

    /// @notice Every open loan's escrow holds its NFT; settled loans' escrows hold nothing.
    function invariant_escrowsHoldTheirNFT() public view {
        for (uint256 id = 1; id <= line.loanCount(); ++id) {
            VeBTCCreditLine.Loan memory l = line.loan(id);
            bool open = l.state == VeBTCCreditLine.LoanState.Active || l.state == VeBTCCreditLine.LoanState.Auction;
            if (open) assertEq(ve.ownerOf(l.tokenId), l.escrow, "escrow holds the NFT");
            else assertTrue(ve.ownerOf(l.tokenId) != l.escrow, "settled escrow released the NFT");
        }
    }

    /// @dev What a run reached, for `-vv` runs.
    function afterInvariant() public view {
        LineHandler.Ledger memory led = handler.ledgerOf();
        uint256 liquidated = 0;
        uint256 closed = 0;
        for (uint256 id = 1; id <= line.loanCount(); ++id) {
            VeBTCCreditLine.LoanState state = line.loan(id).state;
            if (state == VeBTCCreditLine.LoanState.Liquidated) ++liquidated;
            if (state == VeBTCCreditLine.LoanState.Closed) ++closed;
        }
        console2.log(
            string.concat(
                "run: loans=",
                vm.toString(line.loanCount()),
                " closed=",
                vm.toString(closed),
                " liquidated=",
                vm.toString(liquidated),
                " harvests=",
                vm.toString(handler.calls("harvest")),
                " harvested=",
                vm.toString(led.harvested / 1e18),
                " originationFees=",
                vm.toString(led.originationFees / 1e18),
                " liqFeesKept=",
                vm.toString(led.liquidationFeesKept / 1e18),
                " badDebt=",
                vm.toString(led.shortfalls / 1e18),
                " opens=",
                vm.toString(handler.calls("open"))
            )
        );
    }
}
