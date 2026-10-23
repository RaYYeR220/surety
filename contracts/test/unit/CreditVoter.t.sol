// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../../src/interfaces/IEscrowRegistry.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";

/// @notice Stand-in for VeBTCCreditLine's escrow lookup.
contract TestEscrowRegistry is IEscrowRegistry {
    mapping(address escrow => address borrower) public borrowerOfEscrow;

    function setEscrow(address escrow, address borrower) external {
        borrowerOfEscrow[escrow] = borrower;
    }

    function isEscrow(address account) external view returns (bool) {
        return borrowerOfEscrow[account] != address(0);
    }
}

/// @notice CreditVoter against the MockVeBTC model of Mezo's veBTC (point-history snapshots, merge, transfer).
/// @dev Standalone from SuretyFixture: the voter only needs veBTC. Locks made at START_TIME with a 28-day duration
/// end at EPOCH0 + 4 weeks, so their power at the start of the next epoch is exactly 3/4 of the amount.
contract CreditVoterTest is Test {
    /// @dev Fri 2026-10-23 16:02:33 UTC, inside the weekly epoch that started Thu 2026-10-22 00:00 UTC (EPOCH0).
    uint256 internal constant START_TIME = 1792771353;
    uint256 internal constant EPOCH0 = 1792627200;
    uint256 internal constant START_BLOCK = 12_705_315;
    uint256 internal constant BLOCK_TIME = 3;
    uint256 internal constant EPOCH_LENGTH = 1 weeks;
    uint256 internal constant BPS = 10_000;

    uint256 internal constant BTC_LINE = 0;
    uint256 internal constant BRIDGED_LINE = 1;
    uint256 internal constant VE_LINE = 2;

    MockERC20 internal btc;
    MockVeBTC internal ve;
    CreditVoter internal voter;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");
    address internal morphoAdapter = makeAddr("morphoAdapter");
    address internal veLine = makeAddr("veBTCCreditLine");

    function setUp() public {
        vm.warp(START_TIME);
        vm.roll(START_BLOCK);

        btc = new MockERC20("Bitcoin", "BTC", 18);
        ve = new MockVeBTC(address(btc));
        voter = new CreditVoter(IVeBTC(address(ve)), EPOCH_LENGTH, owner);

        vm.startPrank(owner);
        voter.addLine(morphoAdapter, abi.encode(uint256(1)), ICreditVoter.LineKind.Morpho, "BTC / Morpho");
        voter.addLine(morphoAdapter, abi.encode(uint256(2)), ICreditVoter.LineKind.Morpho, "mcbBTC / Morpho");
        voter.addLine(veLine, "", ICreditVoter.LineKind.VeBTC, "veBTC credit");
        vm.stopPrank();
    }

    /* Helpers */

    function _lock(address user, uint256 amount, uint256 duration) internal returns (uint256 tokenId) {
        btc.mint(user, amount);
        vm.startPrank(user);
        btc.approve(address(ve), amount);
        tokenId = ve.createLock(amount, duration);
        vm.stopPrank();
    }

    function _lockPermanent(address user, uint256 amount) internal returns (uint256 tokenId) {
        tokenId = _lock(user, amount, 28 days);
        vm.prank(user);
        ve.lockPermanent(tokenId);
    }

    function _warp(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + 1 + secs / BLOCK_TIME);
    }

    function _warpEpochs(uint256 n) internal {
        _warp(n * EPOCH_LENGTH);
    }

    function _vote(address who, uint256 tokenId, uint256[] memory lineIds, uint256[] memory weights) internal {
        vm.prank(who);
        voter.vote(tokenId, lineIds, weights);
    }

    function _arr(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _arr(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        (r[0], r[1]) = (a, b);
    }

    function _arr(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        (r[0], r[1], r[2]) = (a, b, c);
    }

    function _addLines(uint256 n) internal {
        vm.startPrank(owner);
        for (uint256 i; i < n; ++i) {
            voter.addLine(veLine, abi.encode(i + 100), ICreditVoter.LineKind.VeBTC, "extra");
        }
        vm.stopPrank();
    }

    /* Admin */

    function test_constructor_setsParams_andRejectsZero() public {
        assertEq(address(voter.veBTC()), address(ve));
        assertEq(voter.EPOCH_LENGTH(), EPOCH_LENGTH);
        assertEq(voter.owner(), owner);
        assertEq(address(voter.escrowRegistry()), address(0));

        vm.expectRevert(CreditVoter.ZeroAddress.selector);
        new CreditVoter(IVeBTC(address(0)), EPOCH_LENGTH, owner);
        vm.expectRevert(CreditVoter.ZeroEpochLength.selector);
        new CreditVoter(IVeBTC(address(ve)), 0, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new CreditVoter(IVeBTC(address(ve)), EPOCH_LENGTH, address(0));
    }

    function test_currentEpoch_isEpochStart() public {
        assertEq(voter.currentEpoch(), EPOCH0);
        _warpEpochs(1);
        assertEq(voter.currentEpoch(), EPOCH0 + EPOCH_LENGTH);

        CreditVoter hourly = new CreditVoter(IVeBTC(address(ve)), 1 hours, owner);
        assertEq(hourly.currentEpoch(), block.timestamp - block.timestamp % 1 hours);
    }

    function test_addLine_onlyOwner_storesAndEmits() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        voter.addLine(veLine, hex"01", ICreditVoter.LineKind.VeBTC, "x");

        vm.expectEmit(address(voter));
        emit CreditVoter.LineAdded(3, veLine, ICreditVoter.LineKind.VeBTC, "veBTC credit II");
        vm.prank(owner);
        uint256 lineId = voter.addLine(veLine, hex"01", ICreditVoter.LineKind.VeBTC, "veBTC credit II");

        assertEq(lineId, 3);
        assertEq(voter.lineCount(), 4);
        ICreditVoter.Line memory l = voter.line(BTC_LINE);
        assertEq(l.adapter, morphoAdapter);
        assertEq(l.data, abi.encode(uint256(1)));
        assertEq(uint8(l.kind), uint8(ICreditVoter.LineKind.Morpho));
        assertTrue(l.active);
        assertEq(l.name, "BTC / Morpho");
    }

    function test_addLine_rejectsZeroAdapterAndDuplicate() public {
        vm.startPrank(owner);
        vm.expectRevert(CreditVoter.ZeroAddress.selector);
        voter.addLine(address(0), "", ICreditVoter.LineKind.VeBTC, "x");

        // Same adapter and data as BTC_LINE: two lines would double-count one market.
        vm.expectRevert(CreditVoter.LineExists.selector);
        voter.addLine(morphoAdapter, abi.encode(uint256(1)), ICreditVoter.LineKind.Morpho, "dup");
        vm.stopPrank();

        vm.expectRevert(CreditVoter.UnknownLine.selector);
        voter.line(3);
    }

    function test_setLineActive_onlyOwner_andUnknownLine() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        voter.setLineActive(BTC_LINE, false);

        vm.startPrank(owner);
        vm.expectEmit(address(voter));
        emit CreditVoter.LineActiveSet(BTC_LINE, false);
        voter.setLineActive(BTC_LINE, false);
        assertFalse(voter.line(BTC_LINE).active);
        voter.setLineActive(BTC_LINE, true);
        assertTrue(voter.line(BTC_LINE).active);

        vm.expectRevert(CreditVoter.UnknownLine.selector);
        voter.setLineActive(3, true);
        vm.stopPrank();
    }

    function test_setEscrowRegistry_oneShot_onlyOwner() public {
        TestEscrowRegistry registry = new TestEscrowRegistry();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        voter.setEscrowRegistry(registry);

        vm.startPrank(owner);
        vm.expectRevert(CreditVoter.ZeroAddress.selector);
        voter.setEscrowRegistry(IEscrowRegistry(address(0)));

        vm.expectEmit(address(voter));
        emit CreditVoter.EscrowRegistrySet(address(registry));
        voter.setEscrowRegistry(registry);
        assertEq(address(voter.escrowRegistry()), address(registry));

        TestEscrowRegistry other = new TestEscrowRegistry();
        vm.expectRevert(CreditVoter.EscrowRegistryAlreadySet.selector);
        voter.setEscrowRegistry(other);
        vm.stopPrank();
    }

    /* Voting */

    function test_vote_tallies_powerAtEpochStart() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        _warp(2 days);
        uint256 e1 = EPOCH0 + EPOCH_LENGTH;
        assertEq(voter.currentEpoch(), e1);

        // Snapshot at the epoch start (3 weeks left of a 4-week max), not the lower current power.
        uint256 power = 0.75e18;
        assertEq(ve.votingPowerOfNFTAt(id, e1), power);
        assertLt(ve.votingPowerOfNFT(id), power);

        vm.expectEmit(address(voter));
        emit CreditVoter.Voted(e1, id, alice, power, _arr(BTC_LINE, VE_LINE), _arr(6000, 4000));
        _vote(alice, id, _arr(BTC_LINE, VE_LINE), _arr(6000, 4000));

        assertEq(voter.lineVotes(e1, BTC_LINE), 0.45e18);
        assertEq(voter.lineVotes(e1, VE_LINE), 0.3e18);
        assertEq(voter.lineVotes(e1, BRIDGED_LINE), 0);
        assertEq(voter.totalVotes(e1), power);
        assertEq(voter.tokenVotes(e1, id, BTC_LINE), 0.45e18);
        assertEq(voter.tokenVotes(e1, id, VE_LINE), 0.3e18);
        // Nothing leaks into other epochs.
        assertEq(voter.totalVotes(EPOCH0), 0);
        assertEq(voter.totalVotes(e1 + EPOCH_LENGTH), 0);

        (uint256[] memory lineIds, uint256[] memory weights, uint256 epochCast) = voter.ballotOf(id);
        assertEq(lineIds, _arr(BTC_LINE, VE_LINE));
        assertEq(weights, _arr(6000, 4000));
        assertEq(epochCast, e1);
    }

    function test_vote_usesBoostedPermanentPower() public {
        uint256 id = _lockPermanent(alice, 2e18);
        ve.setBoost(id, 1.5e18);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();

        _vote(alice, id, _arr(VE_LINE), _arr(BPS));
        assertEq(voter.lineVotes(e1, VE_LINE), 3e18);
        assertEq(voter.totalVotes(e1), 3e18);
    }

    function test_vote_remainderGoesToLastLine() public {
        uint256 id = _lockPermanent(alice, 1e18 + 1);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        uint256 power = 1e18 + 1;

        _vote(alice, id, _arr(BTC_LINE, BRIDGED_LINE, VE_LINE), _arr(3333, 3333, 3334));

        uint256 share = power * 3333 / BPS;
        assertEq(voter.tokenVotes(e1, id, BTC_LINE), share);
        assertEq(voter.tokenVotes(e1, id, BRIDGED_LINE), share);
        assertEq(voter.tokenVotes(e1, id, VE_LINE), power - 2 * share);
        assertGt(power - 2 * share, power * 3334 / BPS);
        assertEq(
            voter.lineVotes(e1, BTC_LINE) + voter.lineVotes(e1, BRIDGED_LINE) + voter.lineVotes(e1, VE_LINE), power
        );
        assertEq(voter.totalVotes(e1), power);
    }

    function test_vote_replacesSameEpochBallot() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        uint256 other = _lock(bob, 2e18, 28 days);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        _vote(bob, other, _arr(BTC_LINE), _arr(BPS));

        _vote(alice, id, _arr(BTC_LINE, BRIDGED_LINE), _arr(6000, 4000));
        _warp(1 days);
        _vote(alice, id, _arr(VE_LINE, BTC_LINE), _arr(9000, 1000));

        // Only the second ballot counts, on top of bob's untouched 1.5e18.
        assertEq(voter.tokenVotes(e1, id, BRIDGED_LINE), 0);
        assertEq(voter.tokenVotes(e1, id, VE_LINE), 0.675e18);
        assertEq(voter.tokenVotes(e1, id, BTC_LINE), 0.075e18);
        assertEq(voter.lineVotes(e1, BTC_LINE), 1.5e18 + 0.075e18);
        assertEq(voter.lineVotes(e1, BRIDGED_LINE), 0);
        assertEq(voter.lineVotes(e1, VE_LINE), 0.675e18);
        assertEq(voter.totalVotes(e1), 1.5e18 + 0.75e18);

        (uint256[] memory lineIds, uint256[] memory weights,) = voter.ballotOf(id);
        assertEq(lineIds, _arr(VE_LINE, BTC_LINE));
        assertEq(weights, _arr(9000, 1000));
    }

    function test_vote_newEpochKeepsPastTallies() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));

        _warpEpochs(1);
        uint256 e2 = voter.currentEpoch();
        _vote(alice, id, _arr(VE_LINE), _arr(BPS));

        assertEq(voter.lineVotes(e1, BTC_LINE), 0.75e18);
        assertEq(voter.totalVotes(e1), 0.75e18);
        assertEq(voter.lineVotes(e2, BTC_LINE), 0);
        assertEq(voter.lineVotes(e2, VE_LINE), 0.5e18);
        assertEq(voter.totalVotes(e2), 0.5e18);
    }

    function test_vote_rejectsUnapproved() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);

        vm.expectRevert(CreditVoter.NotApprovedOrOwner.selector);
        _vote(bob, id, _arr(BTC_LINE), _arr(BPS));
        vm.expectRevert(CreditVoter.NotApprovedOrOwner.selector);
        _vote(alice, 999, _arr(BTC_LINE), _arr(BPS));

        // An approved operator votes for the owner.
        vm.prank(alice);
        ve.approve(bob, id);
        _vote(bob, id, _arr(BTC_LINE), _arr(BPS));
        assertEq(voter.totalVotes(voter.currentEpoch()), 0.75e18);
    }

    function test_vote_rejectsEscrowOwned() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        address escrow = makeAddr("loanEscrow");
        vm.prank(alice);
        ve.transferFrom(alice, escrow, id);

        // No registry yet: the check is skipped.
        _vote(escrow, id, _arr(BTC_LINE), _arr(BPS));

        TestEscrowRegistry registry = new TestEscrowRegistry();
        registry.setEscrow(escrow, alice);
        vm.prank(owner);
        voter.setEscrowRegistry(registry);

        vm.expectRevert(CreditVoter.EscrowOwnedNFT.selector);
        _vote(escrow, id, _arr(VE_LINE), _arr(BPS));

        // Approval from the escrow does not help either.
        vm.prank(escrow);
        ve.setApprovalForAll(alice, true);
        vm.expectRevert(CreditVoter.EscrowOwnedNFT.selector);
        _vote(alice, id, _arr(VE_LINE), _arr(BPS));
    }

    function test_vote_rejectsWeightsNot10000() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);

        vm.startPrank(alice);
        vm.expectRevert(CreditVoter.BadWeights.selector);
        voter.vote(id, _arr(BTC_LINE, VE_LINE), _arr(5000, 4999));
        vm.expectRevert(CreditVoter.BadWeights.selector);
        voter.vote(id, _arr(BTC_LINE, VE_LINE), _arr(5000, 5001));
        vm.expectRevert(CreditVoter.BadWeights.selector);
        voter.vote(id, _arr(BTC_LINE, VE_LINE), _arr(BPS, 0));
        vm.expectRevert(CreditVoter.BadWeights.selector);
        voter.vote(id, _arr(BTC_LINE, VE_LINE), _arr(type(uint256).max, 10_001));
        vm.expectRevert(CreditVoter.BadWeights.selector);
        voter.vote(id, new uint256[](0), new uint256[](0));
        vm.expectRevert(CreditVoter.LengthMismatch.selector);
        voter.vote(id, _arr(BTC_LINE, VE_LINE), _arr(BPS));
        vm.stopPrank();
    }

    function test_vote_rejectsInactiveLine() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        vm.prank(owner);
        voter.setLineActive(BRIDGED_LINE, false);

        vm.expectRevert(CreditVoter.InactiveLine.selector);
        _vote(alice, id, _arr(BTC_LINE, BRIDGED_LINE), _arr(5000, 5000));
        vm.expectRevert(CreditVoter.UnknownLine.selector);
        _vote(alice, id, _arr(BTC_LINE, 3), _arr(5000, 5000));

        _vote(alice, id, _arr(BTC_LINE, VE_LINE), _arr(5000, 5000));
    }

    function test_vote_rejectsDuplicateLine() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);

        vm.expectRevert(CreditVoter.DuplicateLine.selector);
        _vote(alice, id, _arr(BTC_LINE, VE_LINE, BTC_LINE), _arr(3000, 4000, 3000));
    }

    function test_vote_rejectsMoreThanTenLines() public {
        _addLines(8);
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);

        uint256[] memory lineIds = new uint256[](11);
        uint256[] memory weights = new uint256[](11);
        for (uint256 i; i < 11; ++i) {
            lineIds[i] = i;
            weights[i] = i == 10 ? 0 : 1000;
        }
        vm.expectRevert(CreditVoter.TooManyLines.selector);
        _vote(alice, id, lineIds, weights);

        uint256[] memory ten = new uint256[](10);
        uint256[] memory tenWeights = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            (ten[i], tenWeights[i]) = (i, 1000);
        }
        _vote(alice, id, ten, tenWeights);
        assertEq(voter.totalVotes(voter.currentEpoch()), 0.75e18);
    }

    function test_newLock_hasNoPowerUntilNextEpoch() public {
        uint256 id = _lock(alice, 1e18, 28 days);

        vm.expectRevert(CreditVoter.NoPower.selector);
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));

        _warpEpochs(1);
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));
        assertEq(voter.totalVotes(voter.currentEpoch()), 0.75e18);
    }

    function test_vote_rejectsExpiredLock() public {
        uint256 id = _lock(alice, 1e18, 8 days); // ends at EPOCH0 + 1 week
        _warpEpochs(1);

        vm.expectRevert(CreditVoter.NoPower.selector);
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));
    }

    /* Review Focus 1: one snapshot per NFT per epoch */

    function test_transferMidEpoch_newOwnerReplacesNotAdds() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        uint256 power = 0.75e18;

        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));
        vm.prank(alice);
        ve.transferFrom(alice, bob, id);
        // veBTC hides current power in the transfer block; the epoch snapshot is unaffected.
        assertEq(ve.votingPowerOfNFT(id), 0);

        vm.expectRevert(CreditVoter.NotApprovedOrOwner.selector);
        _vote(alice, id, _arr(VE_LINE), _arr(BPS));

        // Same block as the transfer: bob's ballot replaces alice's.
        _vote(bob, id, _arr(BRIDGED_LINE, VE_LINE), _arr(5000, 5000));
        assertEq(voter.lineVotes(e1, BTC_LINE), 0);
        assertEq(voter.lineVotes(e1, BRIDGED_LINE), power / 2);
        assertEq(voter.lineVotes(e1, VE_LINE), power / 2);
        assertEq(voter.tokenVotes(e1, id, BTC_LINE), 0);
        assertEq(voter.totalVotes(e1), power);

        // Later in the epoch, still one snapshot.
        _warp(3 days);
        _vote(bob, id, _arr(VE_LINE), _arr(BPS));
        assertEq(voter.lineVotes(e1, BRIDGED_LINE), 0);
        assertEq(voter.lineVotes(e1, VE_LINE), power);
        assertEq(voter.totalVotes(e1), power);
    }

    function test_merge_mergedPowerNotCountedThisEpoch() public {
        uint256 a = _lock(alice, 1e18, 28 days);
        uint256 b = _lock(alice, 2e18, 28 days);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        uint256 powerA = 0.75e18;
        uint256 powerB = 1.5e18;

        _vote(alice, a, _arr(BTC_LINE), _arr(BPS));
        vm.prank(alice);
        ve.merge(a, b);
        assertGt(ve.votingPowerOfNFT(b), powerB);

        // b votes with its pre-merge snapshot; a's BTC is only counted through a's own ballot.
        _vote(alice, b, _arr(VE_LINE), _arr(BPS));
        assertEq(voter.lineVotes(e1, BTC_LINE), powerA);
        assertEq(voter.lineVotes(e1, VE_LINE), powerB);
        assertEq(voter.totalVotes(e1), powerA + powerB);

        // The burned NFT can neither vote nor be poked.
        vm.expectRevert(CreditVoter.NotApprovedOrOwner.selector);
        _vote(alice, a, _arr(VE_LINE), _arr(BPS));

        // Next epoch the merged lock counts once, under b.
        _warpEpochs(1);
        uint256 e2 = voter.currentEpoch();
        vm.startPrank(keeper);
        voter.poke(b);
        vm.expectRevert(CreditVoter.NoPower.selector);
        voter.poke(a);
        vm.stopPrank();
        assertEq(voter.lineVotes(e2, VE_LINE), 1.5e18); // 3 BTC, 2 of 4 weeks left
        assertEq(voter.totalVotes(e2), 1.5e18);
    }

    /// @dev A checkpoint written in the block stamped exactly at the epoch start lands inside the snapshot. Were votes
    /// open then, `a` could vote, merge into `b`, and `b` would vote with both locks: closing that second makes the
    /// snapshot final before any ballot reads it.
    function test_vote_closedAtEpochStartSecond_mergeCountedOnce() public {
        uint256 a = _lock(alice, 1e18, 28 days);
        uint256 b = _lock(alice, 2e18, 28 days);
        uint256 e1 = EPOCH0 + EPOCH_LENGTH;
        vm.warp(e1);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(voter.currentEpoch(), e1);

        vm.expectRevert(CreditVoter.SnapshotNotFinal.selector);
        _vote(alice, a, _arr(BTC_LINE), _arr(BPS));

        vm.prank(alice);
        ve.merge(a, b);

        _warp(1);
        vm.expectRevert(CreditVoter.NotApprovedOrOwner.selector);
        _vote(alice, a, _arr(BTC_LINE), _arr(BPS));
        _vote(alice, b, _arr(VE_LINE), _arr(BPS));
        assertEq(voter.totalVotes(e1), 2.25e18); // 3 BTC with 3 of 4 weeks left, counted once
    }

    function test_poke_closedAtEpochStartSecond() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));

        uint256 e2 = EPOCH0 + 2 * EPOCH_LENGTH;
        vm.warp(e2);
        vm.roll(vm.getBlockNumber() + 1);
        vm.expectRevert(CreditVoter.SnapshotNotFinal.selector);
        voter.poke(id);

        _warp(1);
        voter.poke(id);
        assertEq(voter.totalVotes(e2), 0.5e18);
    }

    function test_newLockMidEpoch_cannotAddToCurrentTally() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));

        // Adding BTC mid-epoch does not change this epoch's snapshot.
        btc.mint(alice, 5e18);
        vm.startPrank(alice);
        btc.approve(address(ve), 5e18);
        ve.increaseAmount(id, 5e18);
        voter.vote(id, _arr(BTC_LINE), _arr(BPS));
        vm.stopPrank();
        assertEq(voter.totalVotes(e1), 0.75e18);
    }

    /* Poke */

    function test_poke_carriesBallotToNextEpoch_atNewPower() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        _vote(alice, id, _arr(BTC_LINE, VE_LINE), _arr(6000, 4000));

        // Mid-epoch top-up: counts from the next snapshot.
        btc.mint(alice, 1e18);
        vm.startPrank(alice);
        btc.approve(address(ve), 1e18);
        ve.increaseAmount(id, 1e18);
        vm.stopPrank();

        _warpEpochs(1);
        uint256 e2 = voter.currentEpoch();
        uint256 power = 1e18; // 2 BTC, 2 of 4 weeks left
        assertEq(ve.votingPowerOfNFTAt(id, e2), power);

        vm.expectEmit(address(voter));
        emit CreditVoter.Poked(e2, id, power);
        vm.prank(keeper);
        voter.poke(id);

        assertEq(voter.lineVotes(e2, BTC_LINE), 0.6e18);
        assertEq(voter.lineVotes(e2, VE_LINE), 0.4e18);
        assertEq(voter.tokenVotes(e2, id, BTC_LINE), 0.6e18);
        assertEq(voter.totalVotes(e2), power);
        // The previous epoch's tally is untouched.
        assertEq(voter.lineVotes(e1, BTC_LINE), 0.45e18);
        assertEq(voter.totalVotes(e1), 0.75e18);

        (uint256[] memory lineIds, uint256[] memory weights, uint256 epochCast) = voter.ballotOf(id);
        assertEq(lineIds, _arr(BTC_LINE, VE_LINE));
        assertEq(weights, _arr(6000, 4000));
        assertEq(epochCast, e2);
    }

    function test_poke_skipsIdleEpochs() public {
        uint256 id = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        _vote(alice, id, _arr(VE_LINE), _arr(BPS));

        _warpEpochs(3);
        uint256 e4 = voter.currentEpoch();
        voter.poke(id);
        assertEq(voter.totalVotes(e1 + EPOCH_LENGTH), 0);
        assertEq(voter.totalVotes(e4), 1e18);
    }

    function test_poke_revertsSameEpoch() public {
        uint256 id = _lock(alice, 1e18, 28 days);
        _warpEpochs(1);

        vm.expectRevert(CreditVoter.NothingToPoke.selector);
        voter.poke(id); // no ballot yet

        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));
        vm.expectRevert(CreditVoter.NothingToPoke.selector);
        voter.poke(id);

        _warpEpochs(1);
        voter.poke(id);
        vm.expectRevert(CreditVoter.NothingToPoke.selector);
        voter.poke(id);
    }

    function test_poke_dropsInactiveLineAndRenormalises() public {
        uint256 id = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();
        _vote(alice, id, _arr(BTC_LINE, BRIDGED_LINE, VE_LINE), _arr(5000, 3000, 2000));

        vm.prank(owner);
        voter.setLineActive(BRIDGED_LINE, false);
        // Deactivation does not rewrite the running epoch.
        assertEq(voter.lineVotes(e1, BRIDGED_LINE), 0.3e18);

        _warpEpochs(1);
        uint256 e2 = voter.currentEpoch();
        voter.poke(id);

        // 5000 / 7000 -> 7142 bps, remainder 2858 bps to the last line.
        (uint256[] memory lineIds, uint256[] memory weights,) = voter.ballotOf(id);
        assertEq(lineIds, _arr(BTC_LINE, VE_LINE));
        assertEq(weights, _arr(7142, 2858));
        assertEq(voter.lineVotes(e2, BTC_LINE), 0.7142e18);
        assertEq(voter.lineVotes(e2, BRIDGED_LINE), 0);
        assertEq(voter.lineVotes(e2, VE_LINE), 0.2858e18);
        assertEq(voter.totalVotes(e2), 1e18);
    }

    function test_poke_revertsWhenNoActiveLineLeft() public {
        uint256 id = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        _vote(alice, id, _arr(BRIDGED_LINE), _arr(BPS));
        vm.prank(owner);
        voter.setLineActive(BRIDGED_LINE, false);

        _warpEpochs(1);
        vm.expectRevert(CreditVoter.NothingToPoke.selector);
        voter.poke(id);
        assertEq(voter.totalVotes(voter.currentEpoch()), 0);

        // The owner can still vote fresh.
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));
        assertEq(voter.totalVotes(voter.currentEpoch()), 1e18);
    }

    function test_poke_revertsForEscrowOwned() public {
        uint256 id = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        _vote(alice, id, _arr(VE_LINE), _arr(BPS));

        address escrow = makeAddr("loanEscrow");
        TestEscrowRegistry registry = new TestEscrowRegistry();
        registry.setEscrow(escrow, alice);
        vm.prank(owner);
        voter.setEscrowRegistry(registry);
        vm.prank(alice);
        ve.transferFrom(alice, escrow, id);

        _warpEpochs(1);
        vm.expectRevert(CreditVoter.EscrowOwnedNFT.selector);
        voter.poke(id);
    }

    function test_poke_revertsWhenLockExpired() public {
        uint256 id = _lock(alice, 1e18, 15 days); // ends at EPOCH0 + 2 weeks
        _warpEpochs(1);
        _vote(alice, id, _arr(BTC_LINE), _arr(BPS));

        _warpEpochs(1);
        vm.expectRevert(CreditVoter.NoPower.selector);
        voter.poke(id);
    }

    /* Conservation */

    /// @notice For random ballots, re-votes and pokes: each token's tallies sum to its snapshot power, and line
    /// tallies sum to `totalVotes`, which equals the summed power of the tokens that voted.
    function testFuzz_tallyConservation(uint256 seed, uint8 rounds) public {
        _addLines(9);
        uint256 nLines = voter.lineCount();

        uint256[] memory ids = new uint256[](5);
        for (uint256 t; t < ids.length; ++t) {
            uint256 amount = bound(uint256(keccak256(abi.encode(seed, "amount", t))), 1e6, 1_000e18);
            if (t % 2 == 0) {
                uint256 duration = bound(uint256(keccak256(abi.encode(seed, "duration", t))), 21 days, 28 days);
                ids[t] = _lock(address(uint160(0xA000 + t)), amount, duration);
            } else {
                ids[t] = _lockPermanent(address(uint160(0xA000 + t)), amount);
                ve.setBoost(ids[t], bound(uint256(keccak256(abi.encode(seed, "boost", t))), 1e18, 5e18));
            }
        }
        _warpEpochs(1);
        uint256 e1 = voter.currentEpoch();

        uint256 n = bound(rounds, 1, 20);
        for (uint256 r; r < n; ++r) {
            uint256 t = uint256(keccak256(abi.encode(seed, "token", r))) % ids.length;
            (uint256[] memory lineIds, uint256[] memory weights) = _randomBallot(seed, r, nLines);
            _vote(address(uint160(0xA000 + t)), ids[t], lineIds, weights);
        }
        _assertConservation(e1, ids, nLines);

        _warpEpochs(1);
        uint256 e2 = voter.currentEpoch();
        for (uint256 t; t < ids.length; ++t) {
            (,, uint256 epochCast) = voter.ballotOf(ids[t]);
            if (epochCast == e1) voter.poke(ids[t]);
        }
        _assertConservation(e2, ids, nLines);
        // Pokes never touch the closed epoch.
        _assertConservation(e1, ids, nLines);
    }

    function _randomBallot(uint256 seed, uint256 r, uint256 nLines)
        internal
        pure
        returns (uint256[] memory lineIds, uint256[] memory weights)
    {
        uint256 k = 1 + uint256(keccak256(abi.encode(seed, "k", r))) % 10;
        uint256[] memory pool = new uint256[](nLines);
        for (uint256 i; i < nLines; ++i) {
            pool[i] = i;
        }
        lineIds = new uint256[](k);
        weights = new uint256[](k);
        uint256 remaining = BPS - k;
        for (uint256 j; j < k; ++j) {
            uint256 rnd = uint256(keccak256(abi.encode(seed, "pick", r, j)));
            uint256 swap = j + rnd % (nLines - j);
            (pool[j], pool[swap]) = (pool[swap], pool[j]);
            lineIds[j] = pool[j];
            if (j == k - 1) {
                weights[j] = 1 + remaining;
            } else {
                uint256 extra = (rnd >> 128) % (remaining + 1);
                weights[j] = 1 + extra;
                remaining -= extra;
            }
        }
    }

    function _assertConservation(uint256 epoch, uint256[] memory ids, uint256 nLines) internal view {
        uint256 tokenPowers;
        for (uint256 t; t < ids.length; ++t) {
            (,, uint256 epochCast) = voter.ballotOf(ids[t]);
            uint256 summed;
            for (uint256 l; l < nLines; ++l) {
                summed += voter.tokenVotes(epoch, ids[t], l);
            }
            if (epochCast >= epoch && summed > 0) {
                uint256 power = ve.votingPowerOfNFTAt(ids[t], epoch);
                assertEq(summed, power, "token tallies != snapshot power");
                tokenPowers += power;
            } else {
                assertEq(summed, 0, "tallies without a ballot");
            }
        }
        uint256 lines;
        for (uint256 l; l < nLines; ++l) {
            lines += voter.lineVotes(epoch, l);
        }
        assertEq(lines, voter.totalVotes(epoch), "line tallies != totalVotes");
        assertEq(voter.totalVotes(epoch), tokenPowers, "totalVotes != token powers");
    }
}
