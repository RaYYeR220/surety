// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Position} from "morpho-blue/interfaces/IMorpho.sol";

import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {SuretyFixture} from "../utils/SuretyFixture.sol";

/// @notice Smoke tests for the shared fixture: real VaultV2 + MorphoMarketV1AdapterV2 + Morpho Blue + IRM.
contract FixtureTest is SuretyFixture {
    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    function test_fixture_idsMatchAdapterEncoding() public view {
        assertEq(LineIds.adapterId(address(morphoAdapter)), morphoAdapter.adapterId());
        assertEq(vault.absoluteCap(LineIds.adapterId(address(morphoAdapter))), MORPHO_CAP);
        assertEq(vault.absoluteCap(LineIds.collateralId(address(btc))), MORPHO_CAP);
        assertEq(vault.absoluteCap(LineIds.marketParamsId(address(morphoAdapter), btcMarket)), MORPHO_CAP);
        assertEq(vault.relativeCap(LineIds.marketParamsId(address(morphoAdapter), btcMarket)), 1e18);
        assertTrue(vault.isAdapter(address(morphoAdapter)));
        assertTrue(vault.isAllocator(admin));
        assertEq(vault.curator(), admin);
    }

    function test_deposit_mintsShares() public {
        uint256 shares = _deposit(lender, 1_000e18);

        assertGt(shares, 0);
        assertEq(vault.balanceOf(lender), shares);
        assertEq(vault.totalAssets(), 1_000e18);
        assertEq(musd.balanceOf(address(vault)), 1_000e18);
    }

    function test_allocate_intoMorphoMarketThroughAdapter() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(90_000e18);

        assertApproxEqAbs(morphoAdapter.realAssets(), 90_000e18, 1);
        assertEq(morpho.market(btcMarketId).totalSupplyAssets, 90_000e18);
        assertEq(musd.balanceOf(address(vault)), 10_000e18);
        assertApproxEqAbs(vault.allocation(LineIds.adapterId(address(morphoAdapter))), 90_000e18, 1);
        assertApproxEqAbs(vault.allocation(LineIds.marketParamsId(address(morphoAdapter), btcMarket)), 90_000e18, 1);
    }

    function test_borrower_suppliesBtcAndBorrowsMusd_interestAccrues() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(100_000e18);
        _borrowMorpho(borrower, 1e18, 65_000e18);

        Position memory p = morpho.position(btcMarketId, borrower);
        assertEq(p.collateral, 1e18);
        assertGt(p.borrowShares, 0);
        assertEq(musd.balanceOf(borrower), 65_000e18);

        _warp(30 days);
        assertGt(morphoAdapter.realAssets(), 100_000e18);
        assertGt(vault.totalAssets(), 100_000e18);
    }

    function test_morphoBorrow_revertsOnStaleOracle() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(100_000e18);
        btc.mint(borrower, 1e18);
        vm.startPrank(borrower);
        btc.approve(address(morpho), 1e18);
        morpho.supplyCollateral(btcMarket, 1e18, borrower, "");

        aggregator.setUpdatedAt(block.timestamp - ORACLE_MAX_AGE - 1);
        vm.expectRevert(IPriceSource.StalePrice.selector);
        morpho.borrow(btcMarket, 1_000e18, 0, borrower, borrower);
        vm.stopPrank();
    }

    function test_shock6000_liquidationLeavesBadDebt() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(100_000e18);
        _borrowMorpho(borrower, 1e18, 65_000e18);
        uint256 adapterBefore = morphoAdapter.realAssets();
        uint256 vaultBefore = vault.totalAssets();

        _shock(6000);
        (uint256 seized, uint256 repaid) = _liquidateMorpho(liquidator, borrower);

        Position memory p = morpho.position(btcMarketId, borrower);
        assertEq(seized, 1e18);
        assertEq(p.collateral, 0);
        assertEq(p.borrowShares, 0);
        assertEq(morpho.market(btcMarketId).totalBorrowAssets, 0);

        // 1 BTC at 40% of $81,565 is ~$32.6k against $65k of debt: about $33.7k is socialised.
        uint256 badDebt = 65_000e18 - repaid;
        assertGt(badDebt, 33_000e18);
        assertApproxEqAbs(adapterBefore - morphoAdapter.realAssets(), badDebt, 2);
        assertApproxEqAbs(vaultBefore - vault.totalAssets(), badDebt, 2);
    }

    function test_helpers_lockAndWarp() public {
        uint256 timed = _lockVeBTC(lender, 1e18, 28 days);
        uint256 permanent = _lockPermanent(lender, 2e18);

        IVeBTC.LockedBalance memory l = ve.locked(timed);
        assertEq(l.amount, 1e18);
        assertEq(l.end, (START_TIME + 28 days) / 1 weeks * 1 weeks);
        assertTrue(ve.locked(permanent).isPermanent);
        assertEq(ve.ownerOf(permanent), lender);

        uint256 epoch = _currentEpoch();
        assertEq(epoch, 1792627200);
        _warpEpochs(2);
        assertEq(_currentEpoch(), epoch + 2 * EPOCH_LENGTH);
        assertEq(vm.getBlockTimestamp(), START_TIME + 2 * EPOCH_LENGTH);
        assertEq(ve.votingPowerOfNFTAt(permanent, _currentEpoch()), 2e18);
        assertEq(ve.votingPowerOfNFTAt(timed, _currentEpoch()), 1e18 * (l.end - _currentEpoch()) / 28 days);
        // The feed tracks the block timestamp, so warps never make it stale by themselves.
        assertEq(skipSource.priceWad(), uint256(BTC_USD));
    }
}
