// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IMorpho, Id, MarketParams, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {StressedPriceSource} from "../../src/oracles/StressedPriceSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockDistributor} from "../mocks/MockDistributor.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPoolsVoter} from "../mocks/MockPoolsVoter.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";

/// @notice Shared test world: mock MUSD/BTC/Skip feed/veBTC/PoolsVoter/distributor, and the real Morpho stack
/// (Morpho Blue + AdaptiveCurveIrm at the commits Mezo runs, VaultV2, MorphoMarketV1AdapterV2).
/// @dev
/// - `admin` is Morpho owner, vault owner, curator and (for now) allocator. Vault timelocks are 0, so curator
///   actions go through `_curate(abi.encodeCall(IVaultV2.fn, (...)))`, which submits and executes in one step.
/// - The vault has the Morpho adapter with absolute caps of MORPHO_CAP and relative caps of 100% on its three ids
///   (adapter, BTC collateral, market), and `maxRate = MAX_MAX_RATE` so interest is recognised.
///   No performance fee is set yet.
/// - The Morpho market prices BTC through `stressedSource`, so `_shock` can push positions underwater.
/// - VaultV2 accrues interest once per transaction (transient `firstTotalAssets`). Forge resets transient storage
///   between top-level calls of a test, so each call from a test behaves like its own transaction.
/// - The mock Skip feed reports `updatedAt = block.timestamp` unless pinned, so warps alone never make it stale.
/// - Surety contracts are deployed in `_deploySurety()`, called last in `setUp()`.
abstract contract SuretyFixture is Test {
    using MarketParamsLib for MarketParams;

    /// @dev Fri 2026-10-23 16:02:33 UTC, mid-way through Mezo's epoch that started Thu 2026-10-22.
    uint256 internal constant START_TIME = 1792771353;
    uint256 internal constant START_BLOCK = 12_705_315;
    uint256 internal constant BLOCK_TIME = 3;

    /// @dev $81,565.5831 with 18 decimals.
    int256 internal constant BTC_USD = 81565583100000000000000;
    uint256 internal constant ORACLE_MAX_AGE = 60;
    uint256 internal constant LLTV = 0.86e18;
    uint256 internal constant MORPHO_CAP = 1_000_000_000e18;
    /// @dev Voter fee taken as the VaultV2 performance fee; wired together with the SuretyPool.
    uint256 internal constant VOTER_FEE = 0.1e18;

    /// @dev Epoch length used by Surety contracts and `_warpEpochs`. Assign before `super.setUp()` to change it.
    uint256 internal EPOCH_LENGTH = 1 weeks;

    address internal admin;

    MockERC20 internal musd;
    MockERC20 internal btc;

    MockAggregator internal aggregator;
    SkipPriceSource internal skipSource;
    StressedPriceSource internal stressedSource;
    MorphoPriceOracle internal morphoOracle;

    IMorpho internal morpho;
    address internal irm;
    MarketParams internal btcMarket;
    Id internal btcMarketId;

    VaultV2 internal vault;
    MorphoMarketV1AdapterV2 internal morphoAdapter;

    MockVeBTC internal ve;
    MockPoolsVoter internal poolsVoter;
    MockDistributor internal distributor;

    function setUp() public virtual {
        vm.warp(START_TIME);
        vm.roll(START_BLOCK);
        admin = makeAddr("admin");

        _deployTokens();
        _deployOracles();
        _deployMorpho();
        _deployVault();
        _deployMezo();
        _deploySurety();
    }

    /* Deployment */

    function _deployTokens() internal {
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        btc = new MockERC20("Bitcoin", "BTC", 18);
        vm.label(address(musd), "MUSD");
        vm.label(address(btc), "BTC");
    }

    function _deployOracles() internal {
        aggregator = new MockAggregator(BTC_USD);
        skipSource = new SkipPriceSource(IAggregatorV3(address(aggregator)), ORACLE_MAX_AGE);
        stressedSource = new StressedPriceSource(skipSource);
        morphoOracle = new MorphoPriceOracle(stressedSource);
        vm.label(address(aggregator), "SkipAggregator");
        vm.label(address(stressedSource), "StressedPriceSource");
        vm.label(address(morphoOracle), "MorphoPriceOracle");
    }

    function _deployMorpho() internal {
        morpho = IMorpho(vm.deployCode("Morpho.sol:Morpho", abi.encode(admin)));
        irm = vm.deployCode("AdaptiveCurveIrm.sol:AdaptiveCurveIrm", abi.encode(address(morpho)));
        vm.label(address(morpho), "Morpho");
        vm.label(irm, "AdaptiveCurveIrm");

        vm.startPrank(admin);
        morpho.enableIrm(irm);
        morpho.enableLltv(LLTV);
        vm.stopPrank();

        btcMarket = MarketParams({
            loanToken: address(musd),
            collateralToken: address(btc),
            oracle: address(morphoOracle),
            irm: irm,
            lltv: LLTV
        });
        morpho.createMarket(btcMarket);
        btcMarketId = btcMarket.id();
    }

    function _deployVault() internal {
        vault = new VaultV2(admin, address(musd));
        morphoAdapter = new MorphoMarketV1AdapterV2(address(vault), address(morpho), irm);
        vm.label(address(vault), "VaultV2");
        vm.label(address(morphoAdapter), "MorphoMarketV1AdapterV2");

        vm.startPrank(admin);
        vault.setCurator(admin);
        vault.setName("Surety MUSD");
        vault.setSymbol("srMUSD");
        vm.stopPrank();

        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (admin, true)));
        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(morphoAdapter))));
        _setCaps(LineIds.adapterIdData(address(morphoAdapter)), MORPHO_CAP);
        _setCaps(LineIds.collateralIdData(address(btc)), MORPHO_CAP);
        _setCaps(LineIds.marketParamsIdData(address(morphoAdapter), btcMarket), MORPHO_CAP);

        vm.prank(admin);
        vault.setMaxRate(MAX_MAX_RATE);
    }

    function _deployMezo() internal {
        ve = new MockVeBTC(address(btc));
        poolsVoter = new MockPoolsVoter(ve);
        ve.setVoter(address(poolsVoter));
        distributor = new MockDistributor(ve);
        btc.mint(address(distributor), 1_000e18);
        vm.label(address(ve), "veBTC");
        vm.label(address(poolsVoter), "PoolsVoter");
        vm.label(address(distributor), "RewardsDistributor");
    }

    /// @dev Hook for the Surety contracts (CreditVoter, VeBTCCreditLine, VoteAllocator, SuretyPool) and their
    /// vault roles, caps and fee wiring. Empty until those contracts exist.
    function _deploySurety() internal virtual {}

    /* Vault administration */

    /// @notice Submits and immediately executes a timelocked VaultV2 curator call (timelocks are 0).
    function _curate(bytes memory data) internal {
        vm.startPrank(admin);
        vault.submit(data);
        (bool ok, bytes memory ret) = address(vault).call(data);
        vm.stopPrank();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @notice Sets the absolute cap of `idData` and a 100% relative cap (VaultV2 defaults both to 0).
    function _setCaps(bytes memory idData, uint256 absoluteCap) internal {
        _curate(abi.encodeCall(IVaultV2.increaseAbsoluteCap, (idData, absoluteCap)));
        _curate(abi.encodeCall(IVaultV2.increaseRelativeCap, (idData, 1e18)));
    }

    function _allocateMorpho(uint256 assets) internal {
        vm.prank(admin);
        vault.allocate(address(morphoAdapter), abi.encode(btcMarket), assets);
    }

    function _deallocateMorpho(uint256 assets) internal {
        vm.prank(admin);
        vault.deallocate(address(morphoAdapter), abi.encode(btcMarket), assets);
    }

    /* Actors */

    /// @notice Mints `amount` MUSD to `user` and deposits it into the vault for them.
    function _deposit(address user, uint256 amount) internal returns (uint256 shares) {
        musd.mint(user, amount);
        vm.startPrank(user);
        musd.approve(address(vault), amount);
        shares = vault.deposit(amount, user);
        vm.stopPrank();
    }

    /// @notice Mints `amount` BTC to `user` and locks it in veBTC for `duration` (end rounded down to weeks).
    function _lockVeBTC(address user, uint256 amount, uint256 duration) internal returns (uint256 tokenId) {
        btc.mint(user, amount);
        vm.startPrank(user);
        btc.approve(address(ve), amount);
        tokenId = ve.createLock(amount, duration);
        vm.stopPrank();
    }

    /// @notice Mints `amount` BTC to `user` and creates a permanent veBTC lock.
    function _lockPermanent(address user, uint256 amount) internal returns (uint256 tokenId) {
        tokenId = _lockVeBTC(user, amount, ve.MAXTIME());
        vm.prank(user);
        ve.lockPermanent(tokenId);
    }

    /// @notice Mints BTC collateral to `user`, supplies it to the BTC/MUSD market and borrows `assets` MUSD.
    function _borrowMorpho(address user, uint256 collateral, uint256 assets) internal {
        btc.mint(user, collateral);
        vm.startPrank(user);
        btc.approve(address(morpho), collateral);
        morpho.supplyCollateral(btcMarket, collateral, user, "");
        morpho.borrow(btcMarket, assets, 0, user, user);
        vm.stopPrank();
    }

    /// @notice Liquidates all of `user`'s collateral; any debt left over is socialised by Morpho as bad debt.
    function _liquidateMorpho(address liquidator, address user) internal returns (uint256 seized, uint256 repaid) {
        morpho.accrueInterest(btcMarket);
        Position memory p = morpho.position(btcMarketId, user);
        uint256 budget = morpho.market(btcMarketId).totalBorrowAssets + 1e18;
        musd.mint(liquidator, budget);
        vm.startPrank(liquidator);
        musd.approve(address(morpho), budget);
        (seized, repaid) = morpho.liquidate(btcMarket, user, p.collateral, 0, "");
        vm.stopPrank();
    }

    /// @notice Funds the PoolsVoter and makes `rewardContract` pay `amount` of `token` on the next claim.
    function _setVoterReward(address rewardContract, MockERC20 token, uint256 amount) internal {
        token.mint(address(poolsVoter), amount);
        poolsVoter.setReward(rewardContract, address(token), amount);
    }

    /* Time and prices */

    function _currentEpoch() internal view returns (uint256) {
        return EpochLib.start(vm.getBlockTimestamp(), EPOCH_LENGTH);
    }

    /// @notice Advances time by `n * EPOCH_LENGTH`, keeping the offset within the epoch.
    function _warpEpochs(uint256 n) internal {
        _warp(n * EPOCH_LENGTH);
    }

    /// @notice Advances time by `secs` and the block number accordingly (at least one block).
    function _warp(uint256 secs) internal {
        vm.warp(vm.getBlockTimestamp() + secs);
        vm.roll(vm.getBlockNumber() + 1 + secs / BLOCK_TIME);
    }

    /// @notice Haircuts the BTC price by `bps` for the maximum shock duration (2 hours).
    function _shock(uint16 bps) internal {
        stressedSource.shock(bps, stressedSource.MAX_SHOCK_DURATION());
    }
}
