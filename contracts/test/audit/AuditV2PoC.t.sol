// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {Test} from "forge-std/Test.sol";
import {MarketParams, Market} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {DepositGate} from "../../src/DepositGate.sol";

import {IPegSource} from "../../src/interfaces/IPegSource.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {MusdPeg} from "../../src/oracles/peg/MusdPeg.sol";
import {StableTwapPegSource} from "../../src/oracles/peg/StableTwapPegSource.sol";
import {MockBasicPool} from "../mocks/MockTigrisPools.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPegSource} from "../mocks/MockPegSource.sol";
import {LifecycleTest} from "../integration/Lifecycle.t.sol";
import {SuretyPoolTest} from "../unit/SuretyPool.t.sol";
import {LineFixture} from "../utils/LineFixture.sol";

/// @notice Regression for H-01 of the v2 review on the real line and a real Morpho market. The median the reviewer's
/// fork push reached on mainnet state (1.466) is no longer a price: an unhealthy peg divides by exactly $1. The most
/// a healthy peg can still do is divide by $1.03 (the premium cap), a 2.9% cut that leaves both positions healthy.
contract AuditV2LineTest is LineFixture {
    using MarketParamsLib for MarketParams;

    uint256 internal constant LIFTED_MEDIAN = 1.46638134931043302e18;
    uint256 internal constant HONEST_MEDIAN = 0.991342960850172252e18;
    /// @dev The most a healthy peg can divide by: $1 plus PEG_MAX_PREMIUM.
    uint256 internal constant EDGE_MEDIAN = 1.03e18;
    address internal attacker = makeAddr("attacker");

    function test_H01_liftedPegNoLongerAuctionsAHealthyLoan() public {
        pegSource.set(true, HONEST_MEDIAN);
        _fundLine(20_000e18);
        // 0.1 BTC (~8,156.56 MUSD) borrowed at 45%: 20 points under the 65% trigger.
        (uint256 loanId,) = _openTimed(borrower, 0.1e18, 3_670e18);
        (uint256 ltv, uint256 value) = line.healthOf(loanId);

        // The lifted median: the peg is unhealthy, so the line prices BTC at BTC/USD and nothing changes.
        pegSource.set(true, LIFTED_MEDIAN);
        assertFalse(peg.pegHealthy());
        (uint256 ltvLifted, uint256 valueLifted) = line.healthOf(loanId);
        assertEq(valueLifted, value);
        assertEq(ltvLifted, ltv);
        vm.prank(attacker);
        vm.expectRevert(VeBTCCreditLine.NotLiquidatable.selector);
        line.startAuction(loanId);

        // The worst a healthy peg can do: divide by $1.03. The loan reads 46.35%, still 18 points under the trigger;
        // only loans already above 63.1% could be pulled over it, and an instant bid then pays 97.1% of value.
        pegSource.set(true, EDGE_MEDIAN);
        assertTrue(peg.pegHealthy());
        (uint256 ltvEdge, uint256 valueEdge) = line.healthOf(loanId);
        assertApproxEqAbs(valueEdge, value * 1e18 / EDGE_MEDIAN, 1);
        assertLe(ltvEdge, ltv * 103 / 100 + 1);
        vm.prank(attacker);
        vm.expectRevert(VeBTCCreditLine.NotLiquidatable.selector);
        line.startAuction(loanId);
        assertEq(ve.ownerOf(line.loan(loanId).tokenId), line.loan(loanId).escrow);
    }

    function test_H01_liftedPegNoLongerLiquidatesMorphoPositions() public {
        pegSource.set(true, HONEST_MEDIAN);
        // Production wiring: the Morpho market's oracle reads BtcMusdPriceSource (lineSource).
        MorphoPriceOracle oracle = new MorphoPriceOracle(lineSource);
        MarketParams memory mp = MarketParams({
            loanToken: address(musd), collateralToken: address(btc), oracle: address(oracle), irm: irm, lltv: LLTV
        });
        morpho.createMarket(mp);

        musd.mint(lender, 10_000e18);
        vm.startPrank(lender);
        musd.approve(address(morpho), 10_000e18);
        morpho.supply(mp, 10_000e18, 0, lender, "");
        vm.stopPrank();

        // 0.1 BTC (~8,156.56 MUSD) at 75% LTV, 11 points under the 86% LLTV.
        btc.mint(morphoBorrower, 0.1e18);
        vm.startPrank(morphoBorrower);
        btc.approve(address(morpho), 0.1e18);
        morpho.supplyCollateral(mp, 0.1e18, morphoBorrower, "");
        morpho.borrow(mp, 6_117e18, 0, morphoBorrower, morphoBorrower);
        vm.stopPrank();

        musd.mint(liquidator, 10_000e18);
        vm.prank(liquidator);
        musd.approve(address(morpho), 10_000e18);
        // Lifted (unhealthy) and at the healthy edge alike, the position stays healthy (77.25% at the edge).
        uint256[2] memory medians = [LIFTED_MEDIAN, EDGE_MEDIAN];
        for (uint256 i; i < 2; ++i) {
            pegSource.set(true, medians[i]);
            vm.prank(liquidator);
            vm.expectRevert(bytes("position is healthy"));
            morpho.liquidate(mp, morphoBorrower, 0.1e18, 0, "");
        }
        Market memory m = morpho.market(mp.id());
        assertEq(m.totalSupplyAssets, 10_000e18, "no bad debt");
    }
}

