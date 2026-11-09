// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {LoanEscrow} from "../../src/lines/LoanEscrow.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {LineFixture} from "../utils/LineFixture.sol";

/// @notice Reward token that attacks while it moves. When the escrow forwards it to the line it tries to re-enter the
/// line, release the NFT, force-deallocate the line's cash and, if armed, donates MUSD to the line. When `lie` is set
/// it inflates the line's balance after the claim and accepts the resulting transfer without moving anything.
contract EvilRewardToken is MockERC20 {
    VeBTCCreditLine public line;
    LoanEscrow public escrow;
    IVaultV2 public vault;
    MockERC20 public musd;
    uint256 public loanId;
    address public thief;

    uint256 public donation;
    bool public lie;
    bool public attacked;
    bool public anyAttackWorked;

    constructor() MockERC20("Evil", "EVIL", 18) {}

    function arm(VeBTCCreditLine line_, LoanEscrow escrow_, IVaultV2 vault_, MockERC20 musd_, uint256 loanId_)
        external
    {
        line = line_;
        escrow = escrow_;
        vault = vault_;
        musd = musd_;
        loanId = loanId_;
        thief = msg.sender;
    }

    function setDonation(uint256 donation_) external {
        donation = donation_;
    }

    function setLie(bool lie_) external {
        lie = lie_;
    }

    function balanceOf(address account) public view override returns (uint256) {
        uint256 real = super.balanceOf(account);
        return lie && attacked && account == address(line) ? real + 1_000_000e18 : real;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (lie && msg.sender == address(line)) return true;
        return super.transfer(to, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(escrow) || to != address(line) || address(line) == address(0)) return;
        attacked = true;
        try line.harvest(loanId, new address[](0), new address[][](0)) {
            anyAttackWorked = true;
        } catch {}
        try line.repay(loanId, 1) {
            anyAttackWorked = true;
        } catch {}
        try line.startAuction(loanId) {
            anyAttackWorked = true;
        } catch {}
        try escrow.release(thief) {
            anyAttackWorked = true;
        } catch {}
        try vault.forceDeallocate(address(line), "", 1, address(this)) {
            anyAttackWorked = true;
        } catch {}
        if (donation > 0) musd.transfer(address(line), donation);
    }
}

