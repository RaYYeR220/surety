// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {console2} from "forge-std/console2.sol";
import {Test} from "forge-std/Test.sol";

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IPegSource} from "../../src/interfaces/IPegSource.sol";
import {IBasicPool, ICLPool} from "../../src/interfaces/ITigrisPools.sol";
import {TickPrice} from "../../src/libraries/TickPrice.sol";
import {BtcMusdPriceSource} from "../../src/oracles/BtcMusdPriceSource.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {BtcCrossPegSource} from "../../src/oracles/peg/BtcCrossPegSource.sol";
import {ClTwapPegSource} from "../../src/oracles/peg/ClTwapPegSource.sol";
import {MusdPeg} from "../../src/oracles/peg/MusdPeg.sol";
import {StableTwapPegSource} from "../../src/oracles/peg/StableTwapPegSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockBtcPrecompile} from "../mocks/MockBtcPrecompile.sol";

interface ISlipstreamPool {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata)
        external
        returns (int256 amount0, int256 amount1);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IVelodromePool {
    function token0() external view returns (address);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function sync() external;
}

/// @notice Plain swapper for Slipstream (Uniswap v3 callback) and Velodrome v2 basic pools.
contract Swapper {
    function swap(address pool, bool zeroForOne, int256 amountSpecified, uint160 limit)
        external
        returns (int256 a0, int256 a1)
    {
        return ISlipstreamPool(pool).swap(address(this), zeroForOne, amountSpecified, limit, abi.encode(pool));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "pool");
        if (a0 > 0) IERC20(ISlipstreamPool(pool).token0()).transfer(pool, uint256(a0));
        if (a1 > 0) IERC20(ISlipstreamPool(pool).token1()).transfer(pool, uint256(a1));
    }

    function sellBasic(address pool, address tokenIn, uint256 amountIn) external returns (uint256 out) {
        out = IVelodromePool(pool).getAmountOut(amountIn, tokenIn);
        IERC20(tokenIn).transfer(pool, amountIn);
        bool zeroIn = tokenIn == IVelodromePool(pool).token0();
        IVelodromePool(pool).swap(zeroIn ? 0 : out, zeroIn ? out : 0, address(this), "");
    }
}

