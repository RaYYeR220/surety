// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IMusdPeg} from "../../src/interfaces/IMusdPeg.sol";
import {IPegSource} from "../../src/interfaces/IPegSource.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {BtcMusdPriceSource} from "../../src/oracles/BtcMusdPriceSource.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {StressedPriceSource} from "../../src/oracles/StressedPriceSource.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {MusdPeg} from "../../src/oracles/peg/MusdPeg.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockPegSource} from "../mocks/MockPegSource.sol";

/// @notice IMusdPeg whose `musdUsdWad` returns a set value or reverts with a set error.
contract ScriptedPeg is IMusdPeg {
    uint256 public value;
    bytes public revertData;
    bool public healthy = true;
    bool public healthReverts;

    error Boom();

    function set(uint256 value_, bytes memory revertData_) external {
        value = value_;
        revertData = revertData_;
    }

    function setHealth(bool healthy_, bool reverts_) external {
        healthy = healthy_;
        healthReverts = reverts_;
    }

    function musdUsdWad() external view returns (uint256) {
        bytes memory data = revertData;
        if (data.length > 0) {
            assembly ("memory-safe") {
                revert(add(data, 32), mload(data))
            }
        }
        return value;
    }

    function pegHealthy() external view returns (bool) {
        if (healthReverts) revert Boom();
        return healthy;
    }
}