/// @notice Auto-repay: `setAutoRepay` and `harvest`, which turns the escrowed NFT's fees and bribes into repayment.
contract HarvestTest is LineFixture {
    address internal bribe = makeAddr("bribeReward");
    address internal feeReward = makeAddr("feeReward");
    address internal stranger = makeAddr("stranger");
    address internal other = makeAddr("other");
    MockERC20 internal rewardToken;

    function setUp() public override {
        super.setUp();
        rewardToken = new MockERC20("Reward", "RWD", 18);
        _fundLine(100_000e18);
    }

    function test_setAutoRepay_borrowerOnly() public {
        (uint256 loanId,) = _openTimed(borrower, 1e18, 20_000e18);
        assertFalse(line.loan(loanId).autoRepay);

        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        vm.prank(stranger);
        line.setAutoRepay(loanId, true);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.AutoRepaySet(loanId, true);
        vm.prank(borrower);
        line.setAutoRepay(loanId, true);
        assertTrue(line.loan(loanId).autoRepay);

        // Also in auction; not once the loan is settled.
        _shock(7000);
        line.startAuction(loanId);
        vm.prank(borrower);
        line.setAutoRepay(loanId, false);
        assertFalse(line.loan(loanId).autoRepay);
        _bid(bidder, loanId);
        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        vm.prank(borrower);
        line.setAutoRepay(loanId, true);
    }

    function test_harvest_isBorrowerOnly_untilAutoRepayIsOn() public {
        (uint256 loanId,) = _openTimed(borrower, 1e18, 20_000e18);
        (address[] memory rewards, address[][] memory tokens) = _list(bribe, address(musd));
        _setVoterReward(bribe, musd, 10e18);

        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        vm.prank(stranger);
        line.harvest(loanId, rewards, tokens);
        vm.prank(borrower);
        assertEq(line.harvest(loanId, rewards, tokens), 10e18);

        vm.prank(borrower);
        line.setAutoRepay(loanId, true);
        _setVoterReward(bribe, musd, 10e18);
        vm.prank(stranger);
        assertEq(line.harvest(loanId, rewards, tokens), 10e18);
        assertEq(musd.balanceOf(stranger), 0);

        vm.prank(borrower);
        line.setAutoRepay(loanId, false);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        vm.prank(stranger);
        line.harvest(loanId, rewards, tokens);
    }

    /// @dev Regression: the MUSD a claim brings in repays the debt, other tokens go to the borrower, and the line's
    /// books move by exactly the repayment.
    function test_harvest_musdRepaysDebt_otherTokensGoToBorrower() public {
        (uint256 loanId,) = _openTimed(borrower, 1e18, 20_000e18);
        address escrow = line.loan(loanId).escrow;
        vm.prank(borrower);
        line.setAutoRepay(loanId, true);
        _warp(7 days);
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

        line.accrueInterest();
        uint256 debt = line.debtOf(loanId);
        uint256 cashBefore = line.cash();
        uint256 assetsBefore = line.realAssets();
        uint256 earnedBefore = line.interestEarnedTotal();
        uint256 borrowerMusd = musd.balanceOf(borrower);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Harvested(loanId, stranger, 100e18, 100e18, true);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Repaid(loanId, escrow, 100e18);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.RewardForwarded(loanId, address(rewardToken), 5e18);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.RewardForwarded(loanId, address(btc), 0.01e18);
        vm.prank(stranger);
        line.harvest(loanId, rewards, tokens);

        assertApproxEqAbs(line.debtOf(loanId), debt - 100e18, 1);
        assertGe(line.debtOf(loanId), debt - 100e18);
        assertEq(line.cash(), cashBefore + 100e18);
        assertApproxEqAbs(line.realAssets(), assetsBefore, 1);
        assertEq(line.interestEarnedTotal(), earnedBefore, "repayment is not income");
        assertEq(musd.balanceOf(borrower), borrowerMusd);
        assertEq(rewardToken.balanceOf(borrower), 5e18);
        assertEq(btc.balanceOf(borrower), 0.01e18);
        assertEq(musd.balanceOf(address(line)), line.cash());
        assertEq(rewardToken.balanceOf(address(line)), 0);
        assertEq(btc.balanceOf(address(line)), 0);
        assertEq(musd.balanceOf(escrow), 0);
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Active));
    }

    /// @dev Regression: rewards above the debt repay it in full, close the loan, return the NFT and pay the excess to
    /// the borrower.
    function test_harvest_overRepay_closesLoan_andPaysExcess() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 1_000e18);
        _warp(3 days);
        _setVoterReward(bribe, musd, 1_500e18);
        (address[] memory rewards, address[][] memory tokens) = _list(bribe, address(musd));
        line.accrueInterest();
        uint256 debt = line.debtOf(loanId);
        uint256 cashBefore = line.cash();
        uint256 borrowerMusd = musd.balanceOf(borrower);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Harvested(loanId, borrower, 1_500e18, debt, true);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Closed(loanId);
        vm.prank(borrower);
        assertEq(line.harvest(loanId, rewards, tokens), debt);

        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Closed));
        assertEq(ve.ownerOf(tokenId), borrower);
        assertEq(line.debtOf(loanId), 0);
        assertEq(line.totalDebt(), 0);
        assertEq(line.cash(), cashBefore + debt);
        assertEq(musd.balanceOf(borrower), borrowerMusd + 1_500e18 - debt);
        assertEq(musd.balanceOf(address(line)), line.cash());

        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        vm.prank(borrower);
        line.harvest(loanId, rewards, tokens);
    }

    /// @dev Stray MUSD and tokens on the line or the escrow are not rewards; duplicates count once; veBTC is never a
    /// token.
    function test_harvest_countsOnlyWhatTheClaimMoves() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        address escrow = line.loan(loanId).escrow;
        musd.mint(address(line), 50e18);
        rewardToken.mint(address(line), 7e18);
        musd.mint(escrow, 30e18);
        _setVoterReward(bribe, musd, 10e18);
        _setVoterReward(bribe, rewardToken, 2e18);

        address[] memory rewards = new address[](2);
        rewards[0] = bribe;
        rewards[1] = address(ve);
        address[][] memory tokens = new address[][](2);
        tokens[0] = new address[](5);
        tokens[0][0] = address(ve);
        tokens[0][1] = address(musd);
        tokens[0][2] = address(musd);
        tokens[0][3] = address(rewardToken);
        tokens[0][4] = address(rewardToken);
        tokens[1] = new address[](1);
        tokens[1][0] = address(ve);

        uint256 cashBefore = line.cash();
        vm.prank(borrower);
        assertEq(line.harvest(loanId, rewards, tokens), 10e18);
        assertEq(line.cash(), cashBefore + 10e18);
        assertEq(musd.balanceOf(address(line)), line.cash() + 50e18, "stray MUSD stays out of cash");
        assertEq(rewardToken.balanceOf(borrower), 2e18);
        assertEq(rewardToken.balanceOf(address(line)), 7e18);
        assertEq(musd.balanceOf(escrow), 30e18);
        assertEq(ve.ownerOf(tokenId), escrow);
    }

    /// @dev The rebase is claimed as in `escrowClaimRebase`; a distributor that refuses does not stop the harvest.
    function test_harvest_claimsRebase_andSurvivesARefusal() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        (address[] memory rewards, address[][] memory tokens) = _list(bribe, address(musd));
        vm.prank(borrower);
        line.setAutoRepay(loanId, true);

        distributor.setClaimable(tokenId, 0.1e18);
        vm.prank(stranger);
        line.harvest(loanId, rewards, tokens);
        assertEq(ve.locked(tokenId).amount, 1.1e18, "compounded into the live lock");

        // The distributor refuses this NFT for now; the MUSD part still goes through.
        ve.setEscrowType(tokenId, IVeBTC.EscrowType.LOCKED);
        distributor.setClaimable(tokenId, 0.1e18);
        _setVoterReward(bribe, musd, 10e18);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Harvested(loanId, stranger, 10e18, 10e18, false);
        vm.prank(stranger);
        line.harvest(loanId, rewards, tokens);
        assertEq(ve.locked(tokenId).amount, 1.1e18);
        ve.setEscrowType(tokenId, IVeBTC.EscrowType.NORMAL);

        // Once the lock has expired the rebase is paid to the borrower in BTC.
        _warp(ve.locked(tokenId).end - vm.getBlockTimestamp());
        vm.prank(stranger);
        line.harvest(loanId, rewards, tokens);
        assertEq(btc.balanceOf(borrower), 0.1e18);
        assertEq(ve.locked(tokenId).amount, 1.1e18);
    }

    /// @dev Regression: a harvest during an auction that covers the debt cancels the auction like `repay`; and it
    /// never reads the peg.
    function test_harvest_inAuction_andWhilePegUnhealthy() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 1_000e18);
        (uint256 loan2,) = _openTimed(other, 1e18, 40_000e18);
        vm.prank(other);
        line.setAutoRepay(loan2, true);
        (address[] memory rewards, address[][] memory tokens) = _list(bribe, address(musd));

        pegSource.set(true, 0.9e18);
        assertFalse(peg.pegHealthy());
        _setVoterReward(bribe, musd, 10e18);
        vm.prank(stranger);
        assertEq(line.harvest(loan2, rewards, tokens), 10e18);

        _shock(6000);
        line.startAuction(loan2);
        _setVoterReward(bribe, musd, 50_000e18);
        vm.prank(stranger);
        line.harvest(loan2, rewards, tokens);
        assertEq(uint8(line.loan(loan2).state), uint8(VeBTCCreditLine.LoanState.Closed));
        vm.expectRevert(VeBTCCreditLine.NoAuction.selector);
        line.auctionPrice(loan2);

        // The first loan is untouched by someone else's harvest.
        assertEq(ve.ownerOf(tokenId), line.loan(loanId).escrow);
        assertEq(line.debtOf(loanId), 1_000e18);
    }

    /// @dev Regression: a malicious token in the harvest list can neither steal nor mis-account. It cannot re-enter
    /// the line, release the NFT or pull the line's cash; MUSD it donates is just more repayment; an inflated balance
    /// only produces a transfer of that token.
    function test_harvest_maliciousToken_cannotStealOrMisaccount() public {
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        LoanEscrow escrow = _escrowOf(loanId);
        vm.prank(borrower);
        line.setAutoRepay(loanId, true);
        EvilRewardToken evil = new EvilRewardToken();
        vm.prank(stranger);
        evil.arm(line, escrow, IVaultV2(address(vault)), musd, loanId);
        musd.mint(address(evil), 25e18);
        evil.setDonation(25e18);
        evil.setLie(true);

        _setVoterReward(bribe, MockERC20(address(evil)), 1e18);
        _setVoterReward(bribe, musd, 10e18);
        address[] memory rewards = new address[](1);
        rewards[0] = bribe;
        address[][] memory tokens = new address[][](1);
        tokens[0] = new address[](2);
        tokens[0][0] = address(evil);
        tokens[0][1] = address(musd);

        uint256 debt = line.debtOf(loanId);
        uint256 cashBefore = line.cash();
        uint256 allocationBefore = line.allocation();
        uint256 treasuryBefore = musd.balanceOf(treasury);
        uint256 borrowerMusd = musd.balanceOf(borrower);

        vm.prank(stranger);
        uint256 repaid = line.harvest(loanId, rewards, tokens);

        assertTrue(evil.attacked());
        assertFalse(evil.anyAttackWorked(), "no re-entry, release or forced deallocation");
        assertEq(repaid, 35e18, "the reward plus the donation, nothing else");
        assertEq(line.cash(), cashBefore + 35e18);
        assertApproxEqAbs(line.debtOf(loanId), debt - 35e18, 1);
        assertEq(line.realAssets(), line.cash() + line.totalDebt());
        assertEq(musd.balanceOf(address(line)), line.cash());
        assertEq(line.allocation(), allocationBefore);
        assertEq(musd.balanceOf(treasury), treasuryBefore);
        assertEq(musd.balanceOf(borrower), borrowerMusd);
        assertEq(musd.balanceOf(stranger), 0);
        assertEq(ve.ownerOf(tokenId), address(escrow));
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Active));
    }

    /// @dev Any reward against any debt: the repayment is min(reward, debt), cash grows by it, the borrower gets the
    /// rest, and the books stay balanced.
    function testFuzz_harvest_accounting(uint256 borrowed, uint256 reward, uint256 wait) public {
        borrowed = bound(borrowed, 1e18, 40_000e18);
        reward = bound(reward, 1, 60_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, borrowed);
        _warp(bound(wait, 1, 20 days));
        _setVoterReward(bribe, musd, reward);
        (address[] memory rewards, address[][] memory tokens) = _list(bribe, address(musd));
        line.accrueInterest();
        uint256 debt = line.debtOf(loanId);
        uint256 cashBefore = line.cash();
        uint256 borrowerMusd = musd.balanceOf(borrower);

        vm.prank(borrower);
        uint256 repaid = line.harvest(loanId, rewards, tokens);

        assertEq(repaid, reward < debt ? reward : debt);
        assertEq(line.cash(), cashBefore + repaid);
        assertEq(musd.balanceOf(borrower), borrowerMusd + reward - repaid);
        if (reward >= debt) {
            assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Closed));
            assertEq(line.debtOf(loanId), 0);
        } else {
            assertGe(line.debtOf(loanId), debt - repaid);
            assertLe(line.debtOf(loanId), debt - repaid + 1);
        }
        assertEq(line.realAssets(), line.cash() + line.totalDebt());
        assertEq(musd.balanceOf(address(line)), line.cash());
    }

    function _list(address reward, address token)
        internal
        pure
        returns (address[] memory rewards, address[][] memory tokens)
    {
        rewards = new address[](1);
        rewards[0] = reward;
        tokens = new address[][](1);
        tokens[0] = new address[](1);
        tokens[0][0] = token;
    }
}
