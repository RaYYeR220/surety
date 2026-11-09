// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Test} from "forge-std/Test.sol";

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IMusdPeg} from "../../src/interfaces/IMusdPeg.sol";
import {IPegSource} from "../../src/interfaces/IPegSource.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {IBasicPool, ICLPool} from "../../src/interfaces/ITigrisPools.sol";
import {TickPrice} from "../../src/libraries/TickPrice.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {BtcCrossPegSource} from "../../src/oracles/peg/BtcCrossPegSource.sol";
import {ClTwapPegSource} from "../../src/oracles/peg/ClTwapPegSource.sol";
import {MusdPeg} from "../../src/oracles/peg/MusdPeg.sol";
import {ClPegSourceBase, PegSourceBase} from "../../src/oracles/peg/PegSourceBase.sol";
import {StableTwapPegSource} from "../../src/oracles/peg/StableTwapPegSource.sol";
import {StressedPegSource} from "../../src/oracles/peg/StressedPegSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPegSource} from "../mocks/MockPegSource.sol";
import {MockBasicPool, MockCLPool} from "../mocks/MockTigrisPools.sol";

/// @notice Exposes TickPrice so reverts surface at a lower call depth.
contract TickPriceHarness {
    function pow(uint256 n) external pure returns (uint256) {
        return TickPrice.pow(n);
    }

    function priceWad(int256 tick, uint8 baseDecimals, uint8 quoteDecimals) external pure returns (uint256) {
        return TickPrice.priceWad(tick, baseDecimals, quoteDecimals);
    }

    function meanTick(int56 then_, int56 now_, uint32 window) external pure returns (int256) {
        return TickPrice.meanTick(then_, now_, window);
    }
}

/// @notice Peg source that answers whatever raw bytes it is told to, or reverts.
contract RawPegSource {
    bytes public answer;
    bool public reverts;

    function setAnswer(bytes memory answer_) external {
        answer = answer_;
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        require(!reverts, "down");
        return answer;
    }
}

