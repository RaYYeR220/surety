// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {Position} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {EventsLib} from "vault-v2/libraries/EventsLib.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {SuretyPool} from "../../src/SuretyPool.sol";
import {VoteAllocator} from "../../src/VoteAllocator.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../../src/interfaces/IEscrowRegistry.sol";
import {ISuretyPool} from "../../src/interfaces/ISuretyPool.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {AllocatorFixture} from "../utils/AllocatorFixture.sol";

/// @notice Stand-in for the SuretyPool: records every fee attribution and checkpoint, and can pay covers.
contract RecordingPool is ISuretyPool {
    struct Attribution {
        address caller;
        uint256 cohortEpoch;
        uint256[] lineIds;
        uint256[] interest;
    }

    Attribution[] internal attributions;
    /// @dev Line ids passed to `checkpoint`, in call order.
    uint256[] internal checkpointed;
    /// @dev Number of attributions at the time of each checkpoint, to check ordering against distributeFees.
    uint256[] internal attributionsAtCheckpoint;
    /// @dev Checkpoints of this line revert.
    uint256 internal failingLine = type(uint256).max;

    error CheckpointBroken();

    function checkpoint(uint256 lineId) external returns (uint256) {
        if (lineId == failingLine) revert CheckpointBroken();
        checkpointed.push(lineId);
        attributionsAtCheckpoint.push(attributions.length);
        return 0;
    }

    function failCheckpoint(uint256 lineId) external {
        failingLine = lineId;
    }

    function checkpointCount() external view returns (uint256) {
        return checkpointed.length;
    }

    function checkpointAt(uint256 i) external view returns (uint256 lineId, uint256 attributionsBefore) {
        return (checkpointed[i], attributionsAtCheckpoint[i]);
    }

    function distributeFees(uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest) external {
        attributions.push(Attribution(msg.sender, cohortEpoch, lineIds, interest));
    }

    function count() external view returns (uint256) {
        return attributions.length;
    }

    function at(uint256 i) external view returns (Attribution memory) {
        return attributions[i];
    }

    /// @notice What SuretyPool.cover does for a veBTC line: pay MUSD into it.
    function cover(VeBTCCreditLine line, uint256 assets) external {
        IERC20(address(line.musd())).approve(address(line), assets);
        line.receiveCover(assets);
    }
}

