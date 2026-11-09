// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ShareMarket} from "../../src/ShareMarket.sol";
import {ShareMarketFixture} from "../utils/ShareMarketFixture.sol";

/// @notice ShareMarket pricing, partial fills and conservation over fuzzed share prices, sizes and discounts.
contract ShareMarketFuzzTest is ShareMarketFixture {
    uint256 internal min;

    function setUp() public override {
        super.setUp();
        min = market.MIN_SHARES();
    }

    /// @notice Moves the share price from 1 by `gainBps` up, then `lossBps` of the vault's MUSD down.
    function _movePrice(uint256 deposited, uint256 gainBps, uint256 lossBps) internal {
        if (gainBps != 0) _gain(deposited * gainBps / BPS);
        if (lossBps != 0) _lose(musd.balanceOf(address(vault)) * lossBps / BPS);
    }

    /// @dev One fill at any share price: the buyer pays the discounted value rounded up, the MUSD paid is exactly
    /// what the seller and the treasury receive, the seller gets at least the exact discounted value net of the fee,
    /// and every listed share ends with the buyer, the seller (dust) or still in the listing.
    function testFuzz_fill_pricesAtTheDiscountAndConservesMusd(
        uint256 deposit,
        uint256 gainBps,
        uint256 lossBps,
        uint256 listed,
        uint16 discountBps,
        uint256 bought
    ) public {
        deposit = bound(deposit, 1e15, 1e27);
        gainBps = bound(gainBps, 0, BPS);
        lossBps = bound(lossBps, 0, 9_000);
        discountBps = uint16(bound(discountBps, 0, market.MAX_DISCOUNT_BPS()));

        uint256 sellerShares = _deposit(seller, deposit);
        _movePrice(deposit, gainBps, lossBps);
        listed = bound(listed, min, sellerShares);
        bought = bound(bought, min, listed);

        uint256 id = _list(seller, listed, discountBps);
        uint256 value = vault.convertToAssets(bought);
        (uint256 expected, uint256 expectedFee) = _expectedPrice(bought, discountBps);

        (uint256 filled, uint256 assets) = _fill(buyer, id, bought);
        assertEq(filled, bought);
        assertEq(assets, expected);
        _checkMusd(value, assets, expectedFee, discountBps);
        _checkShares(id, listed, bought, sellerShares);
    }

    function _checkMusd(uint256 value, uint256 assets, uint256 expectedFee, uint16 discountBps) internal view {
        uint256 sellerMusd = musd.balanceOf(seller);
        uint256 treasuryMusd = musd.balanceOf(treasury);
        // Price: the discounted value, rounded up and never above the value.
        assertLe(assets, value);
        assertGe(assets * BPS, value * (BPS - discountBps));
        assertLt((assets - 1) * BPS, value * (BPS - discountBps));
        // Conservation: what the buyer paid is what the seller and the treasury got.
        assertEq(musd.balanceOf(buyer), 0);
        assertEq(sellerMusd + treasuryMusd, assets);
        assertEq(treasuryMusd, expectedFee);
        assertEq(musd.balanceOf(address(market)), 0);
        // The fee rounds down: the seller gets at least the exact discounted value net of the fee.
        assertGe(sellerMusd * BPS * BPS, value * (BPS - discountBps) * (BPS - FEE_BPS));
    }

    /// @dev Every listed share was bought, went back to the seller as dust, or is still listed.
    function _checkShares(uint256 id, uint256 listed, uint256 bought, uint256 sellerShares) internal view {
        uint256 left = listed - bought;
        uint256 dust = left < min ? left : 0;
        assertEq(vault.balanceOf(buyer), bought);
        assertEq(market.listing(id).shares, left - dust);
        assertEq(vault.balanceOf(address(market)), left - dust);
        assertEq(vault.balanceOf(seller), sellerShares - listed + dust);
        assertEq(market.openListingCount(), left - dust == 0 ? 0 : 1);
    }

    /// @dev A run of partial fills by different buyers, with the share price moving in between: every share and
    /// every MUSD is accounted for at each step, the listing never holds dust, and the seller gets the rest back.
    function testFuzz_partialFills_conserveSharesAndMusd(
        uint256 deposit,
        uint256 listed,
        uint16 discountBps,
        uint256 seed,
        uint8 rounds
    ) public {
        deposit = bound(deposit, 1e18, 1e27);
        discountBps = uint16(bound(discountBps, 0, market.MAX_DISCOUNT_BPS()));
        rounds = uint8(bound(rounds, 1, 12));
        uint256 sellerShares = _deposit(seller, deposit);
        listed = bound(listed, min, sellerShares);
        uint256 id = _list(seller, listed, discountBps);

        uint256 sold;
        uint256 paid;
        for (uint256 i; i < rounds; ++i) {
            uint256 remaining = market.listing(id).shares;
            if (remaining == 0) break;
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            // Sometimes the share price moves first (up to +5% or -5% of the vault).
            uint256 moveBps = (r >> 8) % 500;
            if (r % 3 == 0) _gain(musd.balanceOf(address(vault)) * moveBps / BPS);
            else if (r % 3 == 1) _lose(musd.balanceOf(address(vault)) * moveBps / BPS);
            // Ask for anything from the minimum to more than is left.
            uint256 ask = bound(r >> 16, min, remaining + remaining / 4);
            address who = address(uint160(uint256(keccak256(abi.encode("buyer", i)))));

            (uint256 filled, uint256 assets) = _fill(who, id, ask);
            assertEq(filled, ask < remaining ? ask : remaining);
            assertEq(vault.balanceOf(who), filled);
            sold += filled;
            paid += assets;

            uint256 open = market.listing(id).shares;
            assertTrue(open == 0 || open >= min, "no dust left listed");
            assertEq(vault.balanceOf(address(market)), open);
            assertEq(musd.balanceOf(seller) + musd.balanceOf(treasury), paid);
            assertEq(musd.balanceOf(address(market)), 0);
        }

        uint256 back;
        uint256 stillListed = market.listing(id).shares;
        if (stillListed != 0) {
            vm.prank(seller);
            back = market.cancel(id);
        }
        // Every listed share went to a buyer or back to the seller (as dust or on cancel).
        assertEq(vault.balanceOf(address(market)), 0);
        assertEq(vault.balanceOf(seller) + sold, sellerShares);
        assertEq(back, stillListed);
        assertEq(market.openListingCount(), 0);
        assertEq(musd.balanceOf(seller) + musd.balanceOf(treasury), paid);
    }

    /// @dev Listings at random discounts: the best listing is the largest discount, and its price per share is the
    /// cheapest a buyer can get.
    function testFuzz_bestListing_isTheCheapest(uint16[6] memory discounts, uint256 gainBps) public {
        _deposit(seller, 1_000e18);
        _movePrice(1_000e18, bound(gainBps, 0, BPS), 0);
        uint16 top;
        uint256 topId;
        for (uint256 i; i < discounts.length; ++i) {
            uint16 d = uint16(bound(discounts[i], 0, market.MAX_DISCOUNT_BPS()));
            uint256 id = _list(seller, 10e18, d);
            if (topId == 0 || d > top) (top, topId) = (d, id);
        }
        (uint256 best, uint16 discount,, uint256 pricePerShare) = market.bestListing();
        assertEq(best, topId);
        assertEq(discount, top);
        for (uint256 id = 1; id <= discounts.length; ++id) {
            (, uint256 assets,) = market.quote(id, 1e18);
            assertGe(assets, pricePerShare);
        }
    }
}
