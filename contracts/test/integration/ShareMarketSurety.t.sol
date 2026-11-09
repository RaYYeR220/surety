// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {ShareMarket} from "../../src/ShareMarket.sol";
import {SuretyFixture} from "../utils/SuretyFixture.sol";

/// @notice ShareMarket on the whole Surety deployment: the real vault, SuretyPool and DepositGate, with the lenders'
/// cash lent to a veBTC borrower.
/// @dev Book (`_book`): a lender deposits 10,000 MUSD; alice locks 6 BTC permanently and votes the veBTC line; a
/// sponsor posts 1,000 MUSD for it; at the flip the allocator moves ~9,000 MUSD to the line (10% stays idle) and a
/// borrower takes 2,000 MUSD against a 0.05 BTC lock.
contract ShareMarketSuretyTest is SuretyFixture {
    uint16 internal constant FEE_BPS = 10;

    ShareMarket internal market;
    address internal treasury = makeAddr("treasury");
    address internal buyer = makeAddr("buyer");
    uint256 internal loanId;

    function setUp() public override {
        super.setUp();
        market = new ShareMarket(IVaultV2(address(vault)), treasury, FEE_BPS);
        vm.label(address(market), "ShareMarket");
    }

    function _book() internal {
        _deposit(lender, 10_000e18);
        uint256 aliceId = _lockPermanent(alice, 6e18);
        _warpEpochs(1);
        _voteAll(alice, aliceId, VE_LINE);
        _post(sponsor, VE_LINE, 1_000e18);
        _warpEpochs(1);
        _rebalance();
        (loanId,) = _openTimed(borrower, 0.05e18, 2_000e18);
    }

    function _list(address user, uint256 shares, uint16 discountBps) internal returns (uint256 id) {
        vm.startPrank(user);
        vault.approve(address(market), shares);
        id = market.list(shares, discountBps);
        vm.stopPrank();
    }

    function _fill(address who, uint256 id, uint256 shares) internal returns (uint256 filled, uint256 assets) {
        (, uint256 quoted,) = market.quote(id, shares);
        musd.mint(who, quoted);
        vm.startPrank(who);
        musd.approve(address(market), quoted);
        (filled, assets) = market.fill(id, shares, quoted);
        vm.stopPrank();
    }

    /// @dev The vault keeps only its idle buffer, so the lender cannot redeem most of their position; the market
    /// lets them sell it at a 2% discount instead, and the buyer holds a position that keeps earning.
    function test_lenderLeavesWhileTheCashIsLentOut() public {
        _book();
        uint256 shares = vault.balanceOf(lender);
        uint256 idle = musd.balanceOf(address(vault));
        assertLt(idle, vault.previewRedeem(shares) / 5, "most of the cash is lent out");
        vm.prank(lender);
        vm.expectRevert();
        vault.redeem(shares, lender, lender);

        uint256 half = shares / 2;
        uint256 id = _list(lender, half, 200);
        uint256 value = vault.convertToAssets(half);
        (uint256 filled, uint256 assets) = _fill(buyer, id, half);

        assertEq(filled, half);
        assertEq(assets, Math.mulDiv(value, 9_800, 10_000, Math.Rounding.Ceil));
        assertGt(assets, idle, "more than the vault could pay out");
        assertEq(musd.balanceOf(treasury), assets * FEE_BPS / 10_000);
        assertEq(musd.balanceOf(lender), assets - musd.balanceOf(treasury));
        assertEq(vault.balanceOf(buyer), half);

        // The buyer's shares earn the borrower's interest like any lender's.
        _warp(30 days);
        assertGt(vault.convertToAssets(half), value);
    }

    /// @dev A loss closes the market with the DepositGate: from the moment the bid lands (before anyone checkpoints
    /// it), while it is recorded and uncovered, and while VaultV2 re-recognises the cover, fills, listings and plain
    /// cancels revert with the market's own error; the seller can still cancel into MUSD. Once the cover is
    /// recognised the market reopens and fills at the restored price.
    function test_marketFollowsTheDepositGateThroughALoss() public {
        _book();
        uint256 id = _list(lender, 2_000e18, 300);
        uint256 small = _list(lender, 100e18, 300);
        uint256 priceBefore = vault.convertToAssets(1e18);

        _shock(6000);
        line.startAuction(loanId);
        _warp(AUCTION_DURATION);
        _shock(6000);
        _bid(bidder, loanId);

        assertTrue(pool.depositsPaused(), "unrecorded loss");
        _expectClosed(id);
        vm.prank(keeper);
        pool.checkpoint(VE_LINE);
        assertTrue(pool.depositsPaused(), "recorded, uncovered");
        _expectClosed(id);

        // The seller can leave as a holder could: withdrawals stay open.
        uint256 expected = vault.previewRedeem(100e18);
        vm.prank(lender);
        assertEq(market.cancelAndRedeem(small, expected), expected);
        assertEq(musd.balanceOf(lender), expected);

        vm.prank(keeper);
        pool.cover(VE_LINE);
        _warp(3 days);
        vault.accrueInterest();
        assertTrue(pool.depositsPaused(), "cover being re-recognised");
        _expectClosed(id);

        _warp(27 days);
        vault.accrueInterest();
        assertFalse(pool.depositsPaused(), "cover recognised");
        assertTrue(market.isOpen());
        assertGe(vault.convertToAssets(1e18) + 1e15, priceBefore, "share price restored");

        uint256 value = vault.convertToAssets(2_000e18);
        (uint256 filled, uint256 assets) = _fill(buyer, id, 2_000e18);
        assertEq(filled, 2_000e18);
        assertEq(assets, Math.mulDiv(value, 9_700, 10_000, Math.Rounding.Ceil));
        assertEq(vault.balanceOf(buyer), 2_000e18);
        assertEq(market.openListingCount(), 0);
    }

    function _expectClosed(uint256 id) internal {
        assertFalse(market.isOpen());
        musd.mint(buyer, 10_000e18);
        vm.startPrank(buyer);
        musd.approve(address(market), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ShareReceiptPaused.selector, buyer));
        market.fill(id, 100e18, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(lender);
        vault.approve(address(market), 100e18);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ShareReceiptPaused.selector, address(market)));
        market.list(100e18, 300);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ShareReceiptPaused.selector, lender));
        market.cancel(id);
        vm.stopPrank();
        assertEq(market.listing(id).shares, 2_000e18);
    }
}