/// @notice The tick math, the four MUSD/USD sources and MusdPeg.
contract PegTest is Test {
    /// @dev Exact reference values, floor(x * scale), computed with 100-digit decimal arithmetic.
    uint256 internal constant POW_276410 = 1008633985894954426478028798229537271661946104125;
    uint256 internal constant POW_112285 = 75202414145816997817819411739210519264130;
    uint256 internal constant POW_887272 = 340256786836388094050805785052946541066751507546701582068884050462948821114;
    uint256 internal constant POW_524287 = 58661978243598610040297556592206370526438511255041389938561;
    /// @dev MUSD in mUSDC at tick 276410 (mUSDC token0, 6 decimals; MUSD token1, 18), WAD.
    uint256 internal constant MUSD_USDC_276410 = 991439921700344504;
    /// @dev BTC in MUSD at tick 112285 (both 18 decimals), WAD.
    uint256 internal constant BTC_MUSD_112285 = 75202414145816997817819;
    /// @dev Skip BTC/USD on 2026-11-09 02:4x UTC, and MUSD/USD it implies against BTC_MUSD_112285.
    int256 internal constant BTC_USD = 75_387.77e18;
    uint256 internal constant CROSS_READING = 1002464759360299236;

    TickPriceHarness internal tp;
    MockERC20 internal musd;
    MockERC20 internal usdc;
    MockERC20 internal btc;
    MockAggregator internal aggregator;
    SkipPriceSource internal skipSource;

    function setUp() public {
        vm.warp(1794194454);
        tp = new TickPriceHarness();
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        usdc = new MockERC20("USDC", "mUSDC", 6);
        btc = new MockERC20("Bitcoin", "BTC", 18);
        aggregator = new MockAggregator(BTC_USD);
        skipSource = new SkipPriceSource(IAggregatorV3(address(aggregator)), 60, 18);
    }

    /* TickPrice */

    function test_pow_matchesExactReference() public view {
        assertEq(tp.pow(0), 1e36);
        assertEq(tp.pow(1), 1.0001e36);
        assertEq(tp.pow(2), 1.00020001e36);
        _assertRel(tp.pow(276_410), POW_276410, 1e30);
        _assertRel(tp.pow(112_285), POW_112285, 1e30);
        _assertRel(tp.pow(524_287), POW_524287, 1e30);
        _assertRel(tp.pow(887_272), POW_887272, 1e30);
    }

    function test_pow_rejectsBeyondMaxTick() public {
        vm.expectRevert(TickPrice.TickOutOfRange.selector);
        tp.pow(887_273);
    }

    function test_priceWad_handlesOrderAndDecimals() public view {
        // MUSD is token1 of the mainnet CL mUSDC/MUSD pool: MUSD in mUSDC is token1 in token0.
        assertApproxEqAbs(tp.priceWad(-276_410, 18, 6), MUSD_USDC_276410, 1);
        // The same pool read the other way round: mUSDC in MUSD.
        assertApproxEqAbs(tp.priceWad(276_410, 6, 18), 1008633985894954426, 1);
        assertApproxEqAbs(tp.priceWad(112_285, 18, 18), BTC_MUSD_112285, 1);
        assertEq(tp.priceWad(0, 18, 18), 1e18);
        // At tick 0 a raw unit buys a raw unit: one whole 6-decimal token is 1e-12 of an 18-decimal one.
        assertEq(tp.priceWad(0, 6, 18), 1e6);
        assertEq(tp.priceWad(0, 18, 6), 1e30);
    }

    function test_priceWad_rejectsBadInput() public {
        vm.expectRevert(TickPrice.TickOutOfRange.selector);
        tp.priceWad(887_273, 18, 18);
        vm.expectRevert(TickPrice.TickOutOfRange.selector);
        tp.priceWad(-887_273, 18, 18);
        vm.expectRevert(TickPrice.UnsupportedDecimals.selector);
        tp.priceWad(0, 19, 18);
        vm.expectRevert(TickPrice.UnsupportedDecimals.selector);
        tp.priceWad(0, 18, 19);
        // The extremes stay in range.
        assertGt(tp.priceWad(887_272, 18, 0), 0);
        assertEq(tp.priceWad(-887_272, 0, 18), 0);
    }

    function test_meanTick_roundsTowardNegativeInfinity() public view {
        assertEq(tp.meanTick(0, 3600, 1800), 2);
        assertEq(tp.meanTick(0, 3601, 1800), 2);
        assertEq(tp.meanTick(0, -3600, 1800), -2);
        assertEq(tp.meanTick(0, -3601, 1800), -3);
        assertEq(tp.meanTick(7092588283988, 7093085821988, 1800), 276_410);
        assertEq(tp.meanTick(100, 100, 60), 0);
    }

    /// @dev 1.0001^(a+b) = 1.0001^a * 1.0001^b to within 1e-30.
    function testFuzz_pow_isMultiplicative(uint256 a, uint256 b) public view {
        a = bound(a, 0, 443_636);
        b = bound(b, 0, 443_636);
        uint256 product = Math.mulDiv(tp.pow(a), tp.pow(b), 1e36);
        _assertRel(tp.pow(a + b), product, 1e30);
    }

    /// @dev Inverse prices multiply to one, and the price rises with the tick.
    function testFuzz_priceWad_inverseAndMonotonic(int256 tick) public view {
        tick = bound(tick, -100_000, 100_000);
        uint256 up = tp.priceWad(tick, 18, 18);
        uint256 down = tp.priceWad(-tick, 18, 18);
        assertApproxEqRel(up * down, 1e36, 1e5);
        assertGt(tp.priceWad(tick + 1, 18, 18), up);
    }

    /* ClTwapPegSource */

    function test_clTwap_readsMusdInStable_eitherTokenOrder() public {
        // Mainnet layout: mUSDC token0, MUSD token1.
        MockCLPool pool = new MockCLPool(address(usdc), address(musd));
        pool.setMeanTick(276_410, 30 minutes);
        ClTwapPegSource source = new ClTwapPegSource(pool, address(musd), 30 minutes);
        assertFalse(source.musdIsToken0());
        assertEq(source.stableDecimals(), 6);
        assertEq(source.other(), address(usdc));
        (bool ok, uint256 price) = source.read();
        assertTrue(ok);
        assertApproxEqAbs(price, MUSD_USDC_276410, 1);

        // MUSD as token0 at the opposite tick reads the same price.
        MockCLPool flipped = new MockCLPool(address(musd), address(usdc));
        flipped.setMeanTick(-276_410, 30 minutes);
        ClTwapPegSource source2 = new ClTwapPegSource(flipped, address(musd), 30 minutes);
        assertTrue(source2.musdIsToken0());
        (bool ok2, uint256 price2) = source2.read();
        assertTrue(ok2);
        assertEq(price2, price);
    }

    function test_clTwap_notOkWithoutHistoryLiquidityOrSanePrice() public {
        MockCLPool pool = new MockCLPool(address(usdc), address(musd));
        pool.setMeanTick(276_410, 30 minutes);
        ClTwapPegSource source = new ClTwapPegSource(pool, address(musd), 30 minutes);

        pool.setHistory(29 minutes);
        _assertNotOk(source);
        pool.setHistory(30 minutes);
        (bool ok,) = source.read();
        assertTrue(ok);

        pool.setLiquidity(0);
        _assertNotOk(source);
        pool.setLiquidity(1);

        // MUSD at about $0.40 and $2.50: a broken market, not a price.
        pool.setMeanTick(276_410 + 9163, 30 minutes);
        _assertNotOk(source);
        pool.setMeanTick(276_410 - 9163, 30 minutes);
        _assertNotOk(source);
        // A mean tick beyond the tick range.
        pool.setCumulatives(0, 887_273 * 1800);
        _assertNotOk(source);

        pool.setBroken(true);
        _assertNotOk(source);
    }

    function test_clTwap_constructorChecks() public {
        MockCLPool pool = new MockCLPool(address(usdc), address(musd));
        MockCLPool noMusd = new MockCLPool(address(usdc), address(btc));
        vm.expectRevert(PegSourceBase.NotMusdPool.selector);
        new ClTwapPegSource(noMusd, address(musd), 30 minutes);
        vm.expectRevert(ClPegSourceBase.BadWindow.selector);
        new ClTwapPegSource(pool, address(musd), 59);
        vm.expectRevert(ClPegSourceBase.BadWindow.selector);
        new ClTwapPegSource(pool, address(musd), 1 days + 1);
        vm.expectRevert(PegSourceBase.ZeroAddress.selector);
        new ClTwapPegSource(ICLPool(address(0)), address(musd), 30 minutes);
        MockERC20 odd = new MockERC20("Odd", "ODD", 19);
        MockCLPool oddPool = new MockCLPool(address(odd), address(musd));
        vm.expectRevert(PegSourceBase.UnsupportedDecimals.selector);
        new ClTwapPegSource(oddPool, address(musd), 30 minutes);
    }

    /* StableTwapPegSource */

    function test_stableTwap_quotesOneMusd() public {
        MockBasicPool pool = new MockBasicPool(address(usdc), address(musd));
        pool.setQuote(address(musd), 1e18, 990_825);
        StableTwapPegSource source = new StableTwapPegSource(pool, address(musd), 2);
        assertEq(source.stableDecimals(), 6);
        (bool ok, uint256 price) = source.read();
        assertTrue(ok);
        assertEq(price, 0.990825e18);

        // MUSD as token0 (the mainnet MUSD/mUSDT pool).
        MockBasicPool flipped = new MockBasicPool(address(musd), address(usdc));
        flipped.setQuote(address(musd), 1e18, 986_035);
        (ok, price) = new StableTwapPegSource(flipped, address(musd), 2).read();
        assertTrue(ok);
        assertEq(price, 0.986035e18);
    }

    function test_stableTwap_notOkWithoutPeriodsOrSanePrice() public {
        MockBasicPool pool = new MockBasicPool(address(usdc), address(musd));
        pool.setQuote(address(musd), 1e18, 990_825);
        StableTwapPegSource source = new StableTwapPegSource(pool, address(musd), 4);
        pool.setPeriods(3);
        _assertNotOk(source);
        pool.setPeriods(4);
        pool.setQuote(address(musd), 1e18, 499_999);
        _assertNotOk(source);
        pool.setQuote(address(musd), 1e18, type(uint256).max);
        _assertNotOk(source);
    }

    function test_stableTwap_constructorChecks() public {
        MockBasicPool pool = new MockBasicPool(address(usdc), address(musd));
        vm.expectRevert(StableTwapPegSource.BadGranularity.selector);
        new StableTwapPegSource(pool, address(musd), 0);
        vm.expectRevert(StableTwapPegSource.BadGranularity.selector);
        new StableTwapPegSource(pool, address(musd), 49);
        MockBasicPool noMusd = new MockBasicPool(address(usdc), address(btc));
        vm.expectRevert(PegSourceBase.NotMusdPool.selector);
        new StableTwapPegSource(noMusd, address(musd), 2);
        vm.expectRevert(PegSourceBase.ZeroAddress.selector);
        new StableTwapPegSource(IBasicPool(address(0)), address(musd), 2);
    }

    /* BtcCrossPegSource */

    function test_btcCross_dividesSkipByPoolPrice() public {
        // Mainnet layout: BTC token0, MUSD token1.
        MockCLPool pool = new MockCLPool(address(btc), address(musd));
        pool.setMeanTick(112_285, 30 minutes);
        BtcCrossPegSource source = new BtcCrossPegSource(pool, address(musd), 30 minutes, skipSource, 18);
        (bool ok, uint256 price) = source.read();
        assertTrue(ok);
        assertApproxEqAbs(price, CROSS_READING, 1);

        MockCLPool flipped = new MockCLPool(address(musd), address(btc));
        flipped.setMeanTick(-112_285, 30 minutes);
        (bool ok2, uint256 price2) = new BtcCrossPegSource(flipped, address(musd), 30 minutes, skipSource, 18).read();
        assertTrue(ok2);
        assertEq(price2, price);
    }

    function test_btcCross_notOkOnStaleSkipOrWrongBtc() public {
        MockCLPool pool = new MockCLPool(address(btc), address(musd));
        pool.setMeanTick(112_285, 30 minutes);
        BtcCrossPegSource source = new BtcCrossPegSource(pool, address(musd), 30 minutes, skipSource, 18);

        aggregator.setUpdatedAt(block.timestamp - 61);
        _assertNotOk(source);
        aggregator.setLive();
        aggregator.setAnswer(0);
        _assertNotOk(source);
        aggregator.setAnswer(BTC_USD);

        // Decimals other than the deployed ones, and a BTC address without code, read as nothing.
        _assertNotOk(new BtcCrossPegSource(pool, address(musd), 30 minutes, skipSource, 8));
        MockCLPool noCode = new MockCLPool(makeAddr("btcPrecompile"), address(musd));
        noCode.setMeanTick(112_285, 30 minutes);
        _assertNotOk(new BtcCrossPegSource(noCode, address(musd), 30 minutes, skipSource, 18));

        pool.setHistory(10 minutes);
        _assertNotOk(source);

        vm.expectRevert(PegSourceBase.UnsupportedDecimals.selector);
        new BtcCrossPegSource(pool, address(musd), 30 minutes, skipSource, 19);
        vm.expectRevert(PegSourceBase.ZeroAddress.selector);
        new BtcCrossPegSource(pool, address(musd), 30 minutes, IPriceSource(address(0)), 18);
    }

    /* StressedPegSource */

    function test_stressed_withoutBaseReadsOneDollar_andOverridesForAWhile() public {
        StressedPegSource source = new StressedPegSource(IPegSource(address(0)));
        (bool ok, uint256 price) = source.read();
        assertTrue(ok);
        assertEq(price, 1e18);

        address judge = makeAddr("judge");
        vm.expectEmit(address(source));
        emit StressedPegSource.Stressed(judge, 0.9e18, block.timestamp + 1 hours);
        vm.prank(judge);
        source.stress(0.9e18, 1 hours);
        (ok, price) = source.read();
        assertTrue(ok);
        assertEq(price, 0.9e18);
        (bool active, uint256 stressed) = source.activeStress();
        assertTrue(active);
        assertEq(stressed, 0.9e18);

        vm.warp(block.timestamp + 1 hours);
        (ok, price) = source.read();
        assertEq(price, 1e18);
        (active,) = source.activeStress();
        assertFalse(active);

        // Zero is an outage.
        source.stress(0, 30 minutes);
        _assertNotOk(source);
    }

    function test_stressed_passesBaseThrough_andBoundsOverrides() public {
        MockPegSource base = new MockPegSource(0.995e18);
        StressedPegSource source = new StressedPegSource(base);
        (bool ok, uint256 price) = source.read();
        assertTrue(ok);
        assertEq(price, 0.995e18);
        base.set(false, 0);
        _assertNotOk(source);

        vm.expectRevert(StressedPegSource.PriceOutOfRange.selector);
        source.stress(0.5e18 - 1, 1 hours);
        vm.expectRevert(StressedPegSource.PriceOutOfRange.selector);
        source.stress(2e18 + 1, 1 hours);
        vm.expectRevert(StressedPegSource.StressTooLong.selector);
        source.stress(1e18, 2 hours + 1);
        source.stress(1.05e18, 2 hours);
        (ok, price) = source.read();
        assertTrue(ok);
        assertEq(price, 1.05e18);
    }

    /* MusdPeg */

    function test_musdPeg_constructorChecks() public {
        MockPegSource a = new MockPegSource(1e18);
        MockPegSource b = new MockPegSource(1e18);
        vm.expectRevert(MusdPeg.NoSources.selector);
        new MusdPeg(new IPegSource[](0), 1, 500, 300);
        vm.expectRevert(MusdPeg.TooManySources.selector);
        new MusdPeg(new IPegSource[](9), 1, 500, 300);
        vm.expectRevert(MusdPeg.ZeroAddress.selector);
        new MusdPeg(_sources(a, IPegSource(address(0))), 1, 500, 300);
        vm.expectRevert(MusdPeg.DuplicateSource.selector);
        new MusdPeg(_sources(a, a), 1, 500, 300);
        vm.expectRevert(MusdPeg.BadParams.selector);
        new MusdPeg(_sources(a, b), 0, 500, 300);
        vm.expectRevert(MusdPeg.BadParams.selector);
        new MusdPeg(_sources(a, b), 3, 500, 300);
        vm.expectRevert(MusdPeg.BadParams.selector);
        new MusdPeg(_sources(a, b), 2, 0, 300);
        vm.expectRevert(MusdPeg.BadParams.selector);
        new MusdPeg(_sources(a, b), 2, 2001, 300);
        vm.expectRevert(MusdPeg.BadParams.selector);
        new MusdPeg(_sources(a, b), 2, 500, 0);
        vm.expectRevert(MusdPeg.BadParams.selector);
        new MusdPeg(_sources(a, b), 2, 500, 1001);

        MusdPeg peg = new MusdPeg(_sources(a, b), 2, 500, 300);
        assertEq(peg.minSources(), 2);
        assertEq(peg.maxSpreadBps(), 500);
        assertEq(peg.bandBps(), 300);
        assertEq(address(peg.sources()[1]), address(b));
    }

    /// @dev The mainnet readings of 2026-11-09: median of four is the mean of the middle two.
    function test_musdPeg_medianOfUsableSources() public {
        MockPegSource[4] memory s = [
            new MockPegSource(0.99144e18),
            new MockPegSource(0.990825e18),
            new MockPegSource(0.986035e18),
            new MockPegSource(1.002465e18)
        ];
        MusdPeg peg = new MusdPeg(_sources(s[0], s[1], s[2], s[3]), 2, 500, 300);
        assertEq(peg.musdUsdWad(), (0.990825e18 + 0.99144e18) / 2);
        assertTrue(peg.pegHealthy());

        // Three usable: the middle one.
        s[3].set(false, 0);
        assertEq(peg.musdUsdWad(), 0.990825e18);
        // Two usable: still enough.
        s[0].set(false, 0);
        assertEq(peg.musdUsdWad(), (0.986035e18 + 0.990825e18) / 2);
        assertTrue(peg.pegHealthy());
        // One usable: below minSources.
        s[1].set(false, 0);
        vm.expectRevert(IMusdPeg.PegUnavailable.selector);
        peg.musdUsdWad();
        assertFalse(peg.pegHealthy());

        MusdPeg.Reading[] memory r = peg.readings();
        assertEq(r.length, 4);
        assertFalse(r[0].ok);
        assertEq(r[0].musdUsdWad, 0);
        assertTrue(r[2].ok);
        assertEq(r[2].musdUsdWad, 0.986035e18);
        assertEq(address(r[3].source), address(s[3]));
    }

    function test_musdPeg_band() public {
        MockPegSource a = new MockPegSource(0.97e18);
        MusdPeg peg = new MusdPeg(_sources(a), 1, 500, 300);
        assertTrue(peg.pegHealthy(), "exactly 300 bps under");
        a.set(true, 0.97e18 - 1);
        assertFalse(peg.pegHealthy());
        a.set(true, 1.03e18);
        assertTrue(peg.pegHealthy(), "exactly 300 bps over");
        a.set(true, 1.03e18 + 1);
        assertFalse(peg.pegHealthy());
        // Off peg is still a price: musdUsdWad reports it, only the health check refuses it.
        assertEq(peg.musdUsdWad(), 1.03e18 + 1);
    }

    function test_musdPeg_spread() public {
        MockPegSource a = new MockPegSource(0.98e18);
        MockPegSource b = new MockPegSource(1.02e18);
        MusdPeg peg = new MusdPeg(_sources(a, b), 2, 400, 300);
        // Median 1.00, spread 400 bps of it.
        assertTrue(peg.pegHealthy());
        b.set(true, 1.02e18 + 1);
        assertFalse(peg.pegHealthy(), "sources disagree");
        assertApproxEqAbs(peg.musdUsdWad(), 1e18, 1);
    }

    /// @dev Sources that revert, answer `ok` other than exactly true, answer the wrong length or a zero price only
    /// drop out; nothing a source does makes `pegHealthy` or `readings` revert.
    function test_musdPeg_toleratesMisbehavingSources() public {
        MockPegSource good = new MockPegSource(1e18);
        RawPegSource raw = new RawPegSource();
        MusdPeg peg = new MusdPeg(_sources(good, IPegSource(address(raw))), 1, 500, 300);

        raw.setAnswer(abi.encode(uint256(1), uint256(0.9e18)));
        assertEq(peg.musdUsdWad(), 0.95e18, "a well-formed answer counts");

        bytes[5] memory bad = [
            abi.encode(uint256(2), uint256(0.5e18)),
            abi.encode(uint256(1)),
            abi.encode(uint256(1), uint256(0.5e18), uint256(0)),
            abi.encode(uint256(1), uint256(0)),
            bytes("")
        ];
        for (uint256 i; i < bad.length; ++i) {
            raw.setAnswer(bad[i]);
            assertEq(peg.musdUsdWad(), 1e18);
            assertTrue(peg.pegHealthy());
            assertFalse(peg.readings()[1].ok);
        }
        raw.setReverts(true);
        assertEq(peg.musdUsdWad(), 1e18);
        assertTrue(peg.pegHealthy());

        // Extreme prices from a source neither overflow the median nor the checks.
        raw.setReverts(false);
        raw.setAnswer(abi.encode(uint256(1), type(uint256).max));
        good.set(true, type(uint256).max - 1);
        assertEq(peg.musdUsdWad(), type(uint256).max - 1);
        assertFalse(peg.pegHealthy());
    }

    /// @dev The median sits between the lowest and highest usable reading, and the checks never revert.
    function testFuzz_musdPeg_medianWithinReadings(uint256[5] memory prices, uint8 okMask) public {
        IPegSource[] memory list = new IPegSource[](5);
        uint256 low = type(uint256).max;
        uint256 high = 0;
        uint256 usable = 0;
        for (uint256 i; i < 5; ++i) {
            prices[i] = bound(prices[i], 1, 10e18);
            bool ok = (okMask >> i) & 1 == 1;
            MockPegSource s = new MockPegSource(prices[i]);
            s.set(ok, prices[i]);
            list[i] = s;
            if (ok) {
                ++usable;
                if (prices[i] < low) low = prices[i];
                if (prices[i] > high) high = prices[i];
            }
        }
        MusdPeg peg = new MusdPeg(list, 1, 500, 300);
        peg.pegHealthy();
        peg.readings();
        if (usable == 0) {
            vm.expectRevert(IMusdPeg.PegUnavailable.selector);
            peg.musdUsdWad();
            return;
        }
        uint256 median = peg.musdUsdWad();
        assertGe(median, low);
        assertLe(median, high);
    }

    /* Helpers */

    function _assertNotOk(IPegSource source) internal view {
        (bool ok, uint256 price) = source.read();
        assertFalse(ok);
        assertEq(price, 0);
    }

    /// @dev |a - b| <= b / tolerance.
    function _assertRel(uint256 a, uint256 b, uint256 tolerance) internal pure {
        uint256 diff = a > b ? a - b : b - a;
        assertLe(diff, b / tolerance);
    }

    function _sources(IPegSource a) internal pure returns (IPegSource[] memory r) {
        r = new IPegSource[](1);
        r[0] = a;
    }

    function _sources(IPegSource a, IPegSource b) internal pure returns (IPegSource[] memory r) {
        r = new IPegSource[](2);
        r[0] = a;
        r[1] = b;
    }

    function _sources(IPegSource a, IPegSource b, IPegSource c, IPegSource d)
        internal
        pure
        returns (IPegSource[] memory r)
    {
        r = new IPegSource[](4);
        r[0] = a;
        r[1] = b;
        r[2] = c;
        r[3] = d;
    }
}