/// @notice VoteAllocator against the real VaultV2, Morpho Blue markets, VeBTCCreditLine and CreditVoter.
/// @dev Voters lock permanently in the fixture's first epoch (E0), so they can vote from E1 on. Unless a test says
/// otherwise, lenders deposit 1,000,000 MUSD and the idle buffer is 10%, so 900,000 MUSD is deployable.
contract VoteAllocatorTest is AllocatorFixture {
    uint256 internal constant DEPOSIT = 1_000_000e18;
    uint256 internal constant DEPLOYABLE = 900_000e18;
    /// @dev Morpho rounds supply positions down by a few wei.
    uint256 internal constant DUST = 2;

    RecordingPool internal recorder;
    address internal btcBorrower = makeAddr("btcBorrower");
    /// @dev Debt of the last loan `_liquidateAtLoss` sold, read in the block of the bid.
    uint256 internal lastDebt;

    function setUp() public override {
        super.setUp();
        recorder = new RecordingPool();
        vm.label(address(recorder), "RecordingPool");
        vm.prank(admin);
        allocator.setSuretyPool(address(recorder));
    }

    /* Scenarios */

    /// @dev Deposit, lock alice 6 BTC and bob 4 BTC, warp to E1, alice votes BTC line, bob votes veBTC line.
    function _seed60_40() internal returns (uint256 aliceId, uint256 bobId) {
        _deposit(lender, DEPOSIT);
        aliceId = _voterLock(alice, 6e18);
        bobId = _voterLock(bob, 4e18);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, VE_LINE);
    }

    /// @dev Repays `user`'s whole Morpho debt on the BTC market.
    function _repayMorpho(address user) internal {
        Position memory p = morpho.position(btcMarketId, user);
        uint256 budget = morpho.market(btcMarketId).totalBorrowAssets * 2 + 1e18;
        musd.mint(user, budget);
        vm.startPrank(user);
        musd.approve(address(morpho), budget);
        morpho.repay(btcMarket, 0, p.borrowShares, user, "");
        vm.stopPrank();
    }

    function _assets() internal view returns (uint256 btcAssets, uint256 veAssets, uint256 cbtcAssets) {
        return (allocator.lineAssets(BTC_LINE), allocator.lineAssets(VE_LINE), allocator.lineAssets(CBTC_LINE));
    }

    /* Splitting */

    function test_rebalance_splitsByVotes() public {
        _seed60_40();
        uint256 e1 = _currentEpoch();
        _warpEpochs(1);
        _rebalance();

        assertEq(allocator.activeTallyEpoch(), e1);
        assertEq(allocator.lastRebalanceEpoch(), _currentEpoch());
        (uint256 btcAssets, uint256 veAssets, uint256 cbtcAssets) = _assets();
        assertApproxEqAbs(btcAssets, DEPLOYABLE * 6 / 10, DUST);
        assertEq(veAssets, DEPLOYABLE * 4 / 10);
        assertEq(cbtcAssets, 0);
        assertEq(_idle(), DEPOSIT - DEPLOYABLE);
        assertEq(musd.balanceOf(address(allocator)), 0);

        (uint256[] memory lineIds, uint256[] memory targetAssets) = allocator.targets();
        assertEq(lineIds.length, 3);
        assertEq(lineIds[CBTC_LINE], CBTC_LINE);
        assertApproxEqAbs(targetAssets[BTC_LINE], btcAssets, DUST);
        assertApproxEqAbs(targetAssets[VE_LINE], veAssets, DUST);
        assertEq(targetAssets[CBTC_LINE], 0);
    }

    function test_rebalance_bootstrapUsesCurrentTally() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        uint256 e1 = _currentEpoch();

        // E0 has no votes, so the live E1 tally drives the allocation.
        _rebalance();
        assertEq(allocator.activeTallyEpoch(), e1);
        (uint256 btcAssets, uint256 veAssets,) = _assets();
        assertApproxEqAbs(btcAssets, 540_000e18, DUST);
        assertEq(veAssets, 360_000e18);

        // While bootstrapping, a re-run inside the epoch follows ballots as they change.
        _vote(bob, bobId, BTC_LINE);
        _rebalance();
        (btcAssets, veAssets,) = _assets();
        assertApproxEqAbs(btcAssets, DEPLOYABLE, DUST);
        assertEq(veAssets, 0);
        assertEq(recorder.count(), 0);

        // Once E1 has closed with votes it drives the allocation; E2's live ballots wait for E3.
        _warpEpochs(1);
        _vote(alice, aliceId, CBTC_LINE);
        _rebalance();
        assertEq(allocator.activeTallyEpoch(), e1);
        (btcAssets, veAssets,) = _assets();
        assertApproxEqAbs(btcAssets, DEPLOYABLE, DUST);
        assertEq(allocator.lineAssets(CBTC_LINE), 0);
        // E1's interest (none: no borrowers) is attributed to the bootstrap cohort.
        assertEq(recorder.count(), 1);
        assertEq(recorder.at(0).cohortEpoch, e1);
    }

    function test_rebalance_unvotedLineDeallocated() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        _rebalance();
        assertEq(allocator.lineAssets(VE_LINE), 360_000e18);

        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, BTC_LINE);
        _warpEpochs(1);
        _rebalance();

        assertEq(allocator.lineAssets(VE_LINE), 0);
        assertEq(line.cash(), 0);
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), DEPLOYABLE, DUST);
        assertApproxEqAbs(_idle(), DEPOSIT - DEPLOYABLE, DUST);
    }

    function test_rebalance_deactivatedLineExcluded() public {
        _seed60_40();
        uint256 e1 = _currentEpoch();
        _warpEpochs(1);
        _rebalance();

        vm.prank(admin);
        voter.setLineActive(VE_LINE, false);
        // The tally still counts the deactivated line's votes; the allocator must not divide by it.
        assertEq(voter.totalVotes(e1), 10e18);

        _rebalance();
        (uint256 btcAssets, uint256 veAssets,) = _assets();
        assertEq(veAssets, 0);
        assertApproxEqAbs(btcAssets, DEPLOYABLE, DUST);
        (, uint256[] memory targetAssets) = allocator.targets();
        assertEq(targetAssets[VE_LINE], 0);
    }

    function test_rebalance_respectsVaultCaps() public {
        _deposit(lender, DEPOSIT);
        uint256 aliceId = _voterLock(alice, 4e18);
        uint256 bobId = _voterLock(bob, 3e18);
        uint256 carolId = _voterLock(carol, 3e18);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, VE_LINE);
        _vote(carol, carolId, CBTC_LINE);
        _warpEpochs(1);

        // Shares by votes: BTC 360k, veBTC 270k, cbBTC 270k.
        vm.startPrank(admin);
        vault.decreaseAbsoluteCap(LineIds.adapterIdData(address(line)), 100_000e18);
        vault.decreaseRelativeCap(LineIds.collateralIdData(address(btc)), 0.3e18);
        // Shared by both Morpho lines.
        vault.decreaseAbsoluteCap(LineIds.adapterIdData(address(morphoAdapter)), 500_000e18);
        vm.stopPrank();

        vm.recordLogs();
        _rebalance();
        _assertNoFailedMoves();

        (uint256 btcAssets, uint256 veAssets, uint256 cbtcAssets) = _assets();
        // 30% relative cap of 1M on the BTC collateral id.
        assertApproxEqAbs(btcAssets, 300_000e18, DUST);
        // Absolute cap on the veBTC line's adapter id.
        assertEq(veAssets, 100_000e18);
        // What the shared Morpho adapter cap leaves after the BTC line.
        assertApproxEqAbs(cbtcAssets, 200_000e18, DUST);
        assertLe(vault.allocation(LineIds.adapterId(address(morphoAdapter))), 500_000e18);
        assertApproxEqAbs(_idle(), 400_000e18, 2 * DUST);

        (, uint256[] memory targetAssets) = allocator.targets();
        assertApproxEqAbs(targetAssets[BTC_LINE], 300_000e18, DUST);
        assertEq(targetAssets[VE_LINE], 100_000e18);
        assertApproxEqAbs(targetAssets[CBTC_LINE], 200_000e18, 2 * DUST);

        // A cap lowered below a live allocation pulls capital back on the next run.
        vm.prank(admin);
        vault.decreaseAbsoluteCap(LineIds.marketParamsIdData(address(morphoAdapter), cbtcMarket), 50_000e18);
        _rebalance();
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), 50_000e18, DUST);
    }

    /// @dev Both Morpho lines share the adapter id. When votes swap between them, the room one gets on the shared cap
    /// counts what the other releases, so a single run reaches the new split.
    function test_rebalance_sharedCapSwapConvergesInOneRun() public {
        _deposit(lender, DEPOSIT);
        uint256 aliceId = _voterLock(alice, 4e18);
        uint256 bobId = _voterLock(bob, 4e18);
        uint256 carolId = _voterLock(carol, 2e18);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, VE_LINE);
        _vote(carol, carolId, CBTC_LINE);
        vm.prank(admin);
        vault.decreaseAbsoluteCap(LineIds.adapterIdData(address(morphoAdapter)), 600_000e18);
        _warpEpochs(1);
        _rebalance();
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), 360_000e18, DUST);
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), 180_000e18, DUST);

        _vote(alice, aliceId, CBTC_LINE);
        _vote(bob, bobId, VE_LINE);
        _vote(carol, carolId, BTC_LINE);
        _warpEpochs(1);
        (, uint256[] memory planned) = allocator.targets();
        assertApproxEqAbs(planned[BTC_LINE], 180_000e18, DUST);
        assertApproxEqAbs(planned[CBTC_LINE], 360_000e18, DUST);

        vm.recordLogs();
        _rebalance();
        _assertNoFailedMoves();
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), 180_000e18, DUST);
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), 360_000e18, 2 * DUST);
        assertEq(allocator.lineAssets(VE_LINE), 360_000e18);
    }

    /* Fail-closed and illiquid lines */

    function test_rebalance_staleOracleLineTargetsZero() public {
        _deposit(lender, DEPOSIT);
        uint256 aliceId = _voterLock(alice, 6e18);
        uint256 bobId = _voterLock(bob, 2e18);
        uint256 carolId = _voterLock(carol, 2e18);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, VE_LINE);
        _vote(carol, carolId, CBTC_LINE);
        _warpEpochs(1);
        _rebalance();
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), 180_000e18, DUST);

        // cbBTC's feed goes stale: its line drops out and its votes stop counting.
        cbtcAggregator.setUpdatedAt(vm.getBlockTimestamp() - ORACLE_MAX_AGE - 1);
        _rebalance();
        (uint256 btcAssets, uint256 veAssets, uint256 cbtcAssets) = _assets();
        assertEq(cbtcAssets, 0);
        assertApproxEqAbs(btcAssets, DEPLOYABLE * 6 / 8, DUST);
        assertApproxEqAbs(veAssets, DEPLOYABLE * 2 / 8, DUST);

        // The BTC feed goes stale instead: the BTC Morpho line and the veBTC line both price with it.
        cbtcAggregator.setLive();
        _makeStale();
        _rebalance();
        (btcAssets, veAssets, cbtcAssets) = _assets();
        assertEq(btcAssets, 0);
        assertEq(veAssets, 0);
        assertApproxEqAbs(cbtcAssets, DEPLOYABLE, 2 * DUST);

        // Feeds recover: back to the vote split.
        aggregator.setLive();
        _rebalance();
        (btcAssets, veAssets, cbtcAssets) = _assets();
        assertApproxEqAbs(btcAssets, 540_000e18, 4 * DUST);
        assertApproxEqAbs(veAssets, 180_000e18, 4 * DUST);
        assertApproxEqAbs(cbtcAssets, 180_000e18, 4 * DUST);
    }

    function test_rebalance_pausedLineTargetsZero() public {
        _seed60_40();
        _warpEpochs(1);
        _rebalance();

        vm.prank(admin);
        line.pause(true);
        _rebalance();
        assertEq(allocator.lineAssets(VE_LINE), 0);
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), DEPLOYABLE, DUST);
    }

    /// @dev Review Focus 4: a fully borrowed Morpho market and a veBTC line whose cash is below its cut.
    function test_rebalance_illiquidLine_partialNoRevert_thenCompletes() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        _rebalance();

        // Borrow the BTC market dry and lend out most of the veBTC line.
        _borrowMorpho(btcBorrower, 10e18, morpho.market(btcMarketId).totalSupplyAssets);
        (uint256 loanId,) = _openTimed(borrower, 10e18, 300_000e18);
        assertEq(line.cash(), 60_000e18);

        // E2 ballots move everything to cbBTC.
        _vote(alice, aliceId, CBTC_LINE);
        _vote(bob, bobId, CBTC_LINE);
        _warpEpochs(1);

        uint256 btcBefore = allocator.lineAssets(BTC_LINE);
        uint256 veBefore = allocator.lineAssets(VE_LINE);
        vm.recordLogs();
        _rebalance();
        _assertNoFailedMoves();

        // Nothing is free in the Morpho market, so nothing leaves it; the veBTC line gives back all its cash.
        assertEq(allocator.lineAssets(BTC_LINE), btcBefore);
        assertEq(line.cash(), 0);
        assertEq(allocator.lineAssets(VE_LINE), veBefore - 60_000e18);
        // cbBTC got everything above the idle buffer.
        uint256 buffer = vault.totalAssets() * IDLE_BUFFER_BPS / BPS;
        assertApproxEqAbs(_idle(), buffer, 2 * DUST);
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), 160_000e18 - buffer, 2 * DUST);
        assertEq(recorder.count(), 1);

        // Liquidity comes back; re-running inside the epoch finishes the move.
        _repayMorpho(btcBorrower);
        _repay(borrower, loanId, type(uint256).max);
        _rebalance();

        assertEq(allocator.lineAssets(BTC_LINE), 0);
        assertEq(allocator.lineAssets(VE_LINE), 0);
        assertApproxEqAbs(allocator.lineAssets(CBTC_LINE), _deployable(), 4 * DUST);
        assertEq(recorder.count(), 1);
    }

    /* Fee attribution */

    function test_rebalance_distributesInterestOncePerEpoch() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        uint256 e1 = _currentEpoch();
        _warpEpochs(1);
        uint256 e2 = _currentEpoch();
        _rebalance();
        // Nothing to attribute on the first rebalance.
        assertEq(recorder.count(), 0);

        _borrowMorpho(btcBorrower, 10e18, 270_000e18);
        _openTimed(borrower, 10e18, 180_000e18);
        uint256 btcStart = allocator.lineAssets(BTC_LINE);
        uint256 veStart = allocator.lineAssets(VE_LINE);

        // A mid-epoch re-run measures interest and keeps it for the next attribution.
        _warp(2 days);
        uint256 btcMidPre = allocator.lineAssets(BTC_LINE);
        uint256 veMidPre = allocator.lineAssets(VE_LINE);
        _rebalance();
        uint256 btcMidPost = allocator.lineAssets(BTC_LINE);
        uint256 veMidPost = allocator.lineAssets(VE_LINE);
        assertEq(recorder.count(), 0);
        assertEq(allocator.ledger(BTC_LINE).pendingInterest, btcMidPre - btcStart);

        // Ballots carried into E2 make it the next tally.
        voter.poke(aliceId);
        voter.poke(bobId);

        _warpEpochs(1);
        uint256 btcEndPre = allocator.lineAssets(BTC_LINE);
        uint256 veEndPre = allocator.lineAssets(VE_LINE);
        _rebalance();

        assertEq(recorder.count(), 1);
        RecordingPool.Attribution memory a = recorder.at(0);
        assertEq(a.caller, address(allocator));
        // Interest earned while E1's tally drove the allocation belongs to the E1 cohort.
        assertEq(a.cohortEpoch, e1);
        assertEq(a.lineIds.length, 3);
        assertEq(a.lineIds[VE_LINE], VE_LINE);
        uint256 btcInterest = (btcMidPre - btcStart) + (btcEndPre - btcMidPost);
        uint256 veInterest = (veMidPre - veStart) + (veEndPre - veMidPost);
        assertGt(btcInterest, 0);
        assertGt(veInterest, 0);
        assertEq(a.interest[BTC_LINE], btcInterest);
        assertEq(a.interest[VE_LINE], veInterest);
        assertEq(a.interest[CBTC_LINE], 0);
        assertEq(allocator.activeTallyEpoch(), e2);

        // Re-running in the same epoch never attributes twice.
        _warp(1 days);
        _rebalance();
        _rebalance();
        assertEq(recorder.count(), 1);

        // Next epoch: the E2 cohort, whose tally drove the allocation through E3.
        _warpEpochs(1);
        _rebalance();
        assertEq(recorder.count(), 2);
        assertEq(recorder.at(1).cohortEpoch, e2);
        assertGt(recorder.at(1).interest[BTC_LINE], 0);
    }

    function test_rebalance_withoutPool_skipsAttribution() public {
        VoteAllocator bare = new VoteAllocator(address(vault), voter, admin, IDLE_BUFFER_BPS);
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (address(bare), true)));
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (address(allocator), false)));

        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        uint256 e2 = _currentEpoch();
        bare.rebalance();
        _borrowMorpho(btcBorrower, 10e18, 270_000e18);
        voter.poke(aliceId);
        voter.poke(bobId);
        _warp(1 days);
        bare.rebalance();
        assertGt(bare.ledger(BTC_LINE).pendingInterest, 0);

        // The epoch still closes and switches tally; the interest it measured is dropped, not carried over.
        _warpEpochs(1);
        bare.rebalance();
        assertEq(recorder.count(), 0);
        assertEq(bare.activeTallyEpoch(), e2);
        assertEq(bare.ledger(BTC_LINE).pendingInterest, 0);
    }

    /// @dev A veBTC loss recorded and covered between two rebalances moves the line's assets down and back up; the
    /// line still reports exactly the interest its loan paid (up to the wei the borrow rounds up at open).
    function test_measure_lossAndCoverNotCountedAsInterest() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        _rebalance();
        vm.prank(admin);
        line.setSuretyPool(address(recorder));

        (uint256 loanId,) = _openTimed(borrower, 3e18, 100_000e18);
        _warp(2 days);
        uint256 shortfall = _liquidateAtLoss(loanId);
        uint256 earned = lastDebt - 100_000e18;
        assertGt(shortfall, earned);

        // A cover larger than the loss, as the pool's fee gross-up makes it.
        musd.mint(address(recorder), shortfall * 2);
        recorder.cover(line, shortfall * 2);

        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        _rebalance();
        assertApproxEqAbs(recorder.at(0).interest[VE_LINE], earned, 1);
    }

    /// @dev A loss nobody has recorded when the rebalance runs does not hide the interest the line earned before it,
    /// and is never read as negative interest later.
    function test_measure_unrecordedLossDoesNotHideInterest() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        _rebalance();

        (uint256 loanId,) = _openTimed(borrower, 3e18, 100_000e18);
        _warp(2 days);
        uint256 shortfall = _liquidateAtLoss(loanId);
        uint256 earned = lastDebt - 100_000e18;
        assertGt(shortfall, earned);

        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        _rebalance();
        assertApproxEqAbs(recorder.at(0).interest[VE_LINE], earned, 1, "interest paid before the loss");

        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        _rebalance();
        assertEq(recorder.at(1).interest[VE_LINE], 0, "no loan, no interest; the loss is not netted");
    }

    /// @dev Capital anyone moves with VaultV2's permissionless forceDeallocate changes a line's assets but not its
    /// measured interest: Morpho interest comes from the supply share price, veBTC interest from the line's counter.
    function test_measure_forceDeallocateDoesNotMoveInterest() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        _rebalance();
        _borrowMorpho(btcBorrower, 10e18, 270_000e18);
        _openTimed(borrower, 10e18, 180_000e18);
        _warp(3 days);
        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        uint256 snap = vm.snapshotState();

        _rebalance();
        uint256[] memory honest = recorder.at(0).interest;
        assertGt(honest[BTC_LINE], 0);
        assertGt(honest[VE_LINE], 0);

        vm.revertToState(snap);
        _deposit(carol, 10_000e18);
        uint256 btcAssets = allocator.lineAssets(BTC_LINE);
        vm.startPrank(carol);
        vault.forceDeallocate(address(morphoAdapter), abi.encode(btcMarket), btcAssets / 100, carol);
        vault.forceDeallocate(address(line), "", line.cash() / 2, carol);
        vm.stopPrank();
        _rebalance();
        assertEq(recorder.at(0).interest[BTC_LINE], honest[BTC_LINE], "Morpho interest unchanged");
        assertEq(recorder.at(0).interest[VE_LINE], honest[VE_LINE], "veBTC interest unchanged");
    }

    /// @dev Crashes the price by 90%, auctions `loanId` and bids at once; returns the shortfall.
    function _liquidateAtLoss(uint256 loanId) internal returns (uint256 shortfall) {
        _shock(9000);
        line.startAuction(loanId);
        lastDebt = line.debtOf(loanId);
        _bid(bidder, loanId);
        shortfall = line.badDebtTotal();
        assertGt(shortfall, 0);
    }

    /* Loss checkpoints */

    /// @dev Every listed line is checkpointed twice on every run, before measuring and after the moves, both before
    /// the epoch's fees are handed to the pool.
    function test_rebalance_checkpointsEveryLineBeforeMeasuring() public {
        (uint256 aliceId, uint256 bobId) = _seed60_40();
        _warpEpochs(1);
        _rebalance();
        assertEq(recorder.checkpointCount(), 6);
        for (uint256 i; i < 6; ++i) {
            (uint256 lineId, uint256 attributionsBefore) = recorder.checkpointAt(i);
            assertEq(lineId, i % 3);
            assertEq(attributionsBefore, 0);
        }

        voter.poke(aliceId);
        voter.poke(bobId);
        _warpEpochs(1);
        _rebalance();
        assertEq(recorder.count(), 1);
        assertEq(recorder.checkpointCount(), 12);
        for (uint256 i = 6; i < 12; ++i) {
            (uint256 lineId, uint256 attributionsBefore) = recorder.checkpointAt(i);
            assertEq(lineId, i % 3);
            assertEq(attributionsBefore, 0, "checkpointed before the epoch's fees were attributed");
        }
    }

    /// @dev A checkpoint that reverts is reported and skipped; capital still moves and the epoch still closes.
    function test_rebalance_failedCheckpoint_reportedNotBlocking() public {
        _seed60_40();
        recorder.failCheckpoint(VE_LINE);

        vm.expectEmit(address(allocator));
        emit VoteAllocator.CheckpointFailed(VE_LINE, abi.encodeWithSelector(RecordingPool.CheckpointBroken.selector));
        _rebalance();

        assertEq(recorder.checkpointCount(), 4, "the other two lines, before and after the moves");
        (uint256 btcAssets, uint256 veAssets,) = _assets();
        assertApproxEqAbs(btcAssets, 540_000e18, DUST);
        assertEq(veAssets, 360_000e18);
        assertEq(allocator.lastRebalanceEpoch(), _currentEpoch());
    }

    /* Idempotence */

    function test_rebalance_rerunIsIdempotent() public {
        // Outside supply and accrued interest put the BTC market's share price off 1:1, so the vault's position there
        // rounds down by a wei and total assets with it; a re-run must not chase that dust.
        address supplier = makeAddr("supplier");
        musd.mint(supplier, 1_000e18);
        vm.startPrank(supplier);
        musd.approve(address(morpho), 1_000e18);
        morpho.supply(btcMarket, 1_000e18, 0, supplier, "");
        vm.stopPrank();
        _borrowMorpho(btcBorrower, 1e18, 700e18);

        _seed60_40();
        _warpEpochs(1);
        _rebalance();

        (uint256 btcAssets, uint256 veAssets, uint256 cbtcAssets) = _assets();
        assertLt(btcAssets, 540_000e18);
        uint256 idle = _idle();
        uint256 tally = allocator.activeTallyEpoch();

        vm.recordLogs();
        _rebalance();
        _rebalance();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            assertTrue(logs[i].topics[0] != EventsLib.Allocate.selector, "allocated on re-run");
            assertTrue(logs[i].topics[0] != EventsLib.Deallocate.selector, "deallocated on re-run");
        }

        (uint256 btcAfter, uint256 veAfter, uint256 cbtcAfter) = _assets();
        assertEq(btcAfter, btcAssets);
        assertEq(veAfter, veAssets);
        assertEq(cbtcAfter, cbtcAssets);
        assertEq(_idle(), idle);
        assertEq(allocator.activeTallyEpoch(), tally);
        assertEq(recorder.count(), 0);
    }

    function testFuzz_rebalance_splitsWithinDeployable(uint256 deposit, uint256 a, uint256 b, uint256 c) public {
        // Below the veBTC line's LINE_CAP, so only votes decide the split.
        deposit = bound(deposit, 1e18, 1e26);
        a = bound(a, 1e12, 1e22);
        b = bound(b, 1e12, 1e22);
        c = bound(c, 1e12, 1e22);
        _deposit(lender, deposit);
        uint256 aliceId = _voterLock(alice, a);
        uint256 bobId = _voterLock(bob, b);
        uint256 carolId = _voterLock(carol, c);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _vote(bob, bobId, VE_LINE);
        _vote(carol, carolId, CBTC_LINE);
        _warpEpochs(1);
        _rebalance();

        uint256 deployable = deposit * (BPS - IDLE_BUFFER_BPS) / BPS;
        uint256 sum = a + b + c;
        (uint256 btcAssets, uint256 veAssets, uint256 cbtcAssets) = _assets();
        assertApproxEqAbs(btcAssets, deployable * a / sum, DUST);
        assertEq(veAssets, deployable * b / sum);
        assertApproxEqAbs(cbtcAssets, deployable * c / sum, DUST);
        assertLe(btcAssets + veAssets + cbtcAssets, deployable);
        assertGe(_idle(), deposit - deployable);
    }

    /* Guarantees and admin */

    /// @dev The allocator's whole external surface is pinned; its only capital moves are VaultV2 allocate and
    /// deallocate, which VaultV2 restricts to its adapters, so even a line listed with a foreign contract as its
    /// "adapter" receives nothing. The allocator itself never holds MUSD or vault shares.
    function test_onlyVaultOpsPossible() public {
        // State-changing: rebalance (permissionless), setMaxRate / setSuretyPool and the
        // Ownable2Step functions (owner). Everything else is a view.
        string[21] memory surface = [
            "BPS()",
            "EPOCH_LENGTH()",
            "acceptOwnership()",
            "activeTallyEpoch()",
            "asset()",
            "idleBufferBps()",
            "lastRebalanceEpoch()",
            "ledger(uint256)",
            "lineAssets(uint256)",
            "owner()",
            "pendingOwner()",
            "rebalance()",
            "renounceOwnership()",
            "setMaxRate(uint256)",
            "setSuretyPool(address)",
            "suretyPool()",
            "targets()",
            "trackedLines()",
            "transferOwnership(address)",
            "vault()",
            "voter()"
        ];
        string memory artifact = vm.readFile("out/VoteAllocator.sol/VoteAllocator.json");
        string[] memory abiSigs = vm.parseJsonKeys(artifact, ".methodIdentifiers");
        assertEq(abiSigs.length, surface.length, "external surface changed");
        for (uint256 i; i < abiSigs.length; ++i) {
            bool known;
            for (uint256 j; j < surface.length; ++j) {
                if (keccak256(bytes(abiSigs[i])) == keccak256(bytes(surface[j]))) known = true;
            }
            assertTrue(known, abiSigs[i]);
        }

        // Every state-changing entry point other than rebalance is restricted.
        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        allocator.setMaxRate(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        allocator.setSuretyPool(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        allocator.transferOwnership(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        allocator.renounceOwnership();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        allocator.acceptOwnership();
        vm.stopPrank();

        // A line whose adapter is no longer one of the vault's: a working VeBTCCreditLine on the same vault, listed
        // in the voter while it was an adapter (the CreditVoter refuses anything else) and even given caps, then
        // removed by the curator, so the allocator does try to fund it.
        VeBTCCreditLine rogue = new VeBTCCreditLine(
            address(vault), musd, ve, poolsVoter, distributor, stressedSource, lineIrm, _lineParams(), stranger
        );
        vm.expectRevert(CreditVoter.NotVaultAdapter.selector);
        vm.prank(admin);
        voter.addLine(address(rogue), "", ICreditVoter.LineKind.VeBTC, "rogue");
        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(rogue))));
        vm.prank(admin);
        uint256 rogueLine = voter.addLine(address(rogue), "", ICreditVoter.LineKind.VeBTC, "rogue");
        _setCaps(LineIds.adapterIdData(address(rogue)), LINE_CAP);
        _curate(abi.encodeCall(IVaultV2.removeAdapter, (address(rogue))));

        (uint256 aliceId,) = _seed60_40();
        _vote(alice, aliceId, rogueLine);
        _warpEpochs(1);

        vm.expectEmit(true, false, false, false, address(allocator));
        emit VoteAllocator.MoveFailed(rogueLine, true, 0, "");
        _rebalance();

        assertEq(musd.balanceOf(address(rogue)), 0);
        assertEq(allocator.lineAssets(rogueLine), 0);
        assertEq(allocator.lineAssets(BTC_LINE), 0);
        assertEq(allocator.lineAssets(VE_LINE), 360_000e18);
        assertEq(musd.balanceOf(address(allocator)), 0);
        assertEq(vault.balanceOf(address(allocator)), 0);
        // Everything not sent to a real adapter stayed in the vault.
        assertEq(_idle(), DEPOSIT - 360_000e18);
    }

    function test_setMaxRate_boundedAndForwarded() public {
        vm.prank(admin);
        allocator.setMaxRate(1e9);
        assertEq(vault.maxRate(), 1e9);

        vm.expectRevert(VoteAllocator.MaxRateTooHigh.selector);
        vm.prank(admin);
        allocator.setMaxRate(MAX_MAX_RATE + 1);

        vm.prank(admin);
        allocator.setMaxRate(MAX_MAX_RATE);
        assertEq(vault.maxRate(), MAX_MAX_RATE);
    }

    function test_setSuretyPool_oneShot() public {
        vm.expectRevert(VoteAllocator.SuretyPoolAlreadySet.selector);
        vm.prank(admin);
        allocator.setSuretyPool(address(1));

        VoteAllocator bare = new VoteAllocator(address(vault), voter, admin, IDLE_BUFFER_BPS);
        vm.expectRevert(VoteAllocator.ZeroAddress.selector);
        vm.prank(admin);
        bare.setSuretyPool(address(0));
        assertEq(allocator.suretyPool(), address(recorder));
    }

    function test_constructor_validates() public {
        vm.expectRevert(VoteAllocator.BadIdleBuffer.selector);
        new VoteAllocator(address(vault), voter, admin, BPS + 1);
        vm.expectRevert(VoteAllocator.ZeroAddress.selector);
        new VoteAllocator(address(0), voter, admin, IDLE_BUFFER_BPS);
        vm.expectRevert(VoteAllocator.ZeroAddress.selector);
        new VoteAllocator(address(vault), ICreditVoter(address(0)), admin, IDLE_BUFFER_BPS);

        assertEq(address(allocator.vault()), address(vault));
        assertEq(address(allocator.asset()), address(musd));
        assertEq(allocator.EPOCH_LENGTH(), EPOCH_LENGTH);
        assertEq(allocator.idleBufferBps(), IDLE_BUFFER_BPS);
    }

    /* Helpers */

    function _assertNoFailedMoves() internal view {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(allocator)) continue;
            assertTrue(logs[i].topics[0] != VoteAllocator.MoveFailed.selector, "move failed");
        }
    }
}

