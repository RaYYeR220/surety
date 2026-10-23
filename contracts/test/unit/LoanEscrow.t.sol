// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LoanEscrow} from "../../src/lines/LoanEscrow.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPoolsVoter} from "../mocks/MockPoolsVoter.sol";
import {LineFixture} from "../utils/LineFixture.sol";

/// @notice Reward token that, when the escrow forwards it, tries to pull the NFT out and to re-enter the line.
contract ReenteringToken is MockERC20 {
    LoanEscrow public escrow;
    VeBTCCreditLine public line;
    uint256 public loanId;
    address public thief;

    bool public attacked;
    bool public releaseWorked;
    bool public reentryWorked;

    constructor() MockERC20("Evil", "EVIL", 18) {}

    function arm(LoanEscrow escrow_, VeBTCCreditLine line_, uint256 loanId_, address thief_) external {
        escrow = escrow_;
        line = line_;
        loanId = loanId_;
        thief = thief_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == address(escrow) && from != address(0)) {
            attacked = true;
            try escrow.release(thief) {
                releaseWorked = true;
            } catch {}
            try line.startAuction(loanId) {
                reentryWorked = true;
            } catch {}
            try line.repay(loanId, 1) {
                reentryWorked = true;
            } catch {}
        }
    }
}

/// @notice Loan escrows: borrower-only actions through the line, fixed targets, nothing extractable (Review Focus 5).
contract LoanEscrowTest is LineFixture {
    address internal bribe = makeAddr("bribeReward");
    address internal feeReward = makeAddr("feeReward");
    address internal gauge = makeAddr("gauge");
    address internal thief = makeAddr("thief");
    MockERC20 internal rewardToken;

    function setUp() public override {
        super.setUp();
        rewardToken = new MockERC20("Reward", "RWD", 18);
        _fundLine(100_000e18);
    }

    function test_escrowVote_and_claim_forwardsRewardsToBorrower() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        address escrow = line.loan(loanId).escrow;
        address[] memory pools = new address[](1);
        pools[0] = gauge;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;

        // veBTC reports zero power in the block the NFT moved, so the vote has to wait a block.
        vm.expectRevert(MockPoolsVoter.ZeroBalance.selector);
        vm.prank(borrower);
        line.escrowVote(loanId, pools, weights);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(borrower);
        line.escrowVote(loanId, pools, weights);
        assertTrue(ve.voted(tokenId));
        assertGt(poolsVoter.votes(tokenId, gauge), 0);

        // Mezo allows one vote or reset per NFT per week.
        vm.expectRevert(MockPoolsVoter.AlreadyVotedOrDeposited.selector);
        vm.prank(borrower);
        line.escrowReset(loanId);

        _setVoterReward(bribe, musd, 100e18);
        _setVoterReward(bribe, rewardToken, 5e18);
        _setVoterReward(feeReward, btc, 0.01e18);
        address[] memory rewards = new address[](2);
        rewards[0] = bribe;
        rewards[1] = feeReward;
        address[][] memory tokens = new address[][](2);
        tokens[0] = new address[](2);
        tokens[0][0] = address(musd);
        tokens[0][1] = address(rewardToken);
        tokens[1] = new address[](1);
        tokens[1][0] = address(btc);

        vm.prank(borrower);
        line.escrowClaim(loanId, rewards, tokens);
        assertEq(musd.balanceOf(borrower), 20_000e18 + 100e18);
        assertEq(rewardToken.balanceOf(borrower), 5e18);
        assertEq(btc.balanceOf(borrower), 0.01e18);
        assertEq(musd.balanceOf(escrow), 0);
        assertEq(rewardToken.balanceOf(escrow), 0);
        assertEq(btc.balanceOf(escrow), 0);
        assertEq(ve.ownerOf(tokenId), escrow);

        _warp(1 weeks);
        vm.prank(borrower);
        line.escrowReset(loanId);
        assertFalse(ve.voted(tokenId));

        // A voted NFT still goes home on repayment.
        _warp(1 weeks);
        vm.prank(borrower);
        line.escrowVote(loanId, pools, weights);
        assertTrue(ve.voted(tokenId));
        _repay(borrower, loanId, type(uint256).max);
        assertEq(ve.ownerOf(tokenId), borrower);
    }

    function test_escrowClaimRebase_compoundsWhileLive_paysBorrowerAfterExpiry() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        address escrow = line.loan(loanId).escrow;

        // Live lock: the distributor compounds the rebase into the lock, raising the collateral.
        distributor.setClaimable(tokenId, 0.1e18);
        vm.prank(borrower);
        line.escrowClaimRebase(loanId);
        assertEq(ve.locked(tokenId).amount, 1.1e18);
        assertEq(btc.balanceOf(borrower), 0);

        // Expired lock: the distributor pays the owner (the escrow), which forwards to the borrower.
        _warp(ve.locked(tokenId).end - vm.getBlockTimestamp());
        distributor.setClaimable(tokenId, 0.2e18);
        vm.prank(borrower);
        line.escrowClaimRebase(loanId);
        assertEq(btc.balanceOf(borrower), 0.2e18);
        assertEq(ve.locked(tokenId).amount, 1.1e18);

        // The distributor is permissionless; BTC a third party claimed into the escrow is forwarded next time.
        distributor.setClaimable(tokenId, 0.3e18);
        distributor.claim(tokenId);
        assertEq(btc.balanceOf(escrow), 0.3e18);
        vm.prank(borrower);
        line.escrowClaimRebase(loanId);
        assertEq(btc.balanceOf(borrower), 0.5e18);
        assertEq(btc.balanceOf(escrow), 0);
    }

    function test_escrowClaim_cannotExfiltrate() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        LoanEscrow escrow = _escrowOf(loanId);

        // Stray balances (donations) are not reward deltas and must stay put.
        MockERC20 fake = new MockERC20("Fake", "FAKE", 18);
        musd.mint(address(escrow), 50e18);
        fake.mint(address(escrow), 7e18);
        _setVoterReward(bribe, musd, 10e18);

        // veBTC listed as a "token", MUSD listed twice, and a token with no reward.
        address[] memory rewards = new address[](2);
        rewards[0] = bribe;
        rewards[1] = address(ve);
        address[][] memory tokens = new address[][](2);
        tokens[0] = new address[](4);
        tokens[0][0] = address(ve);
        tokens[0][1] = address(musd);
        tokens[0][2] = address(musd);
        tokens[0][3] = address(fake);
        tokens[1] = new address[](1);
        tokens[1][0] = address(ve);

        vm.prank(borrower);
        line.escrowClaim(loanId, rewards, tokens);

        assertEq(musd.balanceOf(borrower), 20_000e18 + 10e18);
        assertEq(fake.balanceOf(borrower), 0);
        assertEq(musd.balanceOf(address(escrow)), 50e18);
        assertEq(fake.balanceOf(address(escrow)), 7e18);
        assertEq(ve.ownerOf(tokenId), address(escrow));
        assertEq(ve.balanceOf(address(escrow)), 1);
        assertEq(ve.getApproved(tokenId), address(0));

        // A malicious reward token cannot use the forwarding call to release the NFT or re-enter the line.
        ReenteringToken evil = new ReenteringToken();
        evil.arm(escrow, line, loanId, thief);
        _setVoterReward(bribe, MockERC20(address(evil)), 1e18);
        address[] memory evilRewards = new address[](1);
        evilRewards[0] = bribe;
        address[][] memory evilTokens = new address[][](1);
        evilTokens[0] = new address[](1);
        evilTokens[0][0] = address(evil);

        vm.prank(borrower);
        line.escrowClaim(loanId, evilRewards, evilTokens);
        assertTrue(evil.attacked());
        assertFalse(evil.releaseWorked());
        assertFalse(evil.reentryWorked());
        assertEq(evil.balanceOf(borrower), 1e18);
        assertEq(ve.ownerOf(tokenId), address(escrow));
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Active));
    }

    function test_escrow_onlyLine() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        LoanEscrow escrow = _escrowOf(loanId);
        assertEq(escrow.line(), address(line));
        assertEq(escrow.tokenId(), tokenId);
        assertEq(address(escrow.ve()), address(ve));
        assertEq(address(escrow.voter()), address(poolsVoter));
        assertEq(address(escrow.distributor()), address(distributor));
        assertEq(address(escrow.btc()), address(btc));

        address[] memory none = new address[](0);
        uint256[] memory noWeights = new uint256[](0);
        address[][] memory noTokens = new address[][](0);
        address[3] memory callers = [borrower, admin, thief];
        for (uint256 i; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.release(callers[i]);
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.vote(none, noWeights);
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.reset();
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.claimRewards(none, noTokens, callers[i]);
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.claimRebase(callers[i]);
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.extend(28 days);
            vm.expectRevert(LoanEscrow.NotLine.selector);
            escrow.increaseAmount(1);
            vm.stopPrank();
        }

        // Targets are fixed at initialisation, for clones and for the implementation alike.
        vm.expectRevert(LoanEscrow.AlreadyInitialized.selector);
        escrow.initialize(thief, ve, poolsVoter, distributor, IERC20(address(btc)), tokenId);
        LoanEscrow implementation = LoanEscrow(line.escrowImplementation());
        vm.expectRevert(LoanEscrow.AlreadyInitialized.selector);
        implementation.initialize(thief, ve, poolsVoter, distributor, IERC20(address(btc)), tokenId);

        // No ERC-721 receiver hook, no generic call, no ether entry point.
        uint256 another = _lockVeBTC(borrower, 1e18, 28 days);
        vm.expectRevert();
        vm.prank(borrower);
        ve.safeTransferFrom(borrower, address(escrow), another);
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("execute(address,bytes)", address(ve), ""));
        assertFalse(ok);
        vm.deal(thief, 1 ether);
        vm.prank(thief);
        (ok,) = address(escrow).call{value: 1}("");
        assertFalse(ok);

        assertEq(ve.ownerOf(tokenId), address(escrow));
    }

    function test_escrowActions_onlyBorrower_andStopWhenClosed() public {
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        address[] memory pools = new address[](1);
        pools[0] = gauge;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        address[] memory none = new address[](0);
        address[][] memory noTokens = new address[][](0);

        vm.startPrank(thief);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        line.escrowVote(loanId, pools, weights);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        line.escrowReset(loanId);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        line.escrowClaim(loanId, none, noTokens);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        line.escrowClaimRebase(loanId);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        line.extend(loanId, 28 days);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        line.addCollateral(loanId, 1);
        vm.stopPrank();

        // In auction the borrower still votes and claims, but can no longer reshape the collateral.
        _shock(4500);
        line.startAuction(loanId);
        vm.startPrank(borrower);
        line.escrowVote(loanId, pools, weights);
        line.escrowClaim(loanId, none, noTokens);
        vm.expectRevert(VeBTCCreditLine.LoanNotActive.selector);
        line.extend(loanId, 28 days);
        vm.expectRevert(VeBTCCreditLine.LoanNotActive.selector);
        line.addCollateral(loanId, 1);
        vm.stopPrank();

        _bid(bidder, loanId);
        vm.startPrank(borrower);
        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        line.escrowReset(loanId);
        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        line.escrowClaim(loanId, none, noTokens);
        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        line.escrowClaimRebase(loanId);
        vm.stopPrank();
    }
}
