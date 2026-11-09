// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {Test} from "forge-std/Test.sol";

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IPegSource} from "../../src/interfaces/IPegSource.sol";
import {IBasicPool, ICLPool} from "../../src/interfaces/ITigrisPools.sol";
import {BtcMusdPriceSource} from "../../src/oracles/BtcMusdPriceSource.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {BtcCrossPegSource} from "../../src/oracles/peg/BtcCrossPegSource.sol";
import {ClTwapPegSource} from "../../src/oracles/peg/ClTwapPegSource.sol";
import {MusdPeg} from "../../src/oracles/peg/MusdPeg.sol";
import {StableTwapPegSource} from "../../src/oracles/peg/StableTwapPegSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice The MUSD peg sources and MusdPeg reading Mezo mainnet's live pools, with the mainnet parameters.
/// @dev Opt-in like LiveMezo: runs only with `SURETY_FORK=true` (RPC from `SURETY_FORK_RPC`, else
/// `https://mezo.drpc.org`, else `mezo_mainnet` in foundry.toml); otherwise, or when no RPC answers, every test is
/// skipped. Forks `SURETY_FORK_BLOCK` if set, else block 13,100,532 (2026-11-09 03:20 UTC), whose pool readings were
/// cross-checked off-chain with 100-digit arithmetic. The Skip precompile cannot run on a fork, so a stand-in is
/// etched there answering `SURETY_FORK_BTC_USD`, else $75,387.77 (Skip at block 13,099,882, 11 minutes earlier); the
/// BTC precompile gets an ERC-20 stand-in, which only the decimals check reads.
contract LivePegTest is Test {
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant BTC = 0x7b7C000000000000000000000000000000000000;
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;
    address internal constant MUSDT = 0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E;
    address internal constant SKIP_BTC_USD = 0x7b7c000000000000000000000000000000000015;
    address internal constant CL_MUSDC_MUSD = 0xCC372B7E15535aB225fe17c1075831D38ef7aC1a;
    address internal constant CL_BTC_MUSD = 0x9CBc1537d255768b431488305b1C7EFc2ac95022;
    address internal constant SAMM_MUSDC_MUSD = 0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356;
    address internal constant SAMM_MUSD_MUSDT = 0x10906a9E9215939561597b4C8e4b98F93c02031A;
    string internal constant FALLBACK_RPC = "https://mezo.drpc.org";

    uint256 internal constant PEG_BLOCK = 13_100_532;
    int256 internal constant BTC_USD = 75_387.77e18;
    /// @dev Exact readings at PEG_BLOCK: CL mUSDC/MUSD mean tick 276410 over 30 minutes; the two stable pools'
    /// `quote(MUSD, 1e18, 2)`; CL BTC/MUSD mean tick 112285 against BTC_USD.
    uint256 internal constant CL_READING = 991439921700344504;
    uint256 internal constant USDC_POOL_READING = 0.991246e18;
    uint256 internal constant USDT_POOL_READING = 0.986043e18;
    uint256 internal constant CROSS_READING = 1002464759360299236;
    /// @dev Mainnet source parameters (see ClTwapPegSource, BtcCrossPegSource and StableTwapPegSource).
    uint128 internal constant CL_USDC_MIN_LIQUIDITY = 1e19;
    uint128 internal constant CL_BTC_MIN_LIQUIDITY = 2e20;
    uint32 internal constant STABLE_MAX_AGE = 6 hours;
    /// @dev Seconds since each stable pool's latest observation at PEG_BLOCK.
    uint256 internal constant USDC_POOL_AGE = 15_604;
    uint256 internal constant USDT_POOL_AGE = 50_000;

    SkipPriceSource internal skipSource;
    ClTwapPegSource internal clSource;
    StableTwapPegSource internal usdcSource;
    StableTwapPegSource internal usdtSource;
    BtcCrossPegSource internal crossSource;
    MusdPeg internal peg;

    function setUp() public {
        if (!vm.envOr("SURETY_FORK", false) || !_fork()) {
            vm.skip(true);
            return;
        }
        vm.etch(BTC, address(new MockERC20("Bitcoin", "BTC", 18)).code);
        vm.etch(SKIP_BTC_USD, address(new MockAggregator(1)).code);
        MockAggregator(SKIP_BTC_USD).setAnswer(vm.envOr("SURETY_FORK_BTC_USD", BTC_USD));

        skipSource = new SkipPriceSource(IAggregatorV3(SKIP_BTC_USD), 60, 18);
        clSource = new ClTwapPegSource(ICLPool(CL_MUSDC_MUSD), MUSD, 30 minutes, CL_USDC_MIN_LIQUIDITY);
        usdcSource = new StableTwapPegSource(IBasicPool(SAMM_MUSDC_MUSD), MUSD, 2, STABLE_MAX_AGE);
        usdtSource = new StableTwapPegSource(IBasicPool(SAMM_MUSD_MUSDT), MUSD, 2, STABLE_MAX_AGE);
        crossSource =
            new BtcCrossPegSource(ICLPool(CL_BTC_MUSD), MUSD, 30 minutes, CL_BTC_MIN_LIQUIDITY, skipSource, 18);
        IPegSource[] memory sources = new IPegSource[](4);
        sources[0] = clSource;
        sources[1] = usdcSource;
        sources[2] = usdtSource;
        sources[3] = crossSource;
        peg = new MusdPeg(sources, 2, 500, 300);
    }

    /// @dev The pools have the token order the sources were written for and answer the read interfaces: Slipstream's
    /// six-field `slot0` and `observe`, Velodrome v2's `stable` and `quote`.
    function test_fork_poolsAnswerTheReadInterfaces() public view {
        assertEq(ICLPool(CL_MUSDC_MUSD).token0(), MUSDC);
        assertEq(ICLPool(CL_MUSDC_MUSD).token1(), MUSD);
        assertEq(ICLPool(CL_BTC_MUSD).token0(), BTC);
        assertEq(ICLPool(CL_BTC_MUSD).token1(), MUSD);
        assertEq(IBasicPool(SAMM_MUSDC_MUSD).token0(), MUSDC);
        assertEq(IBasicPool(SAMM_MUSDC_MUSD).token1(), MUSD);
        assertEq(IBasicPool(SAMM_MUSD_MUSDT).token0(), MUSD);
        assertEq(IBasicPool(SAMM_MUSD_MUSDT).token1(), MUSDT);
        assertEq(MockERC20(MUSDC).decimals(), 6);
        assertEq(MockERC20(MUSDT).decimals(), 6);

        for (uint256 i; i < 2; ++i) {
            address pool = i == 0 ? CL_MUSDC_MUSD : CL_BTC_MUSD;
            (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("slot0()"));
            assertTrue(ok);
            assertEq(ret.length, 6 * 32, "Slipstream slot0 has six fields");
            assertGt(ICLPool(pool).liquidity(), 0);
            uint32[] memory ago = new uint32[](2);
            ago[0] = 1 days;
            (int56[] memory cumulatives,) = ICLPool(pool).observe(ago);
            assertEq(cumulatives.length, 2);
        }
        for (uint256 i; i < 2; ++i) {
            address pool = i == 0 ? SAMM_MUSDC_MUSD : SAMM_MUSD_MUSDT;
            (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("stable()"));
            assertTrue(ok && abi.decode(ret, (bool)), "a stable pool");
            assertGt(IBasicPool(pool).quote(MUSD, 1e18, 48), 0);
        }
    }

    /// @dev Every source reads its live pool near $1, except a stable pool whose latest observation is older than
    /// the freshness bound (MUSD/mUSDT at PEG_BLOCK, 13.9 hours); a permissionless `sync` brings it back.
    function test_fork_sourcesReadTheLivePools() public {
        IPegSource[4] memory sources = [IPegSource(clSource), usdcSource, usdtSource, crossSource];
        string[4] memory names = ["CL mUSDC/MUSD", "sAMM mUSDC/MUSD", "sAMM MUSD/mUSDT", "BTC cross"];
        for (uint256 i; i < 4; ++i) {
            if (_stale(sources[i])) {
                (bool stale,) = sources[i].read();
                assertFalse(stale, names[i]);
                _sync(address(StableTwapPegSource(address(sources[i])).pool()));
            }
            (bool ok, uint256 price) = sources[i].read();
            console2.log(names[i], ok, price);
            assertTrue(ok, names[i]);
            assertGe(price, 0.95e18, names[i]);
            assertLe(price, 1.05e18, names[i]);
        }
    }

    /// @dev The readings at PEG_BLOCK match the off-chain cross-checks, and both CL pools held far more than their
    /// floors in range over the window.
    function test_fork_readingsMatchTheCrossChecks() public {
        if (block.number != PEG_BLOCK || vm.envOr("SURETY_FORK_BTC_USD", BTC_USD) != BTC_USD) return;
        (, uint256 cl) = clSource.read();
        assertApproxEqAbs(cl, CL_READING, 1);
        (, uint256 usdc) = usdcSource.read();
        assertEq(usdc, USDC_POOL_READING);
        (, uint256 cross) = crossSource.read();
        assertApproxEqAbs(cross, CROSS_READING, 1);
        (, uint256 usdcAge) = usdcSource.lastObservationAge();
        assertEq(usdcAge, USDC_POOL_AGE);
        (, uint256 usdtAge) = usdtSource.lastObservationAge();
        assertEq(usdtAge, USDT_POOL_AGE);
        (bool ok, uint256 usdt) = new StableTwapPegSource(IBasicPool(SAMM_MUSD_MUSDT), MUSD, 2, 7 days).read();
        assertTrue(ok);
        assertEq(usdt, USDT_POOL_READING);

        (, uint256 clLiquidity) = clSource.windowLiquidity();
        (, uint256 crossLiquidity) = crossSource.windowLiquidity();
        console2.log("window liquidity CL mUSDC/MUSD", clLiquidity, "CL BTC/MUSD", crossLiquidity);
        assertGt(clLiquidity, 20 * uint256(CL_USDC_MIN_LIQUIDITY));
        assertGt(crossLiquidity, 20 * uint256(CL_BTC_MIN_LIQUIDITY));
    }

    /// @dev At PEG_BLOCK the MUSD/mUSDT pool is past the freshness bound, so the median is the middle of three: MUSD
    /// sits 86 bps under $1 with a 111 bps spread, so borrowing is open and BtcMusdPriceSource prices BTC at BTC/USD.
    function test_fork_pegAggregatesTheLiveReadings() public {
        MusdPeg.Reading[] memory r = peg.readings();
        assertEq(r.length, 4);
        uint256 median = peg.musdUsdWad();
        console2.log("median", median, "healthy", peg.pegHealthy());
        assertGe(median, 0.97e18);
        assertLe(median, 1.03e18);
        BtcMusdPriceSource btcMusd = new BtcMusdPriceSource(skipSource, peg, 300);
        uint256 divisor = median > 1.03e18 ? 1.03e18 : median;
        uint256 expected =
            peg.pegHealthy() && median > 1e18 ? skipSource.priceWad() * 1e18 / divisor : skipSource.priceWad();
        assertEq(btcMusd.priceWad(), expected);
        if (block.number != PEG_BLOCK || vm.envOr("SURETY_FORK_BTC_USD", BTC_USD) != BTC_USD) return;
        assertApproxEqAbs(median, CL_READING, 1);
        assertTrue(peg.pegHealthy());
    }

    /// @dev A source that disagrees by more than the spread trips the breaker even with the median in the band; a
    /// stale Skip only drops the cross source.
    function test_fork_breakerTripsWhenSourcesDisagree() public {
        uint256 btcInMusd = skipSource.priceWad() * 1e18 / _crossReading();
        // BTC/USD 10% above the pool's BTC price in MUSD: the cross source reads about $1.10.
        MockAggregator(SKIP_BTC_USD).setAnswer(int256(btcInMusd * 110 / 100));
        assertGe(_crossReading(), 1.09e18);
        assertFalse(peg.pegHealthy(), "sources disagree");

        MockAggregator(SKIP_BTC_USD).setUpdatedAt(block.timestamp - 61);
        (bool ok,) = crossSource.read();
        assertFalse(ok, "stale Skip");
        assertGt(peg.musdUsdWad(), 0);
        if (block.number == PEG_BLOCK) assertTrue(peg.pegHealthy(), "the two fresh stablecoin sources agree");
    }

    /// @dev The longest windows the deployment could pick still find history in every pool.
    function test_fork_longWindowsHaveHistory() public {
        (bool ok,) = new ClTwapPegSource(ICLPool(CL_MUSDC_MUSD), MUSD, 1 days, CL_USDC_MIN_LIQUIDITY).read();
        assertTrue(ok);
        (ok,) = new BtcCrossPegSource(ICLPool(CL_BTC_MUSD), MUSD, 1 days, CL_BTC_MIN_LIQUIDITY, skipSource, 18).read();
        assertTrue(ok);
        (ok,) = new StableTwapPegSource(IBasicPool(SAMM_MUSD_MUSDT), MUSD, 48, 7 days).read();
        assertTrue(ok);
    }

    /// @dev Whether `source` is a stable-pool source whose pool has not written an observation within its bound.
    function _stale(IPegSource source) internal view returns (bool) {
        if (source != usdcSource && source != usdtSource) return false;
        StableTwapPegSource stable = StableTwapPegSource(address(source));
        (, uint256 age) = stable.lastObservationAge();
        return age > stable.maxAge();
    }

    /// @dev `sync()` on a basic pool, which anyone (the keeper) can call: it writes an observation once the last is
    /// older than a period.
    function _sync(address pool) internal {
        (bool ok,) = pool.call(abi.encodeWithSignature("sync()"));
        assertTrue(ok, "sync");
    }

    function _crossReading() internal view returns (uint256 price) {
        (, price) = crossSource.read();
    }

    /// @dev As LiveMezo, but at PEG_BLOCK unless `SURETY_FORK_BLOCK` says otherwise (0 means the latest block).
    function _fork() internal returns (bool) {
        uint256 blockNumber = vm.envOr("SURETY_FORK_BLOCK", PEG_BLOCK);
        string[3] memory urls = [vm.envOr("SURETY_FORK_RPC", string("")), FALLBACK_RPC, vm.rpcUrl("mezo_mainnet")];
        for (uint256 i; i < urls.length; ++i) {
            if (bytes(urls[i]).length == 0) continue;
            if (blockNumber == 0) {
                try vm.createSelectFork(urls[i]) returns (uint256) {
                    return true;
                } catch {}
            } else {
                try vm.createSelectFork(urls[i], blockNumber) returns (uint256) {
                    return true;
                } catch {}
            }
        }
        return false;
    }
}
