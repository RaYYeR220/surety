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

    error Boom();

    function set(uint256 value_, bytes memory revertData_) external {
        value = value_;
        revertData = revertData_;
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

    function pegHealthy() external pure returns (bool) {
        return true;
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

    function test_btcMusd_dividesByPegAboveOneOnly() public {
        MockPegSource s = new MockPegSource(1e18);
        IPegSource[] memory list = new IPegSource[](1);
        list[0] = s;
        MusdPeg peg = new MusdPeg(list, 1, 500, 300);
        BtcMusdPriceSource source = new BtcMusdPriceSource(skipSource, peg);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // MUSD below $1 is ignored: BTC is never worth more MUSD than USD.
        s.set(true, 0.95e18);
        assertEq(source.musdUsdWad(), 0.95e18);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // MUSD above $1 lowers the BTC price in MUSD, even when the peg is unhealthy.
        s.set(true, 1.04e18);
        assertFalse(peg.pegHealthy());
        assertEq(source.priceWad(), uint256(BTC_USD) * 1e18 / 1.04e18);

        // An unavailable peg counts as exactly $1.
        s.set(false, 0);
        assertEq(source.musdUsdWad(), 1e18);
        assertEq(source.priceWad(), uint256(BTC_USD));

        // Morpho's oracle stays a plain scale of the source.
        s.set(true, 1.02e18);
        MorphoPriceOracle oracle = new MorphoPriceOracle(source);
        assertEq(oracle.price(), uint256(BTC_USD) * 1e18 / 1.02e18 * 1e18);
    }

    function test_btcMusd_revertsOnlyWithSkip_orOnOtherPegFailures() public {
        ScriptedPeg peg = new ScriptedPeg();
        BtcMusdPriceSource source = new BtcMusdPriceSource(skipSource, peg);
        peg.set(1.01e18, "");
        assertEq(source.priceWad(), uint256(BTC_USD) * 1e18 / 1.01e18);

        peg.set(0, abi.encodeWithSelector(IMusdPeg.PegUnavailable.selector));
        assertEq(source.priceWad(), uint256(BTC_USD));

        // Only a bare PegUnavailable falls back; anything else propagates.
        peg.set(0, abi.encodeWithSelector(ScriptedPeg.Boom.selector));
        vm.expectRevert(ScriptedPeg.Boom.selector);
        source.priceWad();
        peg.set(0, abi.encodePacked(IMusdPeg.PegUnavailable.selector, uint256(1)));
        vm.expectRevert(abi.encodePacked(IMusdPeg.PegUnavailable.selector, uint256(1)));
        source.priceWad();

        peg.set(1e18, "");
        aggregator.setUpdatedAt(block.timestamp - 61);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        source.priceWad();

        vm.expectRevert(BtcMusdPriceSource.ZeroAddress.selector);
        new BtcMusdPriceSource(IPriceSource(address(0)), peg);
        vm.expectRevert(BtcMusdPriceSource.ZeroAddress.selector);
        new BtcMusdPriceSource(skipSource, IMusdPeg(address(0)));
    }
}