/// @notice Regression for H-01 and M-01 of the v2 review, on Mezo mainnet state with real swaps on the real Tigris
/// pools and the mainnet peg configuration:
/// - CL sources: 30-minute window, floors 1e19 (CL mUSDC/MUSD) and 2e20 (CL BTC/MUSD);
/// - stable sources: granularity 2, maxAge 6 hours;
/// - MusdPeg: 2 of 4 sources, spread 1000 bps, band 300 bps; BtcMusdPriceSource: premium cap 300 bps.
/// At the fork block the sAMM MUSD/mUSDT pool's latest observation is 13.9 hours old, so that source is out unless a
/// test syncs the pool, as the keeper does.
/// Run: SURETY_FORK=true forge test --match-path test/audit/AuditV2Fork.t.sol -vv
contract AuditV2ForkTest is Test {
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant BTC = 0x7b7C000000000000000000000000000000000000;
    address internal constant MUSDC = 0x04671C72Aab5AC02A03c1098314b1BB6B560c197;
    address internal constant MUSDT = 0xeB5a5d39dE4Ea42C2Aa6A57EcA2894376683bB8E;
    address internal constant SKIP_BTC_USD = 0x7b7c000000000000000000000000000000000015;
    address internal constant CL_MUSDC_MUSD = 0xCC372B7E15535aB225fe17c1075831D38ef7aC1a;
    address internal constant CL_BTC_MUSD = 0x9CBc1537d255768b431488305b1C7EFc2ac95022;
    address internal constant SAMM_MUSDC_MUSD = 0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356;
    address internal constant SAMM_MUSD_MUSDT = 0x10906a9E9215939561597b4C8e4b98F93c02031A;
    uint256 internal constant PEG_BLOCK = 13_100_532;
    int256 internal constant BTC_USD = 75_387.77e18;

    SkipPriceSource internal skipSource;
    ClTwapPegSource internal clSource;
    StableTwapPegSource internal usdcSource;
    StableTwapPegSource internal usdtSource;
    BtcCrossPegSource internal crossSource;
    MusdPeg internal peg;
    BtcMusdPriceSource internal btcMusd;
    Swapper internal swapper;

    uint160 internal sqrtA;
    uint160 internal sqrtB;
    int256 internal musdOutA;
    int256 internal musdOutB;
    uint256 internal usdc0;
    uint256 internal usdt0;
    uint256 internal musd0;
    uint256 internal btc0;

    function setUp() public {
        if (!vm.envOr("SURETY_FORK", false)) {
            vm.skip(true);
            return;
        }
        try vm.createSelectFork(vm.envOr("SURETY_FORK_RPC", string("https://mezo.drpc.org")), PEG_BLOCK) {}
        catch {
            vm.skip(true);
            return;
        }
        // The BTC precompile as the ERC-20 view of native balances (the pool's native balance is its BTC).
        vm.etch(BTC, address(new MockBtcPrecompile()).code);
        vm.allowCheatcodes(BTC);
        vm.etch(SKIP_BTC_USD, address(new MockAggregator(1)).code);
        MockAggregator(SKIP_BTC_USD).setAnswer(BTC_USD);

        skipSource = new SkipPriceSource(IAggregatorV3(SKIP_BTC_USD), 60, 18);
        clSource = new ClTwapPegSource(ICLPool(CL_MUSDC_MUSD), MUSD, 30 minutes, 1e19);
        usdcSource = new StableTwapPegSource(IBasicPool(SAMM_MUSDC_MUSD), MUSD, 2, 6 hours);
        usdtSource = new StableTwapPegSource(IBasicPool(SAMM_MUSD_MUSDT), MUSD, 2, 6 hours);
        crossSource = new BtcCrossPegSource(ICLPool(CL_BTC_MUSD), MUSD, 30 minutes, 2e20, skipSource, 18);
        IPegSource[] memory sources = new IPegSource[](4);
        sources[0] = clSource;
        sources[1] = usdcSource;
        sources[2] = usdtSource;
        sources[3] = crossSource;
        peg = new MusdPeg(sources, 2, 1000, 300);
        btcMusd = new BtcMusdPriceSource(skipSource, peg, 300);
        swapper = new Swapper();

        address attacker = address(swapper);
        deal(MUSDC, attacker, 200_000e6);
        deal(MUSDT, attacker, 10_000e6);
        deal(MUSD, attacker, 30_000e18);
        vm.deal(attacker, 2e18); // BTC
        usdc0 = IERC20(MUSDC).balanceOf(attacker);
        usdt0 = IERC20(MUSDT).balanceOf(attacker);
        musd0 = IERC20(MUSD).balanceOf(attacker);
        btc0 = attacker.balance;
    }

    /// @dev H-01: both CL pools pushed through their thin MUSD side for a minute and swapped back. Before the fix the
    /// sources read ~1.94 each, the median 1.466 and BTC 31.8% under BTC/USD. Now both windows fail their liquidity
    /// floors, the sources drop out and BTC stays at BTC/USD, with or without the MUSD/mUSDT pool in the median.
    function test_H01_fork_pushedClPoolsNoLongerMoveTheBtcPrice() public {
        _log("before");
        uint256 btcBefore = btcMusd.priceWad();
        assertEq(btcBefore, uint256(BTC_USD), "honest median under $1: BTC at BTC/USD");

        // The reviewer's push: mean ticks about -6,700 lower after a 60-second hold (~16 Mezo blocks).
        _push(60, -6_720, -6_620);
        vm.warp(block.timestamp + 60);
        vm.roll(block.number + 15);
        _swapBack();
        _log("after the one-minute push and swap-back");

        // What the old sources read: the raw 30-minute mean ticks still price MUSD at ~$1.94 in both pools.
        assertGt(_rawClReading(), 1.9e18, "the push moved the CL mUSDC/MUSD mean tick");
        (bool ok,) = clSource.read();
        assertFalse(ok, "CL mUSDC/MUSD window below its floor");
        (ok,) = crossSource.read();
        assertFalse(ok, "CL BTC/MUSD window below its floor");
        (, uint256 liquidityA) = clSource.windowLiquidity();
        (, uint256 liquidityB) = crossSource.windowLiquidity();
        console2.log("window liquidity after the push: CL mUSDC/MUSD", liquidityA, "CL BTC/MUSD", liquidityB);
        assertLt(liquidityA, 1800);
        assertLt(liquidityB, 1800);

        // One fresh stable source left: the peg is unavailable and BTC is priced at BTC/USD.
        assertFalse(peg.pegHealthy());
        assertEq(btcMusd.priceWad(), btcBefore, "no BTC price cut");

        // With the keeper's sync, both stable sources count: healthy, median under $1, still BTC/USD.
        _sync(SAMM_MUSD_MUSDT);
        _log("after the keeper's sync of sAMM MUSD/mUSDT");
        assertTrue(peg.pegHealthy());
        assertLt(peg.musdUsdWad(), 1e18);
        assertEq(btcMusd.priceWad(), btcBefore, "no BTC price cut");
        _cost();

        // The sources come back on their own once the push has left the window.
        vm.warp(block.timestamp + 30 minutes);
        (ok,) = clSource.read();
        assertTrue(ok, "CL mUSDC/MUSD back after one window");
        (ok,) = crossSource.read();
        assertTrue(ok, "CL BTC/MUSD back after one window");
    }

    /// @dev M-01: the reviewer's one-minute push of CL mUSDC/MUSD used to read 1.0528 and trip the spread check for
    /// 30 minutes. Now the source drops out and the other sources keep the breaker open.
    function test_M01_fork_onePushedSourceNoLongerTripsTheBreaker() public {
        assertTrue(peg.pegHealthy());
        (sqrtA,,,,,) = ISlipstreamPool(CL_MUSDC_MUSD).slot0();
        int256 extA = int256(_tick(CL_MUSDC_MUSD)) - 600 * 1800 / 60;
        (, int256 a1) = swapper.swap(CL_MUSDC_MUSD, true, int256(200_000e6), _sqrtAt(extA));
        vm.warp(block.timestamp + 60);
        vm.roll(block.number + 15);
        swapper.swap(CL_MUSDC_MUSD, false, -a1 * 1001 / 1000, sqrtA);
        _log("after a one-minute 6% push of the CL mUSDC/MUSD pool");
        (bool ok,) = clSource.read();
        assertFalse(ok, "pushed source drops out");
        assertTrue(peg.pegHealthy(), "breaker stays open");
    }

    /// @dev The cheapest trip left without the keeper: push both CL pools out of range for one block (~4 s) while
    /// the MUSD/mUSDT pool is past its freshness bound. One stable source is left, under `minSources`, for one
    /// 30-minute window. With the keeper's sync the same push leaves two sources and the breaker open.
    function test_M01_fork_droppingBothClSourcesTripsOnlyWhileAStablePoolIsStale() public {
        // Out of every position, 20,000 ticks down; any tick past the positions does.
        _push(1800, -20_000, -20_000);
        vm.warp(block.timestamp + 4);
        vm.roll(block.number + 1);
        _swapBack();
        _log("after a one-block push of both CL pools");
        assertFalse(peg.pegHealthy(), "one stable source left");
        _cost();
        uint256 snap = vm.snapshotState();
        vm.warp(block.timestamp + 29 minutes);
        assertFalse(peg.pegHealthy(), "for the rest of the window");
        vm.warp(block.timestamp + 2 minutes);
        assertTrue(peg.pegHealthy(), "clears once the push has left the window");

        vm.revertToState(snap);
        _sync(SAMM_MUSD_MUSDT);
        assertTrue(peg.pegHealthy(), "with the keeper's sync two stable sources remain");
    }

    /// @dev With every source fresh (the keeper syncing), the cheapest trip is to make MUSD trade off its peg in
    /// both stable pools for two observation periods: about 900 MUSD sold into each moves them to ~$0.94, the median
    /// leaves the band and the breaker stays tripped until fresh periods replace the skewed ones. The round trip
    /// costs only the 0.02% fee, but the attacker's ~1,800 MUSD sits at a ~6% discount, open to any arbitrageur, for
    /// over an hour.
    function test_M01_fork_skewingBothStablePoolsForAnHourTripsTheBand() public {
        _sync(SAMM_MUSDC_MUSD);
        _sync(SAMM_MUSD_MUSDT);
        assertTrue(peg.pegHealthy());

        uint256 outA = swapper.sellBasic(SAMM_MUSDC_MUSD, MUSD, 900e18);
        uint256 outB = swapper.sellBasic(SAMM_MUSD_MUSDT, MUSD, 820e18);
        for (uint256 i; i < 2; ++i) {
            vm.warp(block.timestamp + 30 minutes + 1);
            vm.roll(block.number + 484);
            _sync(SAMM_MUSDC_MUSD);
            _sync(SAMM_MUSD_MUSDT);
        }
        _log("after holding both stable pools ~6% off for two periods");
        assertFalse(peg.pegHealthy(), "median out of the band");
        // MUSD below $1 never raises the BTC price.
        assertEq(btcMusd.priceWad(), uint256(BTC_USD));

        swapper.sellBasic(SAMM_MUSDC_MUSD, MUSDC, outA);
        swapper.sellBasic(SAMM_MUSD_MUSDT, MUSDT, outB);
        _cost();
        // Half the averaged periods are clean one period later.
        vm.warp(block.timestamp + 30 minutes + 1);
        vm.roll(block.number + 484);
        _sync(SAMM_MUSDC_MUSD);
        _sync(SAMM_MUSD_MUSDT);
        _log("one period after the swap-back");
        assertTrue(peg.pegHealthy(), "open again");
    }

    /* Helpers */

    function _push(uint256 hold, int256 shiftA, int256 shiftB) internal {
        (sqrtA,,,,,) = ISlipstreamPool(CL_MUSDC_MUSD).slot0();
        (sqrtB,,,,,) = ISlipstreamPool(CL_BTC_MUSD).slot0();
        int256 extA = int256(_tick(CL_MUSDC_MUSD)) + shiftA * 1800 / int256(hold);
        int256 extB = int256(_tick(CL_BTC_MUSD)) + shiftB * 1800 / int256(hold);
        (, int256 a1) = swapper.swap(CL_MUSDC_MUSD, true, int256(200_000e6), _sqrtAt(extA));
        musdOutA = -a1;
        (, a1) = swapper.swap(CL_BTC_MUSD, true, int256(2e18), _sqrtAt(extB));
        musdOutB = -a1;
        console2.log("MUSD bought out of CL mUSDC/MUSD", uint256(musdOutA), "and CL BTC/MUSD", uint256(musdOutB));
    }

    function _swapBack() internal {
        swapper.swap(CL_MUSDC_MUSD, false, musdOutA * 1001 / 1000, sqrtA);
        swapper.swap(CL_BTC_MUSD, false, musdOutB * 1004 / 1000, sqrtB);
    }

    function _sync(address pool) internal {
        IVelodromePool(pool).sync();
    }

    /// @dev sqrt(1.0001^tick) * 2^96, from TickPrice's 1.0001^n.
    function _sqrtAt(int256 tick) internal pure returns (uint160) {
        uint256 p = TickPrice.pow(uint256(tick >= 0 ? tick : -tick));
        uint256 x = tick >= 0 ? Math.mulDiv(p, 1 << 192, 1e36) : Math.mulDiv(1e36, 1 << 192, p);
        return uint160(Math.sqrt(x));
    }

    function _tick(address pool) internal view returns (int24 t) {
        (, t,,,,) = ISlipstreamPool(pool).slot0();
    }

    /// @dev MUSD in mUSDC from CL mUSDC/MUSD's raw 30-minute mean tick, as the sources read it before the floor.
    function _rawClReading() internal view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = 30 minutes;
        (int56[] memory c,) = ICLPool(CL_MUSDC_MUSD).observe(ago);
        return TickPrice.priceWad(-TickPrice.meanTick(c[0], c[1], 30 minutes), 18, 6);
    }

    function _log(string memory label) internal view {
        MusdPeg.Reading[] memory r = peg.readings();
        console2.log(label);
        for (uint256 i; i < r.length; ++i) {
            console2.log("  source", i, r[i].ok, r[i].musdUsdWad);
        }
        try peg.musdUsdWad() returns (uint256 median) {
            console2.log("  median", median, "healthy", peg.pegHealthy());
        } catch {
            console2.log("  median unavailable, healthy", peg.pegHealthy());
        }
        console2.log("  BTC in MUSD", btcMusd.priceWad(), "Skip BTC/USD", skipSource.priceWad());
    }

    /// @dev Net round trip in USD (MUSD at $0.99, the stablecoins at $1, BTC at BTC_USD), 18 decimals.
    function _cost() internal view returns (int256 costUsd) {
        address attacker = address(swapper);
        int256 dUsdc = int256(IERC20(MUSDC).balanceOf(attacker)) - int256(usdc0);
        int256 dUsdt = int256(IERC20(MUSDT).balanceOf(attacker)) - int256(usdt0);
        int256 dMusd = int256(IERC20(MUSD).balanceOf(attacker)) - int256(musd0);
        int256 dBtc = int256(attacker.balance) - int256(btc0);
        costUsd = -((dUsdc + dUsdt) * 1e12 + dMusd * 99 / 100 + dBtc * BTC_USD / 1e18);
        console2.log("  round-trip cost, USD (18 dp)");
        console2.logInt(costUsd);
    }
}
