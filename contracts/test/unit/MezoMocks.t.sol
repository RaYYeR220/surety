// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";
import {MockPoolsVoter} from "../mocks/MockPoolsVoter.sol";
import {MockDistributor} from "../mocks/MockDistributor.sol";

/// @notice Pins down the veBTC / PoolsVoter / RewardsDistributor semantics the Surety contracts rely on.
contract MezoMocksTest is Test {
    uint256 internal constant START = 1792771353; // Fri 2026-10-23 16:02:33 UTC
    uint256 internal constant EPOCH = 1792627200; // Thu 2026-10-22 00:00 UTC

    MockERC20 internal btc;
    MockVeBTC internal ve;
    MockPoolsVoter internal voter;
    MockDistributor internal distributor;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        vm.warp(START);
        vm.roll(1000);
        btc = new MockERC20("Bitcoin", "BTC", 18);
        ve = new MockVeBTC(address(btc));
        voter = new MockPoolsVoter(ve);
        ve.setVoter(address(voter));
        distributor = new MockDistributor(ve);
        btc.mint(address(distributor), 100e18);
    }

    function _lock(address user, uint256 amount, uint256 duration) internal returns (uint256 tokenId) {
        btc.mint(user, amount);
        vm.startPrank(user);
        btc.approve(address(ve), amount);
        tokenId = ve.createLock(amount, duration);
        vm.stopPrank();
    }

    /* Locks */

    function test_createLock_roundsEndDownToWeek_andPullsBtc() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);

        IVeBTC.LockedBalance memory l = ve.locked(tokenId);
        assertEq(l.amount, 1e18);
        assertEq(l.end, (START + 28 days) / 1 weeks * 1 weeks);
        assertEq(l.end, EPOCH + 4 weeks);
        assertFalse(l.isPermanent);
        assertEq(ve.ownerOf(tokenId), alice);
        assertEq(btc.balanceOf(address(ve)), 1e18);
        assertEq(uint8(ve.escrowType(tokenId)), uint8(IVeBTC.EscrowType.NORMAL));
    }

    function test_createLock_rejectsBadInputs() public {
        btc.mint(alice, 10e18);
        vm.startPrank(alice);
        btc.approve(address(ve), 10e18);

        vm.expectRevert(MockVeBTC.ZeroAmount.selector);
        ve.createLock(0, 7 days);

        // Rounds down to the current week start, which is in the past.
        vm.expectRevert(MockVeBTC.LockDurationNotInFuture.selector);
        ve.createLock(1e18, 1 days);

        vm.expectRevert(MockVeBTC.LockDurationTooLong.selector);
        ve.createLock(1e18, 35 days);
        vm.stopPrank();
    }

    function test_createLockFor_mintsToRecipient() public {
        btc.mint(alice, 1e18);
        vm.startPrank(alice);
        btc.approve(address(ve), 1e18);
        uint256 tokenId = ve.createLockFor(1e18, 14 days, bob);
        vm.stopPrank();
        assertEq(ve.ownerOf(tokenId), bob);
    }

    function test_power_decaysLinearlyToEnd_andHistoryIsKept() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        uint256 end = ve.locked(tokenId).end;

        assertEq(ve.votingPowerOfNFT(tokenId), 1e18 * (end - START) / 28 days);
        // Nothing before the lock existed.
        assertEq(ve.votingPowerOfNFTAt(tokenId, START - 1), 0);

        vm.warp(end - 7 days);
        assertEq(ve.votingPowerOfNFT(tokenId), 1e18 * 7 days / 28 days);
        assertEq(ve.votingPowerOfNFTAt(tokenId, START), 1e18 * (end - START) / 28 days);

        vm.warp(end);
        assertEq(ve.votingPowerOfNFT(tokenId), 0);
    }

    function test_power_permanentIsFlat_andBoosted() public {
        uint256 tokenId = _lock(alice, 2e18, 28 days);
        vm.prank(alice);
        ve.lockPermanent(tokenId);

        IVeBTC.LockedBalance memory l = ve.locked(tokenId);
        assertTrue(l.isPermanent);
        assertEq(l.end, 0);
        assertEq(ve.votingPowerOfNFT(tokenId), 2e18);

        vm.warp(START + 100 days);
        assertEq(ve.votingPowerOfNFT(tokenId), 2e18);

        ve.setBoost(tokenId, 5e18);
        assertEq(ve.votingPowerOfNFT(tokenId), 10e18);
        // The boost is checkpointed: earlier power is unaffected.
        assertEq(ve.votingPowerOfNFTAt(tokenId, START + 1), 2e18);
    }

    /* ERC-721 */

    function test_transfer_zeroesCurrentPowerInSameBlockOnly() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        uint256 before = ve.votingPowerOfNFT(tokenId);

        vm.prank(alice);
        ve.transferFrom(alice, bob, tokenId);

        assertEq(ve.ownerOf(tokenId), bob);
        assertEq(ve.ownershipChange(tokenId), block.number);
        assertEq(ve.votingPowerOfNFT(tokenId), 0);
        assertEq(ve.votingPowerOfNFTAt(tokenId, block.timestamp), before);

        vm.roll(block.number + 1);
        assertEq(ve.votingPowerOfNFT(tokenId), before);
    }

    function test_transfer_requiresApproval() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);

        vm.prank(bob);
        vm.expectRevert(MockVeBTC.NotApprovedOrOwner.selector);
        ve.transferFrom(alice, bob, tokenId);

        vm.prank(alice);
        ve.approve(bob, tokenId);
        assertEq(ve.getApproved(tokenId), bob);
        assertTrue(ve.isApprovedOrOwner(bob, tokenId));

        vm.prank(bob);
        ve.transferFrom(alice, bob, tokenId);
        assertEq(ve.getApproved(tokenId), address(0));

        vm.prank(bob);
        ve.setApprovalForAll(alice, true);
        assertTrue(ve.isApprovedOrOwner(alice, tokenId));
    }

    function test_transfer_lockedEscrowTypeReverts() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        ve.setEscrowType(tokenId, IVeBTC.EscrowType.LOCKED);

        vm.prank(alice);
        vm.expectRevert(MockVeBTC.NotManagedOrNormalNFT.selector);
        ve.transferFrom(alice, bob, tokenId);
    }

    function test_transfer_allowedWhileVoted() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        vm.roll(block.number + 1);
        _vote(alice, tokenId);
        assertTrue(ve.voted(tokenId));

        vm.prank(alice);
        ve.transferFrom(alice, bob, tokenId);
        assertEq(ve.ownerOf(tokenId), bob);
    }

    function test_safeTransfer_rejectsNonReceiver() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        vm.prank(alice);
        vm.expectRevert();
        ve.safeTransferFrom(alice, address(btc), tokenId);
    }

    /* Lock management */

    function test_merge_keepsTargetHistoryBeforeMerge() public {
        uint256 from = _lock(alice, 1e18, 14 days);
        uint256 to = _lock(alice, 2e18, 28 days);
        uint256 toEnd = ve.locked(to).end;
        uint256 toPowerBefore = ve.votingPowerOfNFT(to);

        vm.warp(START + 1 hours);
        vm.prank(alice);
        ve.merge(from, to);

        IVeBTC.LockedBalance memory l = ve.locked(to);
        assertEq(l.amount, 3e18);
        assertEq(l.end, toEnd);
        assertEq(ve.ownerOf(from), address(0));
        assertEq(ve.locked(from).amount, 0);
        assertEq(ve.votingPowerOfNFTAt(to, START), toPowerBefore);
        assertEq(ve.votingPowerOfNFT(to), 3e18 * (toEnd - block.timestamp) / 28 days);
        assertEq(ve.votingPowerOfNFT(from), 0);
    }

    function test_merge_rejectsVotedSource() public {
        uint256 from = _lock(alice, 1e18, 14 days);
        uint256 to = _lock(alice, 2e18, 28 days);
        vm.roll(block.number + 1);
        _vote(alice, from);

        vm.prank(alice);
        vm.expectRevert(MockVeBTC.AlreadyVoted.selector);
        ve.merge(from, to);
    }

    function test_increaseUnlockTime_rules() public {
        uint256 tokenId = _lock(alice, 1e18, 14 days);
        uint256 end = ve.locked(tokenId).end;

        vm.startPrank(alice);
        vm.expectRevert(MockVeBTC.LockDurationNotInFuture.selector);
        ve.increaseUnlockTime(tokenId, 7 days);

        ve.increaseUnlockTime(tokenId, 28 days);
        assertEq(ve.locked(tokenId).end, (block.timestamp + 28 days) / 1 weeks * 1 weeks);
        assertGt(ve.locked(tokenId).end, end);

        vm.warp(ve.locked(tokenId).end);
        vm.expectRevert(MockVeBTC.LockExpired.selector);
        ve.increaseUnlockTime(tokenId, 28 days);
        vm.stopPrank();

        uint256 permanent = _lock(alice, 1e18, 28 days);
        vm.startPrank(alice);
        ve.lockPermanent(permanent);
        vm.expectRevert(MockVeBTC.PermanentLock.selector);
        ve.increaseUnlockTime(permanent, 28 days);
        vm.stopPrank();
    }

    function test_increaseAmount_pullsBtc_andRejectsExpired() public {
        uint256 tokenId = _lock(alice, 1e18, 14 days);
        btc.mint(alice, 1e18);

        vm.startPrank(alice);
        btc.approve(address(ve), 1e18);
        ve.increaseAmount(tokenId, 0.5e18);
        assertEq(ve.locked(tokenId).amount, 1.5e18);
        assertEq(btc.balanceOf(address(ve)), 1.5e18);

        vm.warp(ve.locked(tokenId).end);
        vm.expectRevert(MockVeBTC.LockExpired.selector);
        ve.increaseAmount(tokenId, 0.5e18);
        vm.stopPrank();
    }

    function test_increaseAmount_requiresApproval() public {
        uint256 tokenId = _lock(alice, 1e18, 14 days);
        btc.mint(bob, 1e18);
        vm.startPrank(bob);
        btc.approve(address(ve), 1e18);
        vm.expectRevert(MockVeBTC.NotApprovedOrOwner.selector);
        ve.increaseAmount(tokenId, 1e18);
        vm.stopPrank();
    }

    function test_withdraw_requiresExpiredUnvotedTimedLock() public {
        uint256 tokenId = _lock(alice, 1e18, 14 days);
        vm.roll(block.number + 1);

        vm.prank(alice);
        vm.expectRevert(MockVeBTC.LockNotExpired.selector);
        ve.withdraw(tokenId);

        _vote(alice, tokenId);
        vm.warp(ve.locked(tokenId).end);
        vm.prank(alice);
        vm.expectRevert(MockVeBTC.AlreadyVoted.selector);
        ve.withdraw(tokenId);

        vm.prank(alice);
        voter.reset(tokenId);
        vm.prank(alice);
        ve.withdraw(tokenId);
        assertEq(btc.balanceOf(alice), 1e18);
        assertEq(ve.ownerOf(tokenId), address(0));
    }

    /* PoolsVoter */

    function _vote(address user, uint256 tokenId) internal {
        address[] memory pools = new address[](1);
        pools[0] = makeAddr("pool");
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(user);
        voter.vote(tokenId, pools, weights);
    }

    function test_voter_vote_requiresApprovalAndPower() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);

        // Flash-NFT rule: no power in the block the NFT moved.
        vm.prank(alice);
        ve.transferFrom(alice, bob, tokenId);
        address[] memory pools = new address[](1);
        pools[0] = makeAddr("pool");
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(bob);
        vm.expectRevert(MockPoolsVoter.ZeroBalance.selector);
        voter.vote(tokenId, pools, weights);

        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(MockPoolsVoter.NotApprovedOrOwner.selector);
        voter.vote(tokenId, pools, weights);

        vm.prank(bob);
        voter.vote(tokenId, pools, weights);
        assertTrue(ve.voted(tokenId));
        assertEq(voter.votes(tokenId, pools[0]), ve.votingPowerOfNFT(tokenId));
    }

    function test_voter_oneActionPerMezoWeek() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        vm.roll(block.number + 1);
        _vote(alice, tokenId);

        vm.prank(alice);
        vm.expectRevert(MockPoolsVoter.AlreadyVotedOrDeposited.selector);
        voter.reset(tokenId);

        vm.warp(EPOCH + 1 weeks);
        vm.prank(alice);
        voter.reset(tokenId);
        assertFalse(ve.voted(tokenId));
    }

    function test_voter_claimPaysOwnerOnce() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        MockERC20 musd = new MockERC20("Mezo USD", "MUSD", 18);
        address bribe = makeAddr("bribe");
        musd.mint(address(voter), 50e18);
        voter.setReward(bribe, address(musd), 50e18);

        address[] memory rewards = new address[](1);
        rewards[0] = bribe;
        address[][] memory tokens = new address[][](1);
        tokens[0] = new address[](2);
        tokens[0][0] = address(musd);
        tokens[0][1] = address(ve);

        vm.prank(bob);
        vm.expectRevert(MockPoolsVoter.NotApprovedOrOwner.selector);
        voter.claimFeesAndBribes(rewards, tokens, tokenId);

        vm.prank(alice);
        ve.approve(bob, tokenId);
        vm.prank(bob);
        voter.claimFeesAndBribes(rewards, tokens, tokenId);
        assertEq(musd.balanceOf(alice), 50e18);
        assertEq(musd.balanceOf(bob), 0);

        vm.prank(alice);
        voter.claimFeesAndBribes(rewards, tokens, tokenId);
        assertEq(musd.balanceOf(alice), 50e18);
    }

    /* RewardsDistributor */

    function test_distributor_claimCompoundsIntoLiveLock() public {
        uint256 tokenId = _lock(alice, 1e18, 28 days);
        distributor.setClaimable(tokenId, 0.01e18);

        assertEq(distributor.claim(tokenId), 0.01e18);
        assertEq(ve.locked(tokenId).amount, 1.01e18);
        assertEq(btc.balanceOf(alice), 0);
        assertEq(distributor.claim(tokenId), 0);
    }

    function test_distributor_claimPaysOwnerOnceExpired() public {
        uint256 tokenId = _lock(alice, 1e18, 14 days);
        distributor.setClaimable(tokenId, 0.01e18);
        vm.warp(ve.locked(tokenId).end);

        assertEq(distributor.claim(tokenId), 0.01e18);
        assertEq(ve.locked(tokenId).amount, 1e18);
        assertEq(btc.balanceOf(alice), 0.01e18);
    }
}
