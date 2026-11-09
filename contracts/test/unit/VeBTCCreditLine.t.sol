// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IMusdPeg} from "../../src/interfaces/IMusdPeg.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {LinearKinkIrm} from "../../src/lines/LinearKinkIrm.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";
import {LineFixture} from "../utils/LineFixture.sol";

/// @notice VeBTCCreditLine as a VaultV2 adapter (real vault) and as an isolated veBTC-collateral market.
contract VeBTCCreditLineTest is LineFixture {
    address internal other = makeAddr("other");
    address internal fakePool = makeAddr("suretyPool");

    /* Adapter */

    function test_allocate_movesCashAndReportsChange() public {
        _deposit(lender, 100_000e18);
        _allocateLine(60_000e18);

        bytes32 adapterId = LineIds.adapterId(address(line));
        bytes32 collateralId = LineIds.collateralId(address(ve));
        assertEq(line.cash(), 60_000e18);
        assertEq(musd.balanceOf(address(line)), 60_000e18);
        assertEq(musd.balanceOf(address(vault)), 40_000e18);
        assertEq(line.realAssets(), 60_000e18);
        assertEq(line.allocation(), 60_000e18);
        assertEq(vault.allocation(adapterId), 60_000e18);
        assertEq(vault.allocation(collateralId), 60_000e18);

        // Interest earned since the last (de)allocation is reported in the next change, so the vault's tracked
        // allocation always equals the line's position afterwards.
        _openTimed(borrower, 1e18, 40_000e18);
        _warp(10 days);
        uint256 position = line.realAssets();
        assertGt(position, 60_000e18);

        _allocateLine(1_000e18);
        assertEq(line.realAssets(), position + 1_000e18);
        assertEq(vault.allocation(adapterId), position + 1_000e18);
        assertEq(vault.allocation(collateralId), position + 1_000e18);
        assertEq(line.allocation(), position + 1_000e18);
    }

    function test_deallocate_revertsWithoutCash() public {
        _fundLine(50_000e18);
        _openTimed(borrower, 1e18, 40_000e18);

        vm.expectRevert(VeBTCCreditLine.InsufficientCash.selector);
        _deallocateLine(10_000e18 + 1);

        _deallocateLine(10_000e18);
        assertEq(line.cash(), 0);
        assertEq(musd.balanceOf(address(vault)), 10_000e18);
        assertEq(musd.balanceOf(address(line)), 0);
        assertEq(vault.allocation(LineIds.adapterId(address(line))), line.realAssets());
        assertEq(line.realAssets(), 40_000e18);
    }

    function test_adapter_onlyVault_and_ids() public {
        vm.expectRevert(VeBTCCreditLine.NotVault.selector);
        line.allocate("", 0, bytes4(0), address(this));
        vm.expectRevert(VeBTCCreditLine.NotVault.selector);
        line.deallocate("", 0, bytes4(0), address(this));

        bytes32[] memory ids = line.ids();
        assertEq(ids.length, 2);
        assertEq(ids[0], LineIds.adapterId(address(line)));
        assertEq(ids[1], LineIds.collateralId(address(ve)));
        assertEq(musd.allowance(address(line), address(vault)), type(uint256).max);
    }

    function test_constructor_rejectsBadParams() public {
        VeBTCCreditLine.Params memory p = _lineParams();
        p.maxLtvTimedBps = LIQ_LTV;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);

        p = _lineParams();
        p.floorBps = 10_001;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);

        p = _lineParams();
        p.auctionDuration = 0;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);

        MockERC20 notMusd = new MockERC20("Other", "OTH", 18);
        vm.expectRevert(VeBTCCreditLine.AssetMismatch.selector);
        this.deployLine(_lineParams(), notMusd);

        // The production parameters deploy.
        VeBTCCreditLine fresh = this.deployLine(_lineParams(), musd);
        assertEq(fresh.params().minTerm, MIN_TERM);
        assertEq(fresh.owner(), admin);
        assertEq(address(fresh.btc()), address(btc));
    }

    /* Open */

    function test_open_transfersNFTIntoFreshEscrow_andPaysBorrower() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);

        vm.startPrank(borrower);
        ve.approve(address(line), tokenId);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Opened(1, borrower, tokenId, 30_000e18);
        uint256 loanId = line.open(tokenId, 30_000e18);
        vm.stopPrank();

        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        assertEq(loanId, 1);
        assertEq(l.borrower, borrower);
        assertEq(l.tokenId, tokenId);
        assertEq(uint8(l.state), uint8(VeBTCCreditLine.LoanState.Active));
        assertEq(l.auctionStart, 0);
        assertEq(ve.ownerOf(tokenId), l.escrow);
        assertEq(ve.getApproved(tokenId), address(0));
        assertTrue(line.isEscrow(l.escrow));
        assertEq(line.borrowerOfEscrow(l.escrow), borrower);
        assertFalse(line.isEscrow(borrower));
        assertEq(line.borrowerOfEscrow(borrower), address(0));

        assertEq(musd.balanceOf(borrower), _afterFee(30_000e18));
        assertEq(musd.balanceOf(treasury), 30_000e18 - _afterFee(30_000e18));
        assertEq(line.cash(), 70_000e18);
        assertEq(line.debtOf(loanId), 30_000e18);
        assertEq(line.totalDebt(), 30_000e18);
        assertEq(line.realAssets(), 100_000e18);

        // Every loan gets its own escrow; nothing is pooled.
        (uint256 loan2, uint256 token2) = _openTimed(other, 1e18, 10_000e18);
        address escrow2 = line.loan(loan2).escrow;
        assertTrue(escrow2 != l.escrow);
        assertEq(ve.ownerOf(token2), escrow2);
        assertEq(line.borrowerOfEscrow(escrow2), other);
    }

    function test_open_rejectsManagedLockedGrant() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);
        vm.prank(borrower);
        ve.approve(address(line), tokenId);

        ve.setEscrowType(tokenId, IVeBTC.EscrowType.MANAGED);
        vm.expectRevert(VeBTCCreditLine.NotNormalNFT.selector);
        vm.prank(borrower);
        line.open(tokenId, 1_000e18);

        ve.setEscrowType(tokenId, IVeBTC.EscrowType.LOCKED);
        vm.expectRevert(VeBTCCreditLine.NotNormalNFT.selector);
        vm.prank(borrower);
        line.open(tokenId, 1_000e18);

        ve.setEscrowType(tokenId, IVeBTC.EscrowType.NORMAL);
        ve.setGrantManager(tokenId, makeAddr("grantManager"));
        vm.expectRevert(VeBTCCreditLine.GrantLock.selector);
        vm.prank(borrower);
        line.open(tokenId, 1_000e18);

        ve.setGrantManager(tokenId, address(0));
        vm.prank(borrower);
        line.open(tokenId, 1_000e18);
        assertTrue(line.isEscrow(ve.ownerOf(tokenId)));
    }

    function test_open_rejectsNonOwnerAndZeroAmount() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);
        vm.startPrank(borrower);
        ve.approve(address(line), tokenId);
        ve.setApprovalForAll(other, true);
        vm.expectRevert(VeBTCCreditLine.ZeroAmount.selector);
        line.open(tokenId, 0);
        vm.stopPrank();

        // An approved operator cannot borrow against someone else's NFT.
        vm.expectRevert(VeBTCCreditLine.NotTokenOwner.selector);
        vm.prank(other);
        line.open(tokenId, 1_000e18);
    }

    function test_open_rejectsTermBelowMin() public {
        _fundLine(100_000e18);
        // Ends Thu 2026-10-29 00:00 UTC, 5d 8h after the start; 2d 20h remain after the warp.
        uint256 shortLock = _lockVeBTC(borrower, 1e18, 7 days);
        uint256 longLock = _lockVeBTC(borrower, 1e18, 14 days);
        _warp(2 days + 12 hours);
        assertLt(ve.locked(shortLock).end, vm.getBlockTimestamp() + MIN_TERM);

        vm.startPrank(borrower);
        ve.approve(address(line), shortLock);
        ve.approve(address(line), longLock);
        vm.expectRevert(VeBTCCreditLine.TermTooShort.selector);
        line.open(shortLock, 1_000e18);
        assertEq(line.maxBorrow(shortLock), 0);

        line.open(longLock, 1_000e18);
        vm.stopPrank();
    }

    function test_open_rejectsAboveMaxLtv_timedVsPermanent() public {
        _fundLine(1_000_000e18);
        uint256 timed = _lockVeBTC(borrower, 1e18, 28 days);
        uint256 permanent = _lockPermanent(borrower, 1e18);

        uint256 maxTimed = line.maxBorrow(timed);
        uint256 maxPermanent = line.maxBorrow(permanent);
        assertEq(maxTimed, _value(1e18) * MAX_LTV_TIMED / BPS);
        assertEq(maxPermanent, _value(1e18) * MAX_LTV_PERMANENT / BPS);

        vm.startPrank(borrower);
        ve.approve(address(line), timed);
        ve.approve(address(line), permanent);
        vm.expectRevert(VeBTCCreditLine.AboveMaxLtv.selector);
        line.open(timed, maxTimed + 1);
        vm.expectRevert(VeBTCCreditLine.AboveMaxLtv.selector);
        line.open(permanent, maxPermanent + 1);
        // The permanent lock cannot take the timed limit either.
        vm.expectRevert(VeBTCCreditLine.AboveMaxLtv.selector);
        line.open(permanent, maxTimed);

        uint256 timedLoan = line.open(timed, maxTimed);
        uint256 permanentLoan = line.open(permanent, maxPermanent);
        vm.stopPrank();

        (uint256 ltvTimed, uint256 valueTimed) = line.healthOf(timedLoan);
        (uint256 ltvPermanent,) = line.healthOf(permanentLoan);
        assertEq(ltvTimed, MAX_LTV_TIMED);
        assertEq(ltvPermanent, MAX_LTV_PERMANENT);
        assertEq(valueTimed, _value(1e18));
    }

    function test_open_revertsWithoutCash() public {
        _fundLine(10_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);
        assertEq(line.maxBorrow(tokenId), 10_000e18);
        vm.startPrank(borrower);
        ve.approve(address(line), tokenId);
        vm.expectRevert(VeBTCCreditLine.InsufficientCash.selector);
        line.open(tokenId, 10_000e18 + 1);
        vm.stopPrank();
    }

    /* Oracle failure (Review Focus 3) */

    function test_open_revertsOnStaleOracle() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);
        vm.prank(borrower);
        ve.approve(address(line), tokenId);

        _makeStale();
        vm.expectRevert(IPriceSource.StalePrice.selector);
        vm.prank(borrower);
        line.open(tokenId, 1_000e18);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        line.maxBorrow(tokenId);

        aggregator.setLive();
        aggregator.setAnswer(0);
        vm.expectRevert(IPriceSource.BadPrice.selector);
        vm.prank(borrower);
        line.open(tokenId, 1_000e18);
    }

    function test_repay_worksOnStaleOracle() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 30_000e18);
        _warp(1 days);
        _makeStale();
        vm.expectRevert(IPriceSource.StalePrice.selector);
        line.healthOf(loanId);

        assertEq(_repay(keeper, loanId, 10_000e18), 10_000e18);
        uint256 debt = line.debtOf(loanId);
        assertEq(_repay(keeper, loanId, type(uint256).max), debt);
        assertEq(ve.ownerOf(tokenId), borrower);
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Closed));

        // A non-positive answer does not block repayment either.
        (uint256 loan2,) = _openTimedLive(other, 1e18, 10_000e18);
        aggregator.setAnswer(-1);
        _repay(keeper, loan2, type(uint256).max);
        assertEq(uint8(line.loan(loan2).state), uint8(VeBTCCreditLine.LoanState.Closed));
    }

    function test_staleOracle_blocksBorrowMoreAuctionAndBid() public {
        _fundLine(100_000e18);
        (uint256 healthy,) = _openTimed(borrower, 1e18, 20_000e18);
        (uint256 underwater,) = _openTimed(other, 1e18, 40_000e18);
        _shock(4500);
        line.startAuction(underwater);

        _makeStale();
        vm.expectRevert(IPriceSource.StalePrice.selector);
        vm.prank(borrower);
        line.borrowMore(healthy, 1e18);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        line.startAuction(healthy);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        line.auctionPrice(underwater);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        vm.prank(bidder);
        line.bid(underwater, type(uint256).max);

        // Repaying, even mid-auction, keeps working.
        _repay(keeper, underwater, type(uint256).max);
        assertEq(uint8(line.loan(underwater).state), uint8(VeBTCCreditLine.LoanState.Closed));
    }

    /* Interest */

    function test_interestAccrues_realAssetsGrows() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        // 40% utilisation sits half-way to the kink: 5% APR.
        assertEq(line.utilizationWad(), 0.4e18);

        _warp(10 days);
        uint256 debt = line.debtOf(loanId);
        uint256 principal = 40_000e18;
        assertApproxEqRel(debt, principal + principal * 5 * 10 / (100 * 365), 1e12);
        assertEq(line.totalDebt(), debt);
        assertEq(line.realAssets(), 60_000e18 + debt);
        assertGt(line.realAssets(), 100_000e18);

        // The views include pending interest exactly as an accrual would book it.
        uint256 viewAssets = line.realAssets();
        line.accrueInterest();
        assertEq(line.realAssets(), viewAssets);
        assertEq(line.debtOf(loanId), debt);
        assertEq(vault.totalAssets(), viewAssets);
    }

    /// @dev The interest counter grows with accrued interest (pending interest included, like realAssets) and with
    /// liquidation fees kept, and is untouched by capital moving in or out, by covers and by shortfalls.
    function test_interestEarnedTotal_countsInterestAndFeesOnly() public {
        _fundLine(100_000e18);
        assertEq(line.interestEarnedTotal(), 0);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        (uint256 loan2,) = _openTimed(other, 1e18, 40_000e18);
        uint256 opened = line.totalDebt();
        assertEq(line.interestEarnedTotal(), 0, "borrowing is not interest");

        _warp(10 days);
        uint256 accrued = line.totalDebt() - opened;
        assertGt(accrued, 0);
        assertEq(line.interestEarnedTotal(), accrued, "pending interest included");
        line.accrueInterest();
        assertEq(line.interestEarnedTotal(), accrued, "accruing books exactly the view");

        // Capital moves, repayments and covers leave it alone.
        _deposit(lender, 5_000e18);
        _allocateLine(5_000e18);
        _deallocateLine(1_000e18);
        _repay(keeper, loan2, 1_000e18);
        vm.prank(admin);
        line.setSuretyPool(fakePool);
        musd.mint(fakePool, 100e18);
        vm.startPrank(fakePool);
        musd.approve(address(line), 100e18);
        line.receiveCover(100e18);
        vm.stopPrank();
        assertEq(line.interestEarnedTotal(), accrued);

        // An auction above the debt keeps the 3% fee; one below it records a shortfall and earns nothing more.
        _shock(4500);
        line.startAuction(loanId);
        uint256 debt = line.debtOf(loanId);
        uint256 before = line.interestEarnedTotal();
        _bid(bidder, loanId);
        uint256 fee = debt * LIQ_FEE / BPS;
        assertEq(
            line.interestEarnedTotal(),
            before + fee - fee * PROTOCOL_SHARE / BPS,
            "the lenders' part of the fee is income"
        );
        _shock(6000);
        line.startAuction(loan2);
        before = line.interestEarnedTotal();
        _bid(bidder, loan2);
        assertGt(line.badDebtTotal(), 0);
        assertEq(line.interestEarnedTotal(), before, "a shortfall is a loss, not negative interest");
    }

    /* Repay, extend, collateral */

    function test_fullRepay_returnsNFT() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 40_000e18);
        _warp(7 days);
        uint256 debt = line.debtOf(loanId);
        uint256 assetsBefore = line.realAssets();

        musd.mint(keeper, debt);
        vm.startPrank(keeper);
        musd.approve(address(line), debt);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Repaid(loanId, keeper, debt);
        uint256 repaid = line.repay(loanId, type(uint256).max);
        vm.stopPrank();

        assertEq(repaid, debt);
        assertEq(musd.balanceOf(keeper), 0);
        assertEq(ve.ownerOf(tokenId), borrower);
        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        assertEq(uint8(l.state), uint8(VeBTCCreditLine.LoanState.Closed));
        assertEq(l.normDebt, 0);
        assertEq(line.debtOf(loanId), 0);
        assertEq(line.totalDebt(), 0);
        assertEq(line.cash(), 60_000e18 + debt);
        assertEq(line.realAssets(), assetsBefore);

        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        line.repay(loanId, 1);
    }

    function test_partialRepay_reducesDebt() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 40_000e18);
        _warp(3 days);
        uint256 debt = line.debtOf(loanId);

        assertEq(_repay(keeper, loanId, 15_000e18), 15_000e18);
        assertApproxEqAbs(line.debtOf(loanId), debt - 15_000e18, 1);
        assertGe(line.debtOf(loanId), debt - 15_000e18);
        assertEq(line.cash(), 75_000e18);
        assertEq(ve.ownerOf(tokenId), line.loan(loanId).escrow);
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Active));
    }

    function test_borrowMore_respectsMaxLtvAndTerm() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 20_000e18);
        uint256 room = _value(1e18) * MAX_LTV_TIMED / BPS - line.debtOf(loanId);

        vm.expectRevert(VeBTCCreditLine.AboveMaxLtv.selector);
        vm.prank(borrower);
        line.borrowMore(loanId, room + 1);
        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        vm.prank(keeper);
        line.borrowMore(loanId, 1);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Borrowed(loanId, room);
        vm.prank(borrower);
        line.borrowMore(loanId, room);
        assertEq(musd.balanceOf(borrower), _afterFee(20_000e18) + _afterFee(room));

        // Close to maturity no more credit is extended.
        _repay(keeper, loanId, 20_000e18);
        _warp(ve.locked(tokenId).end - vm.getBlockTimestamp() - 2 days);
        vm.expectRevert(VeBTCCreditLine.TermTooShort.selector);
        vm.prank(borrower);
        line.borrowMore(loanId, 1e18);
    }

    function test_extend_movesMaturity_and_revertsAfterExpiry() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 14 days);
        uint256 loanId = _open(borrower, tokenId, 10_000e18);
        uint256 oldEnd = ve.locked(tokenId).end;
        uint256 expectedEnd = (vm.getBlockTimestamp() + 28 days) / 1 weeks * 1 weeks;

        vm.expectRevert(VeBTCCreditLine.NotBorrower.selector);
        vm.prank(keeper);
        line.extend(loanId, 28 days);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Extended(loanId, expectedEnd);
        vm.prank(borrower);
        line.extend(loanId, 28 days);
        assertEq(ve.locked(tokenId).end, expectedEnd);
        assertGt(expectedEnd, oldEnd);

        // Once the lock has expired veBTC refuses to extend it: the borrower has to repay.
        _warp(expectedEnd - vm.getBlockTimestamp());
        vm.expectRevert(MockVeBTC.LockExpired.selector);
        vm.prank(borrower);
        line.extend(loanId, 28 days);

        // Permanent locks have no maturity to move.
        (uint256 permanentLoan,) = _openPermanent(other, 1e18, 1_000e18);
        vm.expectRevert(MockVeBTC.PermanentLock.selector);
        vm.prank(other);
        line.extend(permanentLoan, 28 days);
    }

    function test_addCollateral_increasesLock() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 40_000e18);
        address escrow = line.loan(loanId).escrow;

        btc.mint(borrower, 0.5e18);
        vm.startPrank(borrower);
        btc.approve(address(line), 0.5e18);
        line.addCollateral(loanId, 0.5e18);
        vm.stopPrank();

        assertEq(ve.locked(tokenId).amount, 1.5e18);
        assertEq(btc.balanceOf(borrower), 0);
        assertEq(btc.balanceOf(escrow), 0);
        assertEq(btc.allowance(escrow, address(ve)), 0);
        (, uint256 value) = line.healthOf(loanId);
        assertEq(value, _value(1.5e18));

        // The extra collateral is borrowable.
        vm.prank(borrower);
        line.borrowMore(loanId, 20_000e18);
        assertEq(musd.balanceOf(borrower), _afterFee(40_000e18) + _afterFee(20_000e18));
    }

    function test_pause_blocksOpenAndBorrowMoreOnly() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vm.prank(keeper);
        line.pause(true);

        vm.prank(admin);
        line.pause(true);
        assertTrue(line.paused());

        uint256 tokenId = _lockVeBTC(other, 1e18, 28 days);
        vm.startPrank(other);
        ve.approve(address(line), tokenId);
        vm.expectRevert(VeBTCCreditLine.LinePaused.selector);
        line.open(tokenId, 1_000e18);
        vm.stopPrank();
        vm.expectRevert(VeBTCCreditLine.LinePaused.selector);
        vm.prank(borrower);
        line.borrowMore(loanId, 1e18);

        // Liquidations and repayments keep working while paused.
        _shock(4500);
        line.startAuction(loanId);
        _repay(keeper, loanId, type(uint256).max);

        vm.prank(admin);
        line.pause(false);
        vm.prank(other);
        line.open(tokenId, 1_000e18);
    }

    /* Auctions */

    function test_startAuction_onLtvBreach() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(4500);
        (uint256 ltv,) = line.healthOf(loanId);
        assertGe(ltv, LIQ_LTV);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.AuctionStarted(loanId, 0, keeper);
        vm.prank(keeper);
        line.startAuction(loanId);

        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        assertEq(uint8(l.state), uint8(VeBTCCreditLine.LoanState.Auction));
        assertEq(l.auctionStart, vm.getBlockTimestamp());

        vm.expectRevert(VeBTCCreditLine.LoanNotActive.selector);
        line.startAuction(loanId);
        vm.expectRevert(VeBTCCreditLine.LoanNotActive.selector);
        vm.prank(borrower);
        line.borrowMore(loanId, 1);
    }

    function test_startAuction_onExpiry() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 10_000e18);
        uint256 end = ve.locked(tokenId).end;

        _warp(end - vm.getBlockTimestamp() - 1);
        vm.expectRevert(VeBTCCreditLine.NotLiquidatable.selector);
        line.startAuction(loanId);

        _warp(1);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.AuctionStarted(loanId, 1, address(this));
        line.startAuction(loanId);
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Auction));
    }

    function test_startAuction_revertsWhenHealthy() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        // 50% LTV / 0.8 = 62.5%, under the 65% liquidation LTV.
        _shock(2000);
        vm.expectRevert(VeBTCCreditLine.NotLiquidatable.selector);
        line.startAuction(loanId);

        (uint256 permanentLoan,) = _openPermanent(other, 1e18, 1_000e18);
        _warp(60 days);
        vm.expectRevert(VeBTCCreditLine.NotLiquidatable.selector);
        line.startAuction(permanentLoan);

        vm.expectRevert(VeBTCCreditLine.LoanNotActive.selector);
        line.startAuction(99);
    }

    function test_auctionPrice_decaysToFloor() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(4500);
        line.startAuction(loanId);

        uint256 shocked = _value(1e18) * 5500 / BPS;
        assertEq(line.auctionPrice(loanId), shocked);

        // From 100% to the 85% floor over 6 hours: 2.5 points an hour.
        _warp(1 hours);
        assertApproxEqAbs(line.auctionPrice(loanId), shocked * 9750 / BPS, 1);

        // The 2-hour shock has lapsed: the price follows the live collateral value.
        _warp(2 hours);
        (, uint256 value) = line.healthOf(loanId);
        assertEq(value, _value(1e18));
        assertApproxEqAbs(line.auctionPrice(loanId), value * 9250 / BPS, 1);

        _warp(3 hours);
        assertEq(line.auctionPrice(loanId), value * FLOOR / BPS);
        _warp(10 hours);
        assertEq(line.auctionPrice(loanId), value * FLOOR / BPS);

        vm.expectRevert(VeBTCCreditLine.NoAuction.selector);
        line.auctionPrice(loanId + 1);
    }

    function test_bid_surplusToBorrower() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(4500);
        line.startAuction(loanId);

        uint256 price = line.auctionPrice(loanId);
        uint256 debt = line.debtOf(loanId);
        uint256 owed = debt + debt * LIQ_FEE / BPS;
        assertGt(price, owed);
        uint256 cashBefore = line.cash();
        uint256 assetsBefore = line.realAssets();

        uint256 fee = owed - debt;
        uint256 protocolPart = fee * PROTOCOL_SHARE / BPS;
        uint256 toKeeper = protocolPart * KEEPER_SHARE / BPS;
        uint256 treasuryBefore = musd.balanceOf(treasury);

        musd.mint(bidder, price);
        vm.startPrank(bidder);
        musd.approve(address(line), price);
        vm.expectRevert(VeBTCCreditLine.PriceAboveMax.selector);
        line.bid(loanId, price - 1);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Bid(loanId, bidder, price, debt, 0, price - owed);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.LiquidationFeePaid(
            loanId, address(this), fee - protocolPart, protocolPart - toKeeper, toKeeper
        );
        line.bid(loanId, price);
        vm.stopPrank();

        assertEq(ve.ownerOf(tokenId), bidder);
        assertEq(musd.balanceOf(bidder), 0);
        assertEq(musd.balanceOf(borrower), _afterFee(40_000e18) + price - owed);
        // The test contract started the auction: it is the keeper.
        assertEq(musd.balanceOf(address(this)), toKeeper);
        assertEq(musd.balanceOf(treasury) - treasuryBefore, protocolPart - toKeeper);
        assertEq(line.cash(), cashBefore + owed - protocolPart);
        assertEq(line.totalDebt(), 0);
        // The lenders' part of the liquidation fee is income for lenders.
        assertEq(line.realAssets(), assetsBefore + fee - protocolPart);
        assertEq(line.badDebtTotal(), 0);
        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        assertEq(uint8(l.state), uint8(VeBTCCreditLine.LoanState.Liquidated));
        assertEq(l.normDebt, 0);

        vm.expectRevert(VeBTCCreditLine.NoAuction.selector);
        line.bid(loanId, type(uint256).max);
        vm.expectRevert(VeBTCCreditLine.LoanClosed.selector);
        line.repay(loanId, 1);
    }

    function test_bid_shortfallRecordsBadDebt() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(6000);
        line.startAuction(loanId);

        uint256 debt = line.debtOf(loanId);
        uint256 assetsBefore = line.realAssets();
        uint256 price = _bid(bidder, loanId);
        uint256 shortfall = debt - price;

        assertEq(price, _value(1e18) * 4000 / BPS);
        assertGt(shortfall, 7_000e18);
        assertEq(line.badDebtTotal(), shortfall);
        assertEq(assetsBefore - line.realAssets(), shortfall);
        assertEq(line.totalDebt(), 0);
        assertEq(musd.balanceOf(borrower), _afterFee(40_000e18));
        assertEq(ve.ownerOf(tokenId), bidder);
        // Every vault asset sits in the line, so the vault marks the loss straight away.
        assertEq(vault.totalAssets(), line.realAssets());
    }

    function test_repayDuringAuction_cancels() public {
        _fundLine(100_000e18);
        (uint256 loanId, uint256 tokenId) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(4500);
        line.startAuction(loanId);
        _warp(1 hours);

        _repay(keeper, loanId, type(uint256).max);
        assertEq(ve.ownerOf(tokenId), borrower);
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Closed));
        assertEq(line.totalDebt(), 0);

        vm.expectRevert(VeBTCCreditLine.NoAuction.selector);
        line.auctionPrice(loanId);
        vm.expectRevert(VeBTCCreditLine.NoAuction.selector);
        vm.prank(bidder);
        line.bid(loanId, type(uint256).max);
    }

    /* v2 parameters */

    function test_constructor_requiresFloorAboveDebtPlusFeeAtTrigger() public {
        VeBTCCreditLine.Params memory p = _lineParams();
        // 65% * 1.03 = 66.95%: a floor there would only just cover debt and fee at the trigger.
        p.floorBps = 6695;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);
        p.floorBps = 6696;
        assertEq(this.deployLine(p, musd).params().floorBps, 6696);

        // The v1 parameters (trigger 70%, floor 70%) no longer deploy.
        p = _lineParams();
        p.liqLtvBps = 7000;
        p.floorBps = 7000;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);
    }

    function test_constructor_capsFees_andRequiresPegAndTreasury() public {
        VeBTCCreditLine.Params memory p = _lineParams();
        p.originationFeeBps = 101;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);
        p = _lineParams();
        p.protocolShareBps = 5001;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);
        p = _lineParams();
        p.keeperShareBps = 10_001;
        vm.expectRevert(VeBTCCreditLine.BadParams.selector);
        this.deployLine(p, musd);
        p.originationFeeBps = 100;
        p.protocolShareBps = 5000;
        p.keeperShareBps = 10_000;
        assertEq(this.deployLine(p, musd).params().keeperShareBps, 10_000, "the caps themselves deploy");

        vm.expectRevert(VeBTCCreditLine.ZeroAddress.selector);
        this.deployLineWith(IMusdPeg(address(0)), treasury);
        vm.expectRevert(VeBTCCreditLine.ZeroAddress.selector);
        this.deployLineWith(peg, address(0));

        VeBTCCreditLine.Params memory got = line.params();
        assertEq(got.liqLtvBps, 6500);
        assertEq(got.floorBps, 8500);
        assertEq(got.originationFeeBps, 25);
        assertEq(got.protocolShareBps, 2000);
        assertEq(got.keeperShareBps, 5000);
        assertEq(address(line.peg()), address(peg));
        assertEq(line.treasury(), treasury);
    }

    /* Depeg breaker */

    /// @dev Regression: a MUSD depeg (or a peg outage) stops new borrowing only. Repayment, collateral top-ups,
    /// escrow actions, auctions and bids all keep working, and they price BTC at BTC/USD.
    function test_pegBreaker_blocksBorrowing_notRepayAuctionsOrEscrow() public {
        _fundLine(200_000e18);
        (uint256 loanA, uint256 tokenA) = _openTimed(borrower, 1e18, 40_000e18);
        (uint256 loanB, uint256 tokenB) = _openTimed(other, 1e18, 40_000e18);
        uint256 fresh = _lockVeBTC(carol, 1e18, 28 days);
        vm.prank(carol);
        ve.approve(address(line), fresh);

        // MUSD at $0.96: 400 bps under the peg, outside the 300 bps band.
        pegSource.set(true, 0.96e18);
        assertFalse(peg.pegHealthy());
        vm.expectRevert(VeBTCCreditLine.PegUnhealthy.selector);
        vm.prank(carol);
        line.open(fresh, 1_000e18);
        vm.expectRevert(VeBTCCreditLine.PegUnhealthy.selector);
        vm.prank(borrower);
        line.borrowMore(loanA, 1e18);

        assertEq(_repay(keeper, loanA, 1_000e18), 1_000e18);
        btc.mint(borrower, 0.1e18);
        vm.startPrank(borrower);
        btc.approve(address(line), 0.1e18);
        line.addCollateral(loanA, 0.1e18);
        line.escrowClaimRebase(loanA);
        line.escrowClaim(loanA, new address[](0), new address[][](0));
        vm.stopPrank();

        // A MUSD below $1 does not move the BTC price, so the auction prices at BTC/USD.
        _shock(4500);
        line.startAuction(loanA);
        (, uint256 value) = line.healthOf(loanA);
        assertEq(value, _value(1.1e18) * 5500 / BPS);
        _bid(bidder, loanA);
        assertEq(ve.ownerOf(tokenA), bidder);

        // An outage is unhealthy too, and the price source falls back to $1 per MUSD.
        pegSource.set(false, 0);
        assertFalse(peg.pegHealthy());
        vm.expectRevert(VeBTCCreditLine.PegUnhealthy.selector);
        vm.prank(carol);
        line.open(fresh, 1_000e18);
        line.startAuction(loanB);
        _repay(keeper, loanB, type(uint256).max);
        assertEq(ve.ownerOf(tokenB), other);

        // Borrowing resumes once the peg is back in the band.
        pegSource.set(true, 0.975e18);
        vm.prank(carol);
        line.open(fresh, 1_000e18);
    }

    /// @dev The owner can switch the peg check off when the peg would otherwise stay tripped (its pools thinned out
    /// below `minSources`), and back on. Off, borrowing ignores the peg's health; pricing still goes through
    /// BtcMusdPriceSource, which counts an unhealthy peg as $1 (L-01 of the v2 review).
    function test_setPegCheck_ownerOnly_offLetsBorrowingThroughAnUnhealthyPeg() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);
        vm.prank(borrower);
        ve.approve(address(line), tokenId);
        assertTrue(line.pegCheck(), "on by default");

        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, other));
        line.setPegCheck(false);

        // Too few sources: unhealthy, and the price source reads MUSD at $1.
        pegSource.set(false, 0);
        assertFalse(peg.pegHealthy());
        vm.prank(borrower);
        vm.expectRevert(VeBTCCreditLine.PegUnhealthy.selector);
        line.open(tokenId, 10_000e18);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.PegCheckSet(false);
        vm.prank(admin);
        line.setPegCheck(false);
        assertFalse(line.pegCheck());
        vm.prank(borrower);
        uint256 loanId = line.open(tokenId, 10_000e18);
        (, uint256 value) = line.healthOf(loanId);
        assertEq(value, _value(1e18), "BTC at BTC/USD");
        // Still LTV-capped at the oracle price.
        vm.prank(borrower);
        vm.expectRevert(VeBTCCreditLine.AboveMaxLtv.selector);
        line.borrowMore(loanId, _value(1e18) / 2);
        vm.prank(borrower);
        line.borrowMore(loanId, 1_000e18);

        vm.prank(admin);
        line.setPegCheck(true);
        vm.prank(borrower);
        vm.expectRevert(VeBTCCreditLine.PegUnhealthy.selector);
        line.borrowMore(loanId, 1_000e18);
    }

    /// @dev MUSD above $1 lowers the BTC price in MUSD: a loan that is safe at $1 can reach the trigger.
    function test_musdPremium_lowersCollateralValue() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        pegSource.set(true, 1.03e18);
        assertTrue(peg.pegHealthy(), "300 bps over is inside the band");
        (, uint256 value) = line.healthOf(loanId);
        assertEq(value, uint256(BTC_USD) * 1e18 / 1.03e18);

        // 49% LTV after a 23% drop: 63.7% at $1, 65.6% with MUSD at $1.03.
        _shock(2300);
        pegSource.set(true, 1e18);
        vm.expectRevert(VeBTCCreditLine.NotLiquidatable.selector);
        line.startAuction(loanId);
        pegSource.set(true, 1.03e18);
        line.startAuction(loanId);
        assertEq(uint8(line.loan(loanId).state), uint8(VeBTCCreditLine.LoanState.Auction));
    }

    /* Origination fee */

    /// @dev Regression: the borrower receives the amount less 25 bps and owes all of it; the treasury gets the fee
    /// and the lenders' books do not see it.
    function test_originationFee_paidToTreasury_debtIsFullAmount() public {
        _fundLine(100_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 1e18, 28 days);
        vm.startPrank(borrower);
        ve.approve(address(line), tokenId);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Opened(1, borrower, tokenId, 30_000e18);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.OriginationFeePaid(1, 75e18);
        uint256 loanId = line.open(tokenId, 30_000e18);
        vm.stopPrank();

        assertEq(musd.balanceOf(borrower), 29_925e18);
        assertEq(musd.balanceOf(treasury), 75e18);
        assertEq(line.debtOf(loanId), 30_000e18);
        assertEq(line.cash(), 70_000e18);
        assertEq(line.realAssets(), 100_000e18);
        assertEq(line.interestEarnedTotal(), 0, "the fee is not lenders' income");
        assertEq(musd.balanceOf(address(line)), line.cash());

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.Borrowed(loanId, 10_000e18);
        vm.expectEmit(address(line));
        emit VeBTCCreditLine.OriginationFeePaid(loanId, 25e18);
        vm.prank(borrower);
        line.borrowMore(loanId, 10_000e18);
        assertEq(musd.balanceOf(borrower), 29_925e18 + 9_975e18);
        assertEq(musd.balanceOf(treasury), 100e18);
        assertEq(line.debtOf(loanId), 40_000e18);

        // Repaying costs the full debt; the fee is not refunded.
        assertEq(_repay(keeper, loanId, type(uint256).max), 40_000e18);
        assertEq(line.realAssets(), 100_000e18);
        assertEq(line.cash(), 100_000e18);
        assertEq(musd.balanceOf(treasury), 100e18);
    }

    /// @dev Borrower plus treasury receive exactly the amount, the debt is the amount, and realAssets is unmoved.
    function testFuzz_originationFee_conserves(uint256 amount) public {
        _fundLine(1_000_000e18);
        uint256 tokenId = _lockVeBTC(borrower, 30e18, 28 days);
        amount = bound(amount, 1, line.maxBorrow(tokenId));
        uint256 loanId = _open(borrower, tokenId, amount);
        assertEq(musd.balanceOf(borrower) + musd.balanceOf(treasury), amount);
        assertEq(musd.balanceOf(treasury), amount * ORIGINATION_FEE / BPS);
        assertEq(line.debtOf(loanId), amount);
        assertEq(line.realAssets(), 1_000_000e18);
        assertEq(musd.balanceOf(address(line)), line.cash());
    }

    /* Liquidation fee split */

    /// @dev A price between the debt and debt plus fee leaves a partial fee, split the same way; a price below the
    /// debt is a shortfall and pays no fee to anyone.
    function test_liquidationFee_partialFeeSplit_andShortfallPaysNoFee() public {
        _fundLine(100_000e18);
        (uint256 loanA,) = _openTimed(borrower, 1e18, 40_000e18);
        (uint256 loanB,) = _openTimed(other, 1e18, 40_000e18);
        // Collateral at about 41,000 MUSD: 2.5% above the debt, under the 3% fee.
        _shock(4973);
        vm.prank(keeper);
        line.startAuction(loanA);
        vm.prank(liquidator);
        line.startAuction(loanB);
        assertEq(line.loan(loanA).keeper, keeper);
        assertEq(line.loan(loanB).keeper, liquidator);

        uint256 debt = line.debtOf(loanA);
        uint256 price = line.auctionPrice(loanA);
        assertGt(price, debt);
        assertLt(price, debt + debt * LIQ_FEE / BPS);
        uint256 cashBefore = line.cash();
        uint256 earnedBefore = line.interestEarnedTotal();
        uint256 treasuryBefore = musd.balanceOf(treasury);
        _bid(bidder, loanA);
        uint256 fee = price - debt;
        uint256 protocolPart = fee * PROTOCOL_SHARE / BPS;
        uint256 toKeeper = protocolPart * KEEPER_SHARE / BPS;
        assertGt(toKeeper, 0);
        assertEq(musd.balanceOf(keeper), toKeeper);
        assertEq(musd.balanceOf(treasury) - treasuryBefore, protocolPart - toKeeper);
        assertEq(line.cash(), cashBefore + price - protocolPart);
        assertEq(line.interestEarnedTotal(), earnedBefore + fee - protocolPart);
        assertEq(musd.balanceOf(borrower), _afterFee(40_000e18), "no surplus");
        assertEq(line.badDebtTotal(), 0);

        // Three hours in (the shock renewed), loan B sells below its debt.
        _warp(3 hours);
        _shock(4973);
        debt = line.debtOf(loanB);
        treasuryBefore = musd.balanceOf(treasury);
        earnedBefore = line.interestEarnedTotal();
        price = _bid(bidder, loanB);
        assertLt(price, debt);
        assertEq(line.badDebtTotal(), debt - price);
        assertEq(musd.balanceOf(liquidator), 0);
        assertEq(musd.balanceOf(treasury), treasuryBefore);
        assertEq(line.interestEarnedTotal(), earnedBefore);
    }

    /// @dev Any shock and any bid time: the fee the line keeps splits exactly into lenders, treasury and keeper,
    /// shortfall and surplus are exact, and the line's cash grows by the debt part plus the lenders' part.
    function testFuzz_bid_splitsFeeExactly(uint256 shockBps, uint256 wait, uint256 btcAmount) public {
        _fundLine(1_000_000e18);
        btcAmount = bound(btcAmount, 0.01e18, 10e18);
        uint256 tokenId = _lockVeBTC(borrower, btcAmount, 28 days);
        uint256 loanId = _open(borrower, tokenId, line.maxBorrow(tokenId));
        // At a 50% LTV, any drop above 23.1% reaches the 65% trigger.
        uint16 shockAt = uint16(bound(shockBps, 2400, 9000));
        _shock(shockAt);
        vm.prank(keeper);
        line.startAuction(loanId);
        _warp(bound(wait, 1, 8 hours));
        _shock(shockAt);

        uint256 debt = line.debtOf(loanId);
        uint256 price = line.auctionPrice(loanId);
        uint256 owed = debt + debt * LIQ_FEE / BPS;
        uint256 toLine = price < owed ? price : owed;
        uint256 kept = toLine > debt ? toLine - debt : 0;
        uint256 protocolPart = kept * PROTOCOL_SHARE / BPS;
        uint256 toKeeper = protocolPart * KEEPER_SHARE / BPS;

        uint256 cashBefore = line.cash();
        uint256 earnedBefore = line.interestEarnedTotal();
        uint256 borrowerBefore = musd.balanceOf(borrower);
        uint256 treasuryBefore = musd.balanceOf(treasury);
        _bid(bidder, loanId);

        assertEq(musd.balanceOf(keeper), toKeeper, "keeper");
        assertEq(musd.balanceOf(treasury) - treasuryBefore, protocolPart - toKeeper, "treasury");
        assertEq(line.interestEarnedTotal() - earnedBefore, kept - protocolPart, "lenders");
        assertEq(musd.balanceOf(borrower) - borrowerBefore, price - toLine, "surplus");
        assertEq(line.badDebtTotal(), price < debt ? debt - price : 0, "shortfall");
        assertEq(line.cash() - cashBefore, toLine - protocolPart, "cash");
        assertEq(line.realAssets(), line.cash() + line.totalDebt());
        assertGe(musd.balanceOf(address(line)), line.cash());
    }

    /* Cover */

    function test_receiveCover_onlyPool_restoresRealAssets() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(6000);
        line.startAuction(loanId);
        uint256 assetsBefore = line.realAssets();
        _bid(bidder, loanId);
        uint256 shortfall = line.badDebtTotal();
        assertEq(line.realAssets(), assetsBefore - shortfall);

        musd.mint(fakePool, shortfall);
        vm.prank(fakePool);
        musd.approve(address(line), shortfall);
        vm.expectRevert(VeBTCCreditLine.NotSuretyPool.selector);
        vm.prank(fakePool);
        line.receiveCover(shortfall);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vm.prank(keeper);
        line.setSuretyPool(fakePool);
        vm.prank(admin);
        line.setSuretyPool(fakePool);
        vm.expectRevert(VeBTCCreditLine.SuretyPoolAlreadySet.selector);
        vm.prank(admin);
        line.setSuretyPool(keeper);
        assertEq(line.suretyPool(), fakePool);

        vm.expectRevert(VeBTCCreditLine.NotSuretyPool.selector);
        vm.prank(keeper);
        line.receiveCover(1);

        vm.expectEmit(address(line));
        emit VeBTCCreditLine.CoverReceived(shortfall);
        vm.prank(fakePool);
        line.receiveCover(shortfall);

        assertEq(line.realAssets(), assetsBefore);
        assertEq(musd.balanceOf(fakePool), 0);
        // The ledger is cumulative; the pool tracks what it has already covered.
        assertEq(line.badDebtTotal(), shortfall);
    }

    /* Fuzz: accounting */

    /// @dev Random open / borrowMore / repay / warp / deallocate sequences keep realAssets == cash + totalDebt,
    /// totalDebt within one wei per open loan of the sum of loan debts, and cash backed by the line's MUSD.
    function testFuzz_accountingHolds(uint256[10] memory ops) public {
        _runOps(ops);
    }

    /// @dev Guards the fuzz harness against being vacuous: a fixed sequence hits every action.
    function test_accounting_scriptedSequenceHitsEveryAction() public {
        uint8[10] memory actions = [0, 0, 1, 3, 2, 1, 3, 2, 0, 2];
        uint256[10] memory ops;
        for (uint256 i; i < ops.length; i++) {
            ops[i] = (uint256(keccak256(abi.encode(i))) & ~uint256(3)) | actions[i];
        }
        uint256[4] memory done = _runOps(ops);
        assertGt(done[0], 1, "opens");
        assertGt(done[1], 0, "borrowMore");
        assertGt(done[2], 0, "repays");
        assertGt(done[3], 0, "warps");
    }

    /// @return done Number of opens, borrowMores, repays and warps actually executed.
    function _runOps(uint256[10] memory ops) internal returns (uint256[4] memory done) {
        _fundLine(1_000_000e18);
        address[3] memory users = [makeAddr("u0"), makeAddr("u1"), makeAddr("u2")];
        uint256[] memory loanIds = new uint256[](ops.length);
        uint256 n;

        for (uint256 i; i < ops.length; i++) {
            uint256 op = ops[i];
            uint256 action = op % 4;
            if (action == 0) {
                address user = users[(op >> 8) % 3];
                uint256 btcAmount = bound((op >> 16) & type(uint64).max, 0.001e18, 5e18);
                uint256 tokenId =
                    (op >> 80) & 1 == 1 ? _lockPermanent(user, btcAmount) : _lockVeBTC(user, btcAmount, 28 days);
                uint256 maxAmount = line.maxBorrow(tokenId);
                if (maxAmount == 0) continue;
                loanIds[n++] = _open(user, tokenId, bound(op >> 96, 1, maxAmount));
                done[0]++;
            } else if (action == 1 && n > 0) {
                uint256 loanId = loanIds[(op >> 8) % n];
                VeBTCCreditLine.Loan memory l = line.loan(loanId);
                if (l.state != VeBTCCreditLine.LoanState.Active) continue;
                IVeBTC.LockedBalance memory lock = ve.locked(l.tokenId);
                if (!lock.isPermanent && lock.end < vm.getBlockTimestamp() + MIN_TERM) continue;
                uint256 maxLtv = lock.isPermanent ? MAX_LTV_PERMANENT : MAX_LTV_TIMED;
                (, uint256 value) = line.healthOf(loanId);
                uint256 limit = value * maxLtv / BPS;
                uint256 debt = line.debtOf(loanId);
                if (limit <= debt) continue;
                uint256 room = limit - debt;
                if (room > line.cash()) room = line.cash();
                if (room == 0) continue;
                vm.prank(l.borrower);
                line.borrowMore(loanId, bound(op >> 96, 1, room));
                done[1]++;
            } else if (action == 2 && n > 0) {
                uint256 loanId = loanIds[(op >> 8) % n];
                if (line.loan(loanId).state != VeBTCCreditLine.LoanState.Active) continue;
                uint256 debt = line.debtOf(loanId);
                _repay(keeper, loanId, bound(op >> 96, 1, debt + debt / 4));
                done[2]++;
            } else {
                _warp(bound(op >> 8, 1, 2 days));
                done[3]++;
                if ((op >> 200) & 1 == 1) _deallocateLine(bound(op >> 128, 0, line.cash()));
            }
            _assertAccounting(loanIds, n);
        }

        // Syncing through the vault leaves its tracked allocation equal to the line's position.
        _allocateLine(0);
        assertEq(vault.allocation(LineIds.adapterId(address(line))), line.realAssets());
        _assertAccounting(loanIds, n);
    }

    /* Helpers */

    function _assertAccounting(uint256[] memory loanIds, uint256 n) internal view {
        uint256 sum;
        uint256 open;
        for (uint256 i; i < n; i++) {
            VeBTCCreditLine.LoanState s = line.loan(loanIds[i]).state;
            if (s == VeBTCCreditLine.LoanState.Active || s == VeBTCCreditLine.LoanState.Auction) {
                sum += line.debtOf(loanIds[i]);
                open++;
            }
        }
        uint256 total = line.totalDebt();
        assertEq(line.realAssets(), line.cash() + total, "realAssets != cash + totalDebt");
        assertLe(total, sum, "totalDebt above loan sum");
        assertLe(sum - total, open, "rounding above 1 wei per loan");
        assertGe(musd.balanceOf(address(line)), line.cash(), "cash not backed");
    }

    /// @dev Opens a timed loan after making the feed live again (some tests leave it pinned).
    function _openTimedLive(address user, uint256 btcAmount, uint256 amount)
        internal
        returns (uint256 loanId, uint256 tokenId)
    {
        aggregator.setLive();
        (loanId, tokenId) = _openTimed(user, btcAmount, amount);
    }

    /// @dev External so `expectRevert` sees the constructor revert at a lower call depth.
    function deployLineWith(IMusdPeg peg_, address treasury_) external returns (VeBTCCreditLine) {
        return new VeBTCCreditLine(
            address(vault),
            musd,
            ve,
            poolsVoter,
            distributor,
            lineSource,
            peg_,
            lineIrm,
            _lineParams(),
            treasury_,
            admin
        );
    }

    /// @dev External so `expectRevert` sees the constructor revert at a lower call depth.
    function deployLine(VeBTCCreditLine.Params memory p, MockERC20 asset) external returns (VeBTCCreditLine) {
        return new VeBTCCreditLine(
            address(vault),
            IERC20(address(asset)),
            ve,
            poolsVoter,
            distributor,
            lineSource,
            peg,
            lineIrm,
            p,
            treasury,
            admin
        );
    }
}
