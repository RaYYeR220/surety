// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {ShareMarket} from "../../src/ShareMarket.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {ShareMarketFixture} from "../utils/ShareMarketFixture.sol";

/// @notice MUSD stand-in that calls back into `target` once, from inside its next transfer.
contract HookERC20 is MockERC20 {
    address internal target;
    bytes internal data;

    constructor() MockERC20("Hooked USD", "hUSD", 18) {}

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        address t = target;
        if (t == address(0)) return;
        delete target;
        (bool ok, bytes memory ret) = t.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

contract ShareMarketTest is ShareMarketFixture {
    uint256 internal constant DEPOSIT = 1_000e18;

    function setUp() public override {
        super.setUp();
        // The share price is exactly 1 MUSD until a test moves it.
        _deposit(seller, DEPOSIT);
    }

    /* Constructor */

    function test_constructor_setsTheMarket() public view {
        assertEq(address(market.vault()), address(vault));
        assertEq(address(market.asset()), address(musd));
        assertEq(market.treasury(), treasury);
        assertEq(market.feeBps(), FEE_BPS);
        assertEq(market.listingCount(), 0);
        assertTrue(market.isOpen());
    }

    function test_constructor_rejectsBadParams() public {
        vm.expectRevert(ShareMarket.ZeroAddress.selector);
        new ShareMarket(IVaultV2(address(0)), treasury, FEE_BPS);
        vm.expectRevert(ShareMarket.ZeroAddress.selector);
        new ShareMarket(IVaultV2(address(vault)), address(0), FEE_BPS);
        vm.expectRevert(ShareMarket.FeeTooHigh.selector);
        new ShareMarket(IVaultV2(address(vault)), treasury, 101);
        // The cap itself and no fee are fine.
        assertEq(new ShareMarket(IVaultV2(address(vault)), treasury, 100).feeBps(), 100);
        assertEq(new ShareMarket(IVaultV2(address(vault)), treasury, 0).feeBps(), 0);
    }

    /* list */

    function test_list_escrowsTheShares() public {
        vm.startPrank(seller);
        vault.approve(address(market), 100e18);
        vm.expectEmit(address(market));
        emit ShareMarket.Listed(1, seller, 100e18, 500);
        uint256 id = market.list(100e18, 500);
        vm.stopPrank();

        assertEq(id, 1);
        assertEq(market.listingCount(), 1);
        assertEq(vault.balanceOf(address(market)), 100e18);
        assertEq(vault.balanceOf(seller), DEPOSIT - 100e18);
        ShareMarket.Listing memory l = market.listing(id);
        assertEq(l.seller, seller);
        assertEq(l.discountBps, 500);
        assertEq(l.shares, 100e18);
        assertEq(market.openListingCount(), 1);
        assertEq(market.listingsOf(seller).length, 1);
    }

    function test_list_rejectsBadListings() public {
        vm.startPrank(seller);
        vault.approve(address(market), type(uint256).max);
        uint256 min = market.MIN_SHARES();
        vm.expectRevert(ShareMarket.TooFewShares.selector);
        market.list(min - 1, 500);
        vm.expectRevert(ShareMarket.DiscountTooHigh.selector);
        market.list(100e18, 2_001);
        // The bounds themselves are fine.
        market.list(min, 2_000);
        market.list(100e18, 0);
        vm.stopPrank();

        // Without an allowance the vault refuses the transfer.
        vm.prank(carol);
        vm.expectRevert();
        market.list(100e18, 500);
    }

    /// @dev The real DepositGate refuses the market while the pool reports `depositsPaused`; the market says so
    /// before the vault would.
    function test_list_waitsWhileShareReceiptIsPaused() public {
        vm.prank(seller);
        vault.approve(address(market), 100e18);
        _pause(true);
        assertFalse(market.isOpen());
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ShareReceiptPaused.selector, address(market)));
        market.list(100e18, 500);

        _pause(false);
        assertTrue(market.isOpen());
        vm.prank(seller);
        assertEq(market.list(100e18, 500), 1);
    }

    /* fill */

    /// @dev 100 shares at a share price of 1 MUSD and a 5% discount: the buyer pays 95 MUSD, the treasury gets 0.1%
    /// of that, the seller the rest.
    function test_fill_paysTheSellerAndTheTreasury() public {
        uint256 id = _list(seller, 100e18, 500);
        musd.mint(buyer, 95e18);
        vm.startPrank(buyer);
        musd.approve(address(market), 95e18);
        vm.expectEmit(address(market));
        emit ShareMarket.Filled(id, buyer, seller, 100e18, 95e18, 0.095e18);
        (uint256 filled, uint256 assets) = market.fill(id, 100e18, 95e18);
        vm.stopPrank();

        assertEq(filled, 100e18);
        assertEq(assets, 95e18);
        assertEq(musd.balanceOf(buyer), 0);
        assertEq(musd.balanceOf(seller), 94.905e18);
        assertEq(musd.balanceOf(treasury), 0.095e18);
        assertEq(musd.balanceOf(address(market)), 0, "the market never holds MUSD");
        assertEq(vault.balanceOf(buyer), 100e18);
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(market.listing(id).shares, 0);
        assertEq(market.openListingCount(), 0);
        assertEq(market.listingsOf(seller).length, 0);
    }

    function test_fill_partialFillsPriceAtTheLiveSharePrice() public {
        uint256 id = _list(seller, 300e18, 1_000);

        (uint256 filled, uint256 assets) = _fill(buyer, id, 100e18);
        assertEq(filled, 100e18);
        assertEq(assets, 90e18);
        assertEq(market.listing(id).shares, 200e18);
        assertEq(market.openListingCount(), 1);

        // The vault earns 10%: the next fill pays 10% more for the same shares.
        _gain(DEPOSIT / 10);
        (uint256 expected,) = _expectedPrice(100e18, 1_000);
        assertApproxEqAbs(expected, 99e18, 1);
        (filled, assets) = _fill(carol, id, 100e18);
        assertEq(assets, expected);
        assertEq(vault.balanceOf(carol), 100e18);

        // A loss lowers it again.
        _lose(DEPOSIT / 2);
        (expected,) = _expectedPrice(100e18, 1_000);
        assertLt(expected, 90e18);
        (filled, assets) = _fill(buyer, id, 100e18);
        assertEq(assets, expected);
        assertEq(vault.balanceOf(buyer), 200e18);
        assertEq(market.openListingCount(), 0);
    }

    function test_fill_capsAtWhatIsLeft() public {
        uint256 id = _list(seller, 100e18, 500);
        _fill(carol, id, 60e18);
        // Asking for 100 buys the 40 left, priced for 40.
        (uint256 filled, uint256 assets) = _fill(buyer, id, 100e18);
        assertEq(filled, 40e18);
        assertEq(assets, 38e18);
        assertEq(vault.balanceOf(buyer), 40e18);
        assertEq(market.openListingCount(), 0);
    }

    function test_fill_returnsDustToTheSeller() public {
        uint256 min = market.MIN_SHARES();
        uint256 id = _list(seller, 100e18, 500);
        uint256 sellerShares = vault.balanceOf(seller);

        (, uint256 quoted,) = market.quote(id, 100e18 - min + 1);
        musd.mint(buyer, quoted);
        vm.startPrank(buyer);
        musd.approve(address(market), quoted);
        vm.expectEmit(address(market));
        emit ShareMarket.DustReturned(id, seller, min - 1);
        (uint256 filled,) = market.fill(id, 100e18 - min + 1, quoted);
        vm.stopPrank();

        assertEq(filled, 100e18 - min + 1);
        assertEq(vault.balanceOf(buyer), filled);
        assertEq(vault.balanceOf(seller), sellerShares + min - 1, "the dust is the seller's again");
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(market.listing(id).shares, 0);
        assertEq(market.openListingCount(), 0);

        // Leaving exactly MIN_SHARES keeps the listing open.
        id = _list(seller, 100e18, 500);
        _fill(buyer, id, 100e18 - min);
        assertEq(market.listing(id).shares, min);
        _fill(carol, id, min);
        assertEq(vault.balanceOf(carol), min);
    }

    function test_fill_rejectsBadFills() public {
        uint256 id = _list(seller, 100e18, 500);
        musd.mint(buyer, 1_000e18);
        vm.startPrank(buyer);
        musd.approve(address(market), type(uint256).max);

        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ListingClosed.selector, 7));
        market.fill(7, 10e18, 1_000e18);
        uint256 min = market.MIN_SHARES();
        vm.expectRevert(ShareMarket.TooFewShares.selector);
        market.fill(id, min - 1, 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.PriceAboveMax.selector, 95e18, 95e18 - 1));
        market.fill(id, 100e18, 95e18 - 1);
        vm.stopPrank();

        // A limit set before the share price rose protects the buyer.
        _gain(DEPOSIT / 10);
        vm.prank(buyer);
        vm.expectPartialRevert(ShareMarket.PriceAboveMax.selector);
        market.fill(id, 100e18, 95e18);

        // Filled out, then closed.
        vm.prank(buyer);
        market.fill(id, 100e18, 1_000e18);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ListingClosed.selector, id));
        market.fill(id, 10e18, 1_000e18);
    }

    function test_fill_withoutAnMusdAllowanceReverts() public {
        uint256 id = _list(seller, 100e18, 500);
        musd.mint(buyer, 95e18);
        vm.prank(buyer);
        vm.expectRevert();
        market.fill(id, 100e18, 95e18);
        assertEq(market.listing(id).shares, 100e18);
    }

    /// @dev With the real DepositGate: while the pool reports `depositsPaused`, the buyer cannot receive shares, so
    /// the fill reverts with the market's own error and nothing moves. It goes through once the pool reopens.
    function test_fill_waitsWhileShareReceiptIsPaused() public {
        uint256 id = _list(seller, 100e18, 500);
        musd.mint(buyer, 95e18);
        vm.prank(buyer);
        musd.approve(address(market), 95e18);

        _pause(true);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ShareReceiptPaused.selector, buyer));
        market.fill(id, 100e18, 95e18);
        assertEq(musd.balanceOf(buyer), 95e18);
        assertEq(market.listing(id).shares, 100e18);

        _pause(false);
        vm.prank(buyer);
        market.fill(id, 100e18, 95e18);
        assertEq(vault.balanceOf(buyer), 100e18);
    }

    /// @dev The SuretyPool always receives shares through the gate, so it can buy while everyone else waits.
    function test_fill_thePoolCanBuyWhilePaused() public {
        uint256 id = _list(seller, 100e18, 500);
        _pause(true);
        (uint256 filled,) = _fill(address(surety), id, 100e18);
        assertEq(filled, 100e18);
        assertEq(vault.balanceOf(address(surety)), 100e18);
    }

    function test_fill_withoutAFeeSkipsTheTreasury() public {
        ShareMarket free = new ShareMarket(IVaultV2(address(vault)), treasury, 0);
        vm.startPrank(seller);
        vault.approve(address(free), 100e18);
        uint256 id = free.list(100e18, 500);
        vm.stopPrank();
        musd.mint(buyer, 95e18);
        vm.startPrank(buyer);
        musd.approve(address(free), 95e18);
        free.fill(id, 100e18, 95e18);
        vm.stopPrank();
        assertEq(musd.balanceOf(seller), 95e18);
        assertEq(musd.balanceOf(treasury), 0);
    }

    function test_fill_sellerCanBuyBack() public {
        uint256 id = _list(seller, 100e18, 500);
        _fill(seller, id, 100e18);
        assertEq(vault.balanceOf(seller), DEPOSIT);
        assertEq(musd.balanceOf(seller), 95e18 - 0.095e18);
        assertEq(musd.balanceOf(treasury), 0.095e18);
    }

    /* cancel */

    function test_cancel_returnsTheUnsoldShares() public {
        uint256 id = _list(seller, 100e18, 500);
        _fill(buyer, id, 30e18);

        vm.prank(carol);
        vm.expectRevert(ShareMarket.NotSeller.selector);
        market.cancel(id);

        vm.expectEmit(address(market));
        emit ShareMarket.Cancelled(id, seller, 70e18, 0);
        vm.prank(seller);
        assertEq(market.cancel(id), 70e18);
        assertEq(vault.balanceOf(seller), DEPOSIT - 30e18);
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(market.openListingCount(), 0);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ListingClosed.selector, id));
        market.cancel(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ListingClosed.selector, id));
        market.fill(id, 10e18, type(uint256).max);
    }

    function test_cancel_waitsWhileShareReceiptIsPaused() public {
        uint256 id = _list(seller, 100e18, 500);
        _pause(true);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ShareReceiptPaused.selector, seller));
        market.cancel(id);
        assertEq(market.listing(id).shares, 100e18);
    }

    /// @dev Withdrawals stay open while share receipt is paused, so a seller can always leave as a holder could.
    function test_cancelAndRedeem_exitsWhilePaused() public {
        uint256 id = _list(seller, 100e18, 500);
        _fill(buyer, id, 40e18);
        _gain(DEPOSIT / 10);
        _pause(true);

        uint256 expected = vault.previewRedeem(60e18);
        vm.prank(carol);
        vm.expectRevert(ShareMarket.NotSeller.selector);
        market.cancelAndRedeem(id, 0);
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.RedeemedBelowMin.selector, expected, expected + 1));
        market.cancelAndRedeem(id, expected + 1);

        uint256 before = musd.balanceOf(seller);
        vm.expectEmit(address(market));
        emit ShareMarket.Cancelled(id, seller, 60e18, expected);
        vm.prank(seller);
        assertEq(market.cancelAndRedeem(id, expected), expected);
        assertEq(musd.balanceOf(seller) - before, expected);
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(market.openListingCount(), 0);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ShareMarket.ListingClosed.selector, id));
        market.cancelAndRedeem(id, 0);
    }

    /* Views */

    function test_views_listingsAndBestPrice() public {
        _deposit(carol, DEPOSIT);
        assertEq(market.openListingCount(), 0);
        (uint256 best,,,) = market.bestListing();
        assertEq(best, 0);

        uint256 a = _list(seller, 100e18, 300);
        uint256 b = _list(carol, 50e18, 800);
        uint256 c = _list(seller, 70e18, 800);
        uint256 d = _list(carol, 20e18, 100);

        // Largest discount wins; the earlier listing on a tie.
        (uint256 id, uint16 discount, uint256 shares, uint256 pricePerShare) = market.bestListing();
        assertEq(id, b);
        assertEq(discount, 800);
        assertEq(shares, 50e18);
        assertEq(pricePerShare, 0.92e18);

        uint256[] memory mine = market.listingsOf(seller);
        assertEq(mine.length, 2);
        assertEq(mine[0], a);
        assertEq(mine[1], c);

        // Paging through every open listing.
        (uint256[] memory ids, ShareMarket.Listing[] memory items) = market.openListings(0, 3);
        assertEq(ids.length, 3);
        assertEq(items[1].seller, carol);
        assertEq(items[1].shares, 50e18);
        (ids,) = market.openListings(3, 10);
        assertEq(ids.length, 1);
        assertEq(ids[0], d);
        (ids,) = market.openListings(4, 10);
        assertEq(ids.length, 0);

        // b sells out: c is best; a is cancelled: the seller has c left.
        _fill(buyer, b, 50e18);
        (id,,,) = market.bestListing();
        assertEq(id, c);
        vm.prank(seller);
        market.cancel(a);
        mine = market.listingsOf(seller);
        assertEq(mine.length, 1);
        assertEq(mine[0], c);
        assertEq(market.openListingCount(), 2);
        assertEq(market.listingsOf(buyer).length, 0);

        // The price per share follows the vault.
        _gain(DEPOSIT / 5);
        (,,, pricePerShare) = market.bestListing();
        (uint256 expected,) = _expectedPrice(1e18, 800);
        assertEq(pricePerShare, expected);
        assertGt(pricePerShare, 0.92e18);
    }

    function test_quote_matchesTheFill() public {
        uint256 id = _list(seller, 100e18, 750);
        _gain(DEPOSIT / 7);
        (uint256 filled, uint256 assets, uint256 fee) = market.quote(id, 33e18);
        (uint256 expected, uint256 expectedFee) = _expectedPrice(33e18, 750);
        assertEq(filled, 33e18);
        assertEq(assets, expected);
        assertEq(fee, expectedFee);

        uint256 treasuryBefore = musd.balanceOf(treasury);
        (uint256 got, uint256 paid) = _fill(buyer, id, 33e18);
        assertEq(got, filled);
        assertEq(paid, assets);
        assertEq(musd.balanceOf(treasury) - treasuryBefore, fee);

        // Capped at what is left; zero for a closed listing or a fill below the minimum.
        (filled,,) = market.quote(id, 1_000e18);
        assertEq(filled, 67e18);
        (filled, assets, fee) = market.quote(id, market.MIN_SHARES() - 1);
        assertEq(filled + assets + fee, 0);
        (filled, assets, fee) = market.quote(42, 10e18);
        assertEq(filled + assets + fee, 0);
    }

    /* Reentrancy */

    /// @dev A token that calls back into the market from inside a fill's MUSD transfer is stopped by the guard.
    function test_fill_isNotReentrant() public {
        HookERC20 hooked = new HookERC20();
        VaultV2 hookedVault = new VaultV2(admin, address(hooked));
        ShareMarket hookedMarket = new ShareMarket(IVaultV2(address(hookedVault)), treasury, FEE_BPS);

        hooked.mint(seller, 100e18);
        vm.startPrank(seller);
        hooked.approve(address(hookedVault), 100e18);
        hookedVault.deposit(100e18, seller);
        hookedVault.approve(address(hookedMarket), 100e18);
        uint256 id = hookedMarket.list(100e18, 500);
        vm.stopPrank();

        hooked.mint(buyer, 95e18);
        vm.prank(buyer);
        hooked.approve(address(hookedMarket), 95e18);
        hooked.arm(address(hookedMarket), abi.encodeCall(ShareMarket.fill, (id, 50e18, 95e18)));
        vm.prank(buyer);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        hookedMarket.fill(id, 50e18, 95e18);
        assertEq(hookedMarket.listing(id).shares, 100e18);
    }
}