contract OraclesTest is Test {
    /// @dev $81,565.5831 with 18 decimals, as reported by the Skip BTC/USD feed.
    int256 internal constant BTC_USD = 81565583100000000000000;

    MockAggregator internal aggregator;
    SkipPriceSource internal skipSource;
    StressedPriceSource internal stressed;

    function setUp() public {
        vm.warp(1792771353);
        aggregator = new MockAggregator(BTC_USD);
        skipSource = new SkipPriceSource(IAggregatorV3(address(aggregator)), 60, 18);
        stressed = new StressedPriceSource(skipSource);
    }

    /* SkipPriceSource */

    function test_skip_returnsWad() public view {
        assertEq(skipSource.priceWad(), uint256(BTC_USD));
    }

    function test_skip_revertsWhenOlderThan60s() public {
        aggregator.setUpdatedAt(block.timestamp - 61);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        skipSource.priceWad();
    }

    function test_skip_acceptsExactlyMaxAge() public {
        aggregator.setUpdatedAt(block.timestamp - 60);
        assertEq(skipSource.priceWad(), uint256(BTC_USD));
    }

    function test_skip_revertsOnNonPositive() public {
        aggregator.setAnswer(0);
        vm.expectRevert(IPriceSource.BadPrice.selector);
        skipSource.priceWad();

        aggregator.setAnswer(-1);
        vm.expectRevert(IPriceSource.BadPrice.selector);
        skipSource.priceWad();
    }

    function test_skip_revertsOnFutureTimestamp() public {
        aggregator.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert(IPriceSource.BadPrice.selector);
        skipSource.priceWad();
    }

    function test_skip_rejectsZeroMaxAge() public {
        vm.expectRevert(SkipPriceSource.ZeroMaxAge.selector);
        new SkipPriceSource(IAggregatorV3(address(aggregator)), 0, 18);
    }

    function test_skip_rejectsDecimalsAbove18() public {
        vm.expectRevert(SkipPriceSource.UnsupportedDecimals.selector);
        this.deploySkip(19);
    }

    function test_skip_revertsWhenFeedDecimalsDiffer() public {
        SkipPriceSource wrong = new SkipPriceSource(IAggregatorV3(address(aggregator)), 60, 8);
        vm.expectRevert(SkipPriceSource.UnsupportedDecimals.selector);
        wrong.priceWad();
    }

    function test_skip_constructorMakesNoExternalCall() public {
        // An address with no code would revert on any call; deployment must still succeed.
        SkipPriceSource lazy = new SkipPriceSource(IAggregatorV3(address(0xdead)), 60, 18);
        assertEq(lazy.decimals(), 18);
    }

    function deploySkip(uint8 decimals_) external returns (SkipPriceSource) {
        return new SkipPriceSource(IAggregatorV3(address(aggregator)), 60, decimals_);
    }

    /* StressedPriceSource */

    function test_stressed_passesThroughWithoutShock() public view {
        assertEq(stressed.haircutBps(), 0);
        assertEq(stressed.priceWad(), uint256(BTC_USD));
    }

    function test_stressed_appliesHaircutUntilExpiry() public {
        stressed.shock(4000, 30 minutes);
        assertEq(stressed.haircutBps(), 4000);
        assertEq(stressed.shockEndsAt(), block.timestamp + 30 minutes);
        assertEq(stressed.priceWad(), uint256(BTC_USD) * 6000 / 10_000);

        vm.warp(block.timestamp + 31 minutes);
        assertEq(stressed.haircutBps(), 0);
        assertEq(stressed.priceWad(), uint256(BTC_USD));
    }

    function test_stressed_rejectsHaircutAbove9000() public {
        vm.expectRevert(StressedPriceSource.HaircutTooHigh.selector);
        stressed.shock(9001, 1 hours);

        stressed.shock(9000, 1 hours);
        assertEq(stressed.priceWad(), uint256(BTC_USD) / 10);
    }

    function test_stressed_rejectsDurationAbove2Hours() public {
        vm.expectRevert(StressedPriceSource.ShockTooLong.selector);
        stressed.shock(1000, 2 hours + 1);
    }

    function test_stressed_isPermissionless() public {
        vm.prank(makeAddr("anyone"));
        stressed.shock(2500, 10 minutes);
        assertEq(stressed.haircutBps(), 2500);
    }

    function test_stressed_propagatesStaleBase() public {
        stressed.shock(4000, 30 minutes);
        aggregator.setUpdatedAt(block.timestamp - 61);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        stressed.priceWad();
    }

    /* MorphoPriceOracle */

    function test_morphoOracle_scales1e36() public {
        MorphoPriceOracle oracle = new MorphoPriceOracle(skipSource);
        assertEq(oracle.price(), 81565583100000000000000 * 1e18);
    }

    function test_morphoOracle_revertsWhenStale() public {
        MorphoPriceOracle oracle = new MorphoPriceOracle(stressed);
        aggregator.setUpdatedAt(block.timestamp - 61);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        oracle.price();
    }

    function test_morphoOracle_followsShock() public {
        MorphoPriceOracle oracle = new MorphoPriceOracle(stressed);
        stressed.shock(6000, 1 hours);
        assertEq(oracle.price(), uint256(BTC_USD) * 4000 / 10_000 * 1e18);
    }

    /* BtcMusdPriceSource */

    /// @dev The peg moves the price only while healthy, only above $1 and never by more than the premium cap.
    function test_btcMusd_dividesByAHealthyPegClampedToThePremium() public {
        MockPegSource s = new MockPegSource(1e18);
        IPegSource[] memory list = new IPegSource[](1);
        list[0] = s;
        MusdPeg peg = new MusdPeg(list, 1, 500, 300);
        BtcMusdPriceSource source = new BtcMusdPriceSource(skipSource, peg, 300);
        assertEq(source.maxPremiumBps(), 300);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // MUSD below $1 is ignored, healthy or not: BTC is never worth more MUSD than USD.
        s.set(true, 0.98e18);
        assertTrue(peg.pegHealthy());
        assertEq(source.musdUsdWad(), 1e18);
        assertEq(source.priceWad(), uint256(BTC_USD));
        s.set(true, 0.95e18);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // A healthy MUSD above $1 lowers the BTC price in MUSD, up to the band's edge.
        s.set(true, 1.02e18);
        assertEq(source.priceWad(), uint256(BTC_USD) * 1e18 / 1.02e18);
        s.set(true, 1.03e18);
        assertTrue(peg.pegHealthy());
        assertEq(source.musdUsdWad(), 1.03e18);

        // An unhealthy peg counts as exactly $1, however high its median: the lifted median of the H-01 push
        // (1.466) and a median just past the band alike.
        s.set(true, 1.04e18);
        assertFalse(peg.pegHealthy());
        assertEq(source.priceWad(), uint256(BTC_USD));
        s.set(true, 1.466e18);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // An unavailable peg counts as exactly $1.
        s.set(false, 0);
        assertEq(source.musdUsdWad(), 1e18);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // The premium cap binds below the band: with 100 bps a healthy 1.02 divides by 1.01, and with 0 never.
        s.set(true, 1.02e18);
        assertEq(new BtcMusdPriceSource(skipSource, peg, 100).musdUsdWad(), 1.01e18);
        assertEq(new BtcMusdPriceSource(skipSource, peg, 0).priceWad(), uint256(BTC_USD));

        // Morpho's oracle stays a plain scale of the source.
        MorphoPriceOracle oracle = new MorphoPriceOracle(source);
        assertEq(oracle.price(), uint256(BTC_USD) * 1e18 / 1.02e18 * 1e18);
    }

    /// @dev Whatever the peg does wrong reads as $1; only the BTC/USD source can make the price revert.
    function test_btcMusd_anyPegFailureReadsAsOneDollar_onlySkipReverts() public {
        ScriptedPeg peg = new ScriptedPeg();
        BtcMusdPriceSource source = new BtcMusdPriceSource(skipSource, peg, 300);
        peg.set(1.01e18, "");
        assertEq(source.priceWad(), uint256(BTC_USD) * 1e18 / 1.01e18);

        peg.set(0, abi.encodeWithSelector(IMusdPeg.PegUnavailable.selector));
        assertEq(source.priceWad(), uint256(BTC_USD));
        peg.set(0, abi.encodeWithSelector(ScriptedPeg.Boom.selector));
        assertEq(source.priceWad(), uint256(BTC_USD));
        peg.set(0, abi.encodePacked(IMusdPeg.PegUnavailable.selector, uint256(1)));
        assertEq(source.priceWad(), uint256(BTC_USD));

        peg.set(1.01e18, "");
        peg.setHealth(false, false);
        assertEq(source.priceWad(), uint256(BTC_USD));
        peg.setHealth(true, true);
        assertEq(source.priceWad(), uint256(BTC_USD));
        peg.setHealth(true, false);

        aggregator.setUpdatedAt(block.timestamp - 61);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        source.priceWad();

        vm.expectRevert(BtcMusdPriceSource.ZeroAddress.selector);
        new BtcMusdPriceSource(IPriceSource(address(0)), peg, 300);
        vm.expectRevert(BtcMusdPriceSource.ZeroAddress.selector);
        new BtcMusdPriceSource(skipSource, IMusdPeg(address(0)), 300);
        vm.expectRevert(BtcMusdPriceSource.PremiumTooHigh.selector);
        new BtcMusdPriceSource(skipSource, peg, 501);
        new BtcMusdPriceSource(skipSource, peg, 500);
    }

    /// @dev Whatever the peg reads, the price never leaves [BTC/USD / (1 + premium), BTC/USD].
    function testFuzz_btcMusd_boundedByThePremium(uint256 median, bool healthy, uint16 premium) public {
        premium = uint16(bound(premium, 0, 500));
        median = bound(median, 0, 10e18);
        ScriptedPeg peg = new ScriptedPeg();
        peg.set(median, "");
        peg.setHealth(healthy, false);
        uint256 price = new BtcMusdPriceSource(skipSource, peg, premium).priceWad();
        assertLe(price, uint256(BTC_USD));
        assertGe(price, uint256(BTC_USD) * 10_000 / (10_000 + premium));
    }
}