/// @notice VoteAllocator wired to the real SuretyPool: losses are checkpointed inside rebalance, before interest is
/// measured.
contract VoteAllocatorLossTest is AllocatorFixture {
    address internal btcBorrower = makeAddr("btcBorrower");

    function setUp() public override {
        super.setUp();
        pool = new SuretyPool(
            address(vault),
            voter,
            IERC20(address(musd)),
            morpho,
            address(morphoAdapter),
            IEscrowRegistry(address(line)),
            admin,
            SEASON
        );
        vm.startPrank(admin);
        voter.setEscrowRegistry(IEscrowRegistry(address(line)));
        line.setSuretyPool(address(pool));
        pool.setAllocator(address(allocator));
        allocator.setSuretyPool(address(pool));
        vm.stopPrank();
        _curate(abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(pool))));
        _curate(abi.encodeCall(IVaultV2.setPerformanceFee, (VOTER_FEE)));
    }

    /// @dev Morpho bad debt realised between two rebalances is recorded by the next one before it measures. The loss
    /// is measured from the mark the previous rebalance set, so it is net of the interest earned since: the drop is
    /// fully explained by the recorded loss plus that interest, and none of it is attributed as interest.
    function test_rebalance_recordsMorphoBadDebtBetweenEpochs_notInterest() public {
        _deposit(lender, 100_000e18);
        uint256 aliceId = _voterLock(alice, 1e18);
        _warpEpochs(1);
        _vote(alice, aliceId, BTC_LINE);
        _warpEpochs(1);
        _rebalance();
        (,, bool markSet,) = pool.highWaterMark(BTC_LINE);
        assertTrue(markSet, "first rebalance set the loss mark");
        assertApproxEqAbs(allocator.lineAssets(BTC_LINE), 90_000e18, 2);
        uint256 position = allocator.lineAssets(BTC_LINE);

        _borrowMorpho(btcBorrower, 1e18, 60_000e18);
        _warp(3 days);
        uint256 preLoss = allocator.lineAssets(BTC_LINE);
        uint256 earned = preLoss - position;
        assertGt(earned, 0);

        _shock(6000);
        _liquidateMorpho(liquidator, btcBorrower);
        uint256 drop = preLoss - allocator.lineAssets(BTC_LINE);
        assertGt(drop, earned, "the loss alone would wipe the period's interest");
        assertEq(pool.lossRecorded(BTC_LINE), 0);

        voter.poke(aliceId);
        _warpEpochs(1);
        vm.recordLogs();
        _rebalance();

        uint256 loss = pool.lossRecorded(BTC_LINE);
        assertApproxEqAbs(loss, drop - earned, 2, "the rebalance records the loss below the mark");
        assertEq(pool.uncoveredLoss(BTC_LINE), loss);

        uint256[] memory interest = _attributedInterest();
        assertLe(interest[BTC_LINE], 2, "the loss is not attributed as interest");
        assertEq(interest[VE_LINE], 0);

        // Interest earned after the loss is measured from the post-loss snapshot.
        _borrowMorpho(btcBorrower, 1e18, 20_000e18);
        uint256 start = allocator.lineAssets(BTC_LINE);
        _warp(2 days);
        uint256 later = allocator.lineAssets(BTC_LINE);
        voter.poke(aliceId);
        _warpEpochs(1);
        uint256 end = allocator.lineAssets(BTC_LINE);
        vm.recordLogs();
        _rebalance();
        assertGt(later, start);
        assertApproxEqAbs(_attributedInterest()[BTC_LINE], end - start, 2);
        assertEq(pool.lossRecorded(BTC_LINE), loss, "interest never reads as a further loss");
    }

    /// @dev The interest array of the InterestAttributed event in the recorded logs.
    function _attributedInterest() internal view returns (uint256[] memory interest) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(allocator)) continue;
            if (logs[i].topics[0] != VoteAllocator.InterestAttributed.selector) continue;
            (, interest) = abi.decode(logs[i].data, (uint256[], uint256[]));
            return interest;
        }
        revert("no attribution");
    }
}