/// @notice Regression for L-02 of the v2 review: two stable-pool sources whose pools have not observed for 13 hours
/// no longer hold the median inside the band while the fresh sources see a 4% depeg.
contract AuditV2PegTest is Test {
    function test_L02_staleStableSourcesNoLongerMaskAFourPercentDepeg() public {
        vm.warp(30 days);
        MockERC20 musd = new MockERC20("Mezo USD", "MUSD", 18);
        MockERC20 usdc = new MockERC20("mUSDC", "mUSDC", 6);
        MockERC20 usdt = new MockERC20("mUSDT", "mUSDT", 6);
        MockBasicPool usdcPool = new MockBasicPool(address(usdc), address(musd));
        usdcPool.setQuote(address(musd), 1e18, 991_246);
        MockBasicPool usdtPool = new MockBasicPool(address(musd), address(usdt));
        usdtPool.setQuote(address(musd), 1e18, 986_043);

        IPegSource[] memory s = new IPegSource[](4);
        s[0] = new MockPegSource(0.96e18); // CL mUSDC/MUSD 30-minute TWAP, fresh
        s[1] = new StableTwapPegSource(usdcPool, address(musd), 2, 6 hours);
        s[2] = new StableTwapPegSource(usdtPool, address(musd), 2, 6 hours);
        s[3] = new MockPegSource(0.96e18); // BTC cross, fresh
        MusdPeg peg = new MusdPeg(s, 2, 1000, 300);

        // Observed within the bound, the quiet pools still read and hold the median at 0.973.
        usdcPool.setLastObservationAt(block.timestamp - 3 hours);
        usdtPool.setLastObservationAt(block.timestamp - 5 hours);
        assertEq(peg.musdUsdWad(), 0.9730215e18);
        assertTrue(peg.pegHealthy());

        // 13 hours without an observation: both drop out, the median is the fresh 0.96 and the breaker trips.
        usdcPool.setLastObservationAt(block.timestamp - 13 hours);
        usdtPool.setLastObservationAt(block.timestamp - 13 hours);
        assertEq(peg.musdUsdWad(), 0.96e18);
        assertFalse(peg.pegHealthy());
    }
}

/// @notice Regression for M-02 of the v2 review: with the management fee to the treasury, VaultV2's first accrual of
/// a transaction asks the gate about the treasury. The gate now answers it without calling the pool, so the accrual
/// no longer recurses through `depositsPaused` while a cover is being re-recognised. The control rebuilds the v2 gate
/// (no treasury) on the same scene.
contract AuditV2GateTest is SuretyPoolTest {
    function _scene(address gateTreasury) internal {
        assertEq(vault.managementFeeRecipient(), treasury);
        assertEq(vault.managementFee(), MANAGEMENT_FEE);
        DepositGate g = new DepositGate(pool, gateTreasury);
        _curate(abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(g))));
        uint256 loanId = _sizingScene(VE_LINE);
        _takeLoss(VE_LINE, loanId);
        pool.cover(VE_LINE);
        assertGt(pool.coverUnrecognised(), 0, "cover awaiting re-recognition");
        _warp(1 hours);
    }

    function _try(bytes memory data, uint256 gas) internal returns (bool ok, uint256 used) {
        uint256 g0 = gasleft();
        (ok,) = address(vault).call{gas: gas}(data);
        used = g0 - gasleft();
    }

    function test_M02_firstAccrualAfterACoverStaysCheap() public {
        _scene(treasury);
        (bool ok, uint256 used) = _try(abi.encodeCall(IVaultV2.accrueInterest, ()), 30_000_000);
        console2.log("accrueInterest after a cover, gas", used);
        assertTrue(ok);
        assertLt(used, 300_000, "was 29.05M of 30M");
    }

    function test_M02_control_gateWithoutTheTreasuryBurnsTheGas() public {
        _scene(address(0));
        (, uint256 used) = _try(abi.encodeCall(IVaultV2.accrueInterest, ()), 30_000_000);
        console2.log("v2 gate: accrueInterest after a cover, gas", used);
        assertGt(used, 10_000_000);
    }

    function test_M02_redeemAfterACoverNeedsOrdinaryGas() public {
        _scene(treasury);
        uint256 shares = vault.balanceOf(lender) / 100;
        vm.prank(lender);
        (bool ok, uint256 used) =
            _try(abi.encodeWithSignature("redeem(uint256,address,address)", shares, lender, lender), 300_000);
        console2.log("redeem after a cover, gas", used);
        assertTrue(ok, "failed at 300k and 1M before");
    }
}

/// @notice M-02 on the integrated deployment, whose fixture now sets the production fees (performance fee to the
/// pool, management fee to the treasury) and the gate with both: after covers on both lines the keeper's rebalance,
/// as the block's first vault touch, fits well inside Mezo's 10M block gas limit (it ran out of gas before).
contract AuditV2GateLifecycleTest is LifecycleTest {
    function test_M02_rebalanceAfterCoverFitsTheBlock() public {
        _openBook();
        _flip();
        _flip();
        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        line.startAuction(loanId);
        _warp(AUCTION_DURATION);
        _shock(6000);
        _bid(bidder, loanId);
        vm.startPrank(keeper);
        pool.checkpoint(MORPHO_LINE);
        pool.checkpoint(VE_LINE);
        pool.cover(VE_LINE);
        pool.cover(MORPHO_LINE);
        vm.stopPrank();
        assertGt(pool.coverUnrecognised(), 0);
        _warpEpochs(1);

        uint256 g0 = gasleft();
        vm.prank(keeper);
        (bool ok,) = address(allocator).call{gas: 10_000_000}(abi.encodeWithSignature("rebalance()"));
        uint256 used = g0 - gasleft();
        console2.log("rebalance as the block's first vault touch, gas", used);
        assertTrue(ok, "out of gas at 10M before");
        assertLt(used, 2_000_000);
    }
}
