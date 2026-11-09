// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Vm} from "forge-std/Vm.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {SavingsAdapter} from "../../src/SavingsAdapter.sol";
import {VoteAllocator} from "../../src/VoteAllocator.sol";
import {IMusdPeg} from "../../src/interfaces/IMusdPeg.sol";
import {SAVINGS_LINE_ID} from "../../src/interfaces/ISuretyPool.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {MockSavingsRate} from "../mocks/MockSavingsRate.sol";
import {AllocatorFixture} from "../utils/AllocatorFixture.sol";
import {RecordingPool} from "./VoteAllocator.t.sol";

/// @notice Settable MUSD peg monitor; can also be made to revert.
contract MockPeg is IMusdPeg {
    bool public healthy = true;
    bool public broken;

    function set(bool healthy_) external {
        healthy = healthy_;
    }

    function breakIt() external {
        broken = true;
    }

    function fix() external {
        broken = false;
    }

    function musdUsdWad() external pure returns (uint256) {
        return 1e18;
    }

    function pegHealthy() external view returns (bool) {
        require(!broken, "broken");
        return healthy;
    }
}

/// @notice VoteAllocator with idle cash parked in sMUSD through the SavingsAdapter (the vault's liquidity adapter) and
/// the MUSD peg gate, against the real VaultV2, Morpho Blue markets, VeBTCCreditLine and CreditVoter.
/// @dev Lenders deposit 1,000,000 MUSD after savings is set, so it lands in sMUSD; the idle buffer is 10%. Alice (6
/// BTC) votes the BTC Morpho line and bob (4 BTC) the veBTC line, so 540,000 / 360,000 MUSD go out to the lines and
/// the 100,000 MUSD buffer stays in sMUSD.
contract VoteAllocatorSavingsTest is AllocatorFixture {
    uint256 internal constant DEPOSIT = 1_000_000e18;
    uint256 internal constant DEPLOYABLE = 900_000e18;
    uint256 internal constant BUFFER = 100_000e18;
    uint256 internal constant DUST = 2;

    RecordingPool internal recorder;
    MockPeg internal gatePeg;
    address internal btcBorrower = makeAddr("btcBorrower");
    address internal saver = makeAddr("saver");

    function setUp() public override {
        super.setUp();
        recorder = new RecordingPool();
        gatePeg = new MockPeg();
        _deploySavings();
        vm.startPrank(admin);
        allocator.setSuretyPool(address(recorder));
        allocator.setSavings(address(savings));
        vm.stopPrank();
    }

    /* Helpers */

    function _seed() internal returns (uint256 aliceId, uint256 bobId) {
        _deposit(lender, DEPOSIT);
        aliceId = _voterLock(alice, 6e18);
        bobId = _voterLock(bob, 4e18);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, VE_LINE);
    }

    function _parked() internal view returns (uint256) {
        return savings.realAssets();
    }

    /// @dev Another sMUSD holder, so the vault's sMUSD earns only its share of the yield.
    function _otherSaver(uint256 amount) internal {
        musd.mint(saver, amount);
        vm.startPrank(saver);
        musd.approve(address(smusd), amount);
        smusd.deposit(amount);
        vm.stopPrank();
    }

    function _count(Vm.Log[] memory logs, bytes32 topic) internal view returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(allocator) && logs[i].topics[0] == topic) ++n;
        }
    }

    /* Wiring */

    function test_setSavings_wiresLiquidityAdapter_oneShot() public {
        assertEq(allocator.savings(), address(savings));
        assertTrue(allocator.parking());
        assertEq(vault.liquidityAdapter(), address(savings));
        assertEq(vault.liquidityData().length, 0);

        vm.prank(admin);
        vm.expectRevert(VoteAllocator.SavingsAlreadySet.selector);
        allocator.setSavings(address(savings));
    }

    function test_setSavings_validates() public {
        VoteAllocator bare = new VoteAllocator(address(vault), voter, admin, IDLE_BUFFER_BPS);
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (address(bare), true)));
        vm.startPrank(admin);
        vm.expectRevert(VoteAllocator.ZeroAddress.selector);
        bare.setSavings(address(0));
        vm.expectRevert(VoteAllocator.NoSavings.selector);
        bare.setParking(true);
        vm.stopPrank();

        // Not one of the vault's adapters.
        SavingsAdapter loose = new SavingsAdapter(address(vault), smusd);
        vm.prank(admin);
        vm.expectRevert(VoteAllocator.UnsupportedSavings.selector);
        bare.setSavings(address(loose));

        // An adapter of the vault without caps would make every deposit revert.
        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(loose))));
        vm.prank(admin);
        vm.expectRevert(VoteAllocator.SavingsCapsUnset.selector);
        bare.setSavings(address(loose));
        _curate(abi.encodeCall(IVaultV2.increaseAbsoluteCap, (LineIds.adapterIdData(address(loose)), 1e30)));
        _curate(abi.encodeCall(IVaultV2.increaseRelativeCap, (LineIds.adapterIdData(address(loose)), 0.5e18)));
        vm.prank(admin);
        vm.expectRevert(VoteAllocator.SavingsCapsUnset.selector);
        bare.setSavings(address(loose));

        // Another vault's adapter.
        SavingsAdapter foreign = new SavingsAdapter(address(new MockVaultAsset(address(musd))), smusd);
        vm.prank(admin);
        vm.expectRevert(VoteAllocator.UnsupportedSavings.selector);
        bare.setSavings(address(foreign));
    }

    /// @dev The owner can set the peg, replace it and remove it (zero opens the gate): the way out when the peg's
    /// pools thin out and it would stay unhealthy for good (L-01 of the v2 review).
    function test_setPeg_ownerOnly_replaceableAndRemovable() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        allocator.setPeg(gatePeg);

        vm.startPrank(admin);
        vm.expectEmit(address(allocator));
        emit VoteAllocator.PegSet(address(gatePeg));
        allocator.setPeg(gatePeg);
        assertEq(address(allocator.peg()), address(gatePeg));
        gatePeg.set(false);
        assertFalse(allocator.pegGateOpen(), "stuck unhealthy");

        MockPeg replacement = new MockPeg();
        allocator.setPeg(replacement);
        assertEq(address(allocator.peg()), address(replacement));
        assertTrue(allocator.pegGateOpen(), "replaced");

        allocator.setPeg(gatePeg);
        assertFalse(allocator.pegGateOpen());
        vm.expectEmit(address(allocator));
        emit VoteAllocator.PegSet(address(0));
        allocator.setPeg(IMusdPeg(address(0)));
        vm.stopPrank();
        assertEq(address(allocator.peg()), address(0));
        assertTrue(allocator.pegGateOpen(), "no peg, no gate");
    }

    /* Parking */

    /// @dev Deposits land in sMUSD; the first rebalance funds the lines out of it and leaves only the buffer parked.
    function test_rebalance_fundsLinesFromSavings_bufferStaysParked() public {
        _seed();
        assertEq(_idle(), 0, "deposits park in sMUSD");
        assertEq(_parked(), DEPOSIT);

        _warpEpochs(1);
        vm.recordLogs();
        _rebalance();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, VoteAllocator.MoveFailed.selector), 0);
        assertEq(_count(logs, VoteAllocator.SavingsMoveFailed.selector), 0);

        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), DEPLOYABLE * 6 / 10, DUST);
        assertEq(allocator.lineAssets(VE_LINE), DEPLOYABLE * 4 / 10);
        assertEq(allocator.lineAssets(CBTC_LINE), 0);
        assertEq(_idle(), 0, "nothing left idle");
        assertApproxEqAbs(_parked(), BUFFER, DUST, "the buffer stays in sMUSD");
        assertEq(vault.totalAssets(), DEPOSIT);
        assertEq(musd.balanceOf(address(allocator)), 0);

        // Savings is not a line: no target, no tally entry.
        (uint256[] memory lineIds, uint256[] memory targetAssets) = allocator.targets();
        assertEq(lineIds.length, voter.lineCount());
        assertEq(targetAssets.length, 3);

        // Re-running moves nothing.
        uint256 parked = _parked();
        _rebalance();
        assertEq(_parked(), parked);
        assertEq(_idle(), 0);
    }

    /// @dev What a deallocation frees and no line can take ends up parked again; a lender exit beyond idle pulls
    /// from sMUSD.
    function test_rebalance_reparksDeallocations_lenderExitPullsSavings() public {
        (uint256 aliceId, uint256 bobId) = _seed();
        _warpEpochs(1);
        _rebalance();

        // Both move to the veBTC line, which is paused (it holds what it has): the BTC line's 540k comes back and,
        // with nowhere to go, is parked.
        _vote(alice, aliceId, VE_LINE);
        _vote(bob, bobId, VE_LINE);
        _warpEpochs(1);
        vm.prank(admin);
        line.pause(true);
        _rebalance();
        assertEq(allocator.lineAssets(BTC_LINE), 0);
        assertEq(allocator.lineAssets(VE_LINE), 360_000e18);
        assertEq(_idle(), 0, "freed cash parked, not left idle");
        assertApproxEqAbs(_parked(), DEPOSIT - 360_000e18, DUST);

        // A lender withdrawal larger than idle MUSD is paid out of sMUSD.
        uint256 parked = _parked();
        vm.prank(lender);
        vault.withdraw(50_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 50_000e18);
        assertEq(_parked(), parked - 50_000e18);
        assertEq(_idle(), 0);
    }

    /// @dev A forced exit from a line leaves MUSD idle: the next run parks it and refills the line; neither the lines'
    /// nor the savings' measured interest moves.
    function test_forceDeallocate_lineCashReparked_interestUnchanged() public {
        (uint256 aliceId, uint256 bobId) = _seed();
        _otherSaver(1_000_000e18);
        _warpEpochs(1);
        _rebalance();
        _borrowMorpho(btcBorrower, 10e18, 270_000e18);
        _openTimed(borrower, 10e18, 180_000e18);
        _smusdYield(2_000e18);
        _warp(3 days);
        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        uint256 snap = vm.snapshotState();

        _rebalance();
        RecordingPool.Attribution memory honest = recorder.at(0);
        assertGt(honest.interest[BTC_LINE], 0);
        assertGt(honest.interest[VE_LINE], 0);
        assertGt(honest.interest[3], 0, "savings yield");

        vm.revertToState(snap);
        _deposit(carol, 10_000e18);
        vm.startPrank(carol);
        vault.forceDeallocate(address(morphoAdapter), abi.encode(btcMarket), 20_000e18, carol);
        vault.forceDeallocate(address(line), "", line.cash() / 2, carol);
        vault.forceDeallocate(address(savings), "", 5_000e18, carol);
        vm.stopPrank();
        assertGt(_idle(), 0);
        _rebalance();
        RecordingPool.Attribution memory forced = recorder.at(0);
        assertEq(forced.interest[BTC_LINE], honest.interest[BTC_LINE], "Morpho interest unchanged");
        assertEq(forced.interest[VE_LINE], honest.interest[VE_LINE], "veBTC interest unchanged");
        assertEq(forced.interest[3], honest.interest[3], "savings yield unchanged");
        assertEq(_idle(), 0, "everything parked again");
    }

    /* Savings yield attribution */

    /// @dev sMUSD yield is measured from the adapter's counter and handed to the pool under SAVINGS_LINE_ID, after
    /// the lines; the lines' own InterestAttributed event is unchanged.
    function test_savingsYield_attributedUnderSavingsId() public {
        (uint256 aliceId, uint256 bobId) = _seed();
        _otherSaver(900_000e18);
        uint256 e1 = _currentEpoch();
        _warpEpochs(1);
        _rebalance();
        assertEq(recorder.count(), 0);

        // 2,000 MUSD of sMUSD yield over 1M sMUSD; the vault holds 100k of it.
        _smusdYield(2_000e18);
        uint256 yield = savings.claimableYield();
        assertApproxEqAbs(yield, 200e18, 1e6);
        // Lender flows through the liquidity adapter are not yield.
        _deposit(carol, 50_000e18);
        vm.prank(carol);
        vault.withdraw(50_000e18, carol, carol);

        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        vm.recordLogs();
        _rebalance();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(recorder.count(), 1);
        RecordingPool.Attribution memory a = recorder.at(0);
        assertEq(a.cohortEpoch, e1);
        assertEq(a.lineIds.length, 4);
        assertEq(a.lineIds[3], SAVINGS_LINE_ID);
        assertEq(a.interest[3], yield);
        assertEq(allocator.savingsLedger().pendingInterest, 0);

        bool sawLines;
        bool sawSavings;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(allocator)) continue;
            if (logs[i].topics[0] == VoteAllocator.InterestAttributed.selector) {
                (uint256[] memory ids,) = abi.decode(logs[i].data, (uint256[], uint256[]));
                assertEq(ids.length, 3, "lines only");
                sawLines = true;
            } else if (logs[i].topics[0] == VoteAllocator.SavingsInterestAttributed.selector) {
                assertEq(uint256(logs[i].topics[1]), e1);
                assertEq(abi.decode(logs[i].data, (uint256)), yield);
                sawSavings = true;
            }
        }
        assertTrue(sawLines && sawSavings);

        // Harvest re-deposits the yield; it is not counted twice.
        savings.harvest();
        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        _rebalance();
        assertEq(recorder.at(1).interest[3], 0);
    }

    /* Illiquid or switched-off savings */

    /// @dev sMUSD stops paying out mid-run: the run does not revert, reports the failed move, funds lines from idle
    /// MUSD above the buffer only and parks nothing more. A re-run once sMUSD pays finishes the move.
    function test_rebalance_illiquidSavings_reportedAndFundsFromIdleOnly() public {
        (uint256 aliceId, uint256 bobId) = _seed();
        _warpEpochs(1);
        _rebalance();

        // Bob moves to cbBTC and carol deposits 500k (parked: sMUSD still takes deposits), then sMUSD stops paying.
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, CBTC_LINE);
        _deposit(carol, 500_000e18);
        assertApproxEqAbs(_parked(), 600_000e18, DUST);
        smusd.freezeWithdrawals(true);
        _warpEpochs(1);

        // 1.5M total: BTC 810k, cbBTC 540k. The veBTC line's 360k comes back and tops up BTC (270k); cbBTC would need
        // 450k from sMUSD, which fails, and the 90k left idle is below the 150k buffer.
        vm.recordLogs();
        _rebalance();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, VoteAllocator.SavingsMoveFailed.selector), 1);
        assertEq(_count(logs, VoteAllocator.MoveFailed.selector), 0);
        assertEq(allocator.lineAssets(VE_LINE), 0);
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), 810_000e18, 2 * DUST);
        assertEq(allocator.lineAssets(CBTC_LINE), 0, "nothing from stuck savings");
        assertApproxEqAbs(_idle(), 90_000e18, 2 * DUST, "kept liquid, not parked");
        assertApproxEqAbs(_parked(), 600_000e18, DUST);

        // Once sMUSD pays again, a re-run finishes the move and parks the rest.
        smusd.freezeWithdrawals(false);
        _rebalance();
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), 540_000e18, 2 * DUST);
        assertEq(_idle(), 0);
        assertApproxEqAbs(_parked(), 150_000e18, 4 * DUST);
    }

    /// @dev The owner can stop parking: the vault's liquidity adapter is unset, the next run brings savings home, and
    /// deposits stay idle; turning it back on parks again.
    function test_setParking_offBringsSavingsHome_onParksAgain() public {
        _seed();
        _warpEpochs(1);
        _rebalance();
        _smusdYield(1_000e18);
        uint256 parked = _parked();
        assertGt(parked, BUFFER);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        allocator.setParking(false);
        vm.expectEmit(address(allocator));
        emit VoteAllocator.ParkingSet(false);
        vm.prank(admin);
        allocator.setParking(false);
        assertEq(vault.liquidityAdapter(), address(0));

        _rebalance();
        assertEq(_parked(), 0);
        assertEq(smusd.balanceOf(address(savings)), 0);
        assertEq(_idle(), parked, "yield included");
        _deposit(carol, 10_000e18);
        assertEq(_idle(), parked + 10_000e18);

        vm.prank(admin);
        allocator.setParking(true);
        assertEq(vault.liquidityAdapter(), address(savings));
        _rebalance();
        assertEq(_idle(), 0);
    }

    /* Peg gate */

    /// @dev While the peg is unhealthy no line gets new money; overweight lines are still pulled and idle MUSD
    /// parked. Once healthy, the next run funds them.
    function test_pegGate_holdsAllocations_deallocationsStillRun() public {
        (uint256 aliceId, uint256 bobId) = _seed();
        vm.prank(admin);
        allocator.setPeg(gatePeg);
        _warpEpochs(1);
        _rebalance();
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), 540_000e18, DUST);

        // Votes move from veBTC to cbBTC while the peg breaks.
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, CBTC_LINE);
        _warpEpochs(1);
        gatePeg.set(false);
        assertFalse(allocator.pegGateOpen());
        _deposit(carol, 500_000e18);

        vm.expectEmit(address(allocator));
        emit VoteAllocator.PegUnhealthy(_currentEpoch());
        _rebalance();
        assertEq(allocator.lineAssets(VE_LINE), 0, "unvoted line still pulled");
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), 540_000e18, DUST, "no new money");
        assertEq(allocator.lineAssets(CBTC_LINE), 0, "no new money");
        assertEq(_idle(), 0, "freed cash parked");
        assertApproxEqAbs(_parked(), 960_000e18, DUST);

        // A monitor that reverts counts as unhealthy.
        gatePeg.set(true);
        gatePeg.breakIt();
        assertFalse(allocator.pegGateOpen());
        _rebalance();
        assertEq(allocator.lineAssets(CBTC_LINE), 0);

        // Healthy again: the next run funds the lines.
        gatePeg.fix();
        assertTrue(allocator.pegGateOpen());
        _rebalance();
        uint256 deployable = _deployableNow();
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), deployable * 6 / 10, 2 * DUST);
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), deployable * 4 / 10, 2 * DUST);
    }

    function test_pegGate_noPegMeansOpen() public view {
        assertEq(address(allocator.peg()), address(0));
        assertTrue(allocator.pegGateOpen());
    }

    /* Reads */

    function _deployableNow() internal view returns (uint256) {
        return vault.totalAssets() * (BPS - IDLE_BUFFER_BPS) / BPS;
    }
}

/// @notice A contract that answers `asset()` like a VaultV2, to deploy a SavingsAdapter for another vault.
contract MockVaultAsset {
    address public immutable asset;

    constructor(address asset_) {
        asset = asset_;
    }
}
