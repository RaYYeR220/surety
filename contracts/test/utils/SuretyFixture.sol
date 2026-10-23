// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {IMorpho, Id, MarketParams, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {DepositGate} from "../../src/DepositGate.sol";
import {SuretyPool} from "../../src/SuretyPool.sol";
import {VoteAllocator} from "../../src/VoteAllocator.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../../src/interfaces/IEscrowRegistry.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {EpochLib} from "../../src/libraries/EpochLib.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {LinearKinkIrm} from "../../src/lines/LinearKinkIrm.sol";
import {LoanEscrow} from "../../src/lines/LoanEscrow.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {StressedPriceSource} from "../../src/oracles/StressedPriceSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockDistributor} from "../mocks/MockDistributor.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPoolsVoter} from "../mocks/MockPoolsVoter.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";

/// @notice Shared test world and the integrated Surety deployment.
/// @dev
/// - World: mock MUSD/BTC/Skip feed/veBTC/PoolsVoter/distributor, and the real Morpho stack (Morpho Blue +
///   AdaptiveCurveIrm at the commits Mezo runs, VaultV2, MorphoMarketV1AdapterV2). `admin` is Morpho owner, vault
///   owner and curator. Vault timelocks are 0, so curator actions go through
///   `_curate(abi.encodeCall(IVaultV2.fn, (...)))`, which submits and executes in one step.
/// - The vault has the Morpho adapter with absolute caps of MORPHO_CAP and relative caps of 100% on its three ids
///   (adapter, BTC collateral, market), and `maxRate = MAX_MAX_RATE` so interest is recognised.
/// - The Morpho market and the veBTC line price BTC through `stressedSource`, so `_shock` can push positions
///   underwater. The mock Skip feed reports `updatedAt = block.timestamp` unless pinned, so warps alone never make
///   it stale.
/// - `_deploySurety()` (last step of `setUp`) deploys and wires the whole system the way production does:
///   VeBTCCreditLine (adapter + caps), CreditVoter with lines MORPHO_LINE (BTC Morpho market) and VE_LINE (veBTC
///   line) and its bootstrap ended, the line as the voter's escrow registry, VoteAllocator as the vault's only
///   allocator (no liquidity adapter), SuretyPool as the performance-fee recipient with a 10% fee, force-deallocate
///   penalties on both adapters, the DepositGate as the vault's receive-shares gate, and the Morpho line's loss mark
///   set. Unit fixtures that assemble their own pieces override it; until
///   then `admin` is a vault allocator.
/// - VaultV2 accrues interest once per transaction (transient `firstTotalAssets`). Forge resets transient storage
///   between top-level calls of a test, so each call from a test behaves like its own transaction.
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
    uint256 internal constant LINE_CAP = 100_000_000e18;
    /// @dev Voter fee taken as the VaultV2 performance fee.
    uint256 internal constant VOTER_FEE = 0.1e18;
    /// @dev Penalty VaultV2 charges on a permissionless `forceDeallocate`, per adapter.
    uint256 internal constant FORCE_DEALLOCATE_PENALTY = 0.01e18;
    uint256 internal constant BPS = 10_000;

    uint256 internal constant MORPHO_LINE = 0;
    uint256 internal constant VE_LINE = 1;
    uint256 internal constant SEASON = 4;
    uint256 internal constant IDLE_BUFFER_BPS = 1000;
    /// @dev CreditVoter's timelock on lines listed after the bootstrap (the mainnet value).
    uint256 internal constant LINE_TIMELOCK = 1 days;

    uint16 internal constant MAX_LTV_TIMED = 5000;
    uint16 internal constant MAX_LTV_PERMANENT = 4000;
    uint16 internal constant LIQ_LTV = 7000;
    uint16 internal constant LIQ_FEE = 300;
    uint16 internal constant FLOOR = 7000;
    uint32 internal constant AUCTION_DURATION = 6 hours;
    uint32 internal constant MIN_TERM = 3 days;

    /// @dev Epoch length used by Surety contracts and `_warpEpochs`. Assign before `super.setUp()` to change it.
    uint256 internal EPOCH_LENGTH = 1 weeks;

    address internal admin;

    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal bidder = makeAddr("bidder");
    address internal keeper = makeAddr("keeper");
    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal liquidator = makeAddr("liquidator");
    address internal morphoBorrower = makeAddr("morphoBorrower");

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

    LinearKinkIrm internal lineIrm;
    VeBTCCreditLine internal line;
    CreditVoter internal voter;
    VoteAllocator internal allocator;
    SuretyPool internal pool;
    DepositGate internal gate;

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
        skipSource = new SkipPriceSource(IAggregatorV3(address(aggregator)), ORACLE_MAX_AGE, 18);
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
            loanToken: address(musd), collateralToken: address(btc), oracle: address(morphoOracle), irm: irm, lltv: LLTV
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

    /// @notice Deploys and wires the Surety contracts into one system; see the contract notes.
    function _deploySurety() internal virtual {
        _deployLine();
        voter = new CreditVoter(
            IVeBTC(address(ve)), EPOCH_LENGTH, admin, IVaultV2(address(vault)), address(morphoAdapter), LINE_TIMELOCK
        );
        allocator = new VoteAllocator(address(vault), voter, admin, IDLE_BUFFER_BPS);
        pool = new SuretyPool(
            address(vault),
            voter,
            IERC20(address(musd)),
            morpho,
            address(morphoAdapter),
            IEscrowRegistry(address(line)),
            admin,
            SEASON
        );
        vm.label(address(voter), "CreditVoter");
        vm.label(address(allocator), "VoteAllocator");
        vm.label(address(pool), "SuretyPool");

        vm.startPrank(admin);
        voter.addLine(address(morphoAdapter), abi.encode(btcMarket), ICreditVoter.LineKind.Morpho, "BTC / Morpho");
        voter.addLine(address(line), "", ICreditVoter.LineKind.VeBTC, "veBTC credit");
        // As the deployment does: lines listed later go through the CreditVoter's timelock.
        voter.endBootstrap();
        voter.setEscrowRegistry(IEscrowRegistry(address(line)));
        line.setSuretyPool(address(pool));
        pool.setAllocator(address(allocator));
        allocator.setSuretyPool(address(pool));
        vm.stopPrank();

        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (address(allocator), true)));
        // The recipient must be set before the fee (VaultV2 rejects a fee without a recipient).
        _curate(abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(pool))));
        _curate(abi.encodeCall(IVaultV2.setPerformanceFee, (VOTER_FEE)));
        _curate(abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(morphoAdapter), FORCE_DEALLOCATE_PENALTY)));
        _curate(abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(line), FORCE_DEALLOCATE_PENALTY)));
        vm.prank(admin);
        allocator.setMaxRate(MAX_MAX_RATE);

        // New shares wait while a loss is pending, uncovered or being re-recognised (the pool always receives).
        gate = new DepositGate(pool);
        vm.label(address(gate), "DepositGate");
        _curate(abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(gate))));

        // Losses before a Morpho line's first checkpoint are not recorded, so it is checkpointed when listed.
        pool.checkpoint(MORPHO_LINE);
        // The allocator is the vault's only allocator: its interest ledger reads any other move as interest or loss.
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (admin, false)));
    }

    function _lineParams() internal pure returns (VeBTCCreditLine.Params memory) {
        return VeBTCCreditLine.Params({
            maxLtvTimedBps: MAX_LTV_TIMED,
            maxLtvPermanentBps: MAX_LTV_PERMANENT,
            liqLtvBps: LIQ_LTV,
            liqFeeBps: LIQ_FEE,
            floorBps: FLOOR,
            auctionDuration: AUCTION_DURATION,
            minTerm: MIN_TERM
        });
    }

    /// @notice Deploys the VeBTCCreditLine (priced by `stressedSource`), adds it as a vault adapter and gives its two
    /// ids (adapter, veBTC collateral) LINE_CAP absolute caps and 100% relative caps.
    function _deployLine() internal {
        lineIrm = new LinearKinkIrm(0.02e18, 0.08e18, 0.6e18, 0.8e18);
        line = new VeBTCCreditLine(
            address(vault), musd, ve, poolsVoter, distributor, stressedSource, lineIrm, _lineParams(), admin
        );
        vm.label(address(line), "VeBTCCreditLine");
        vm.label(address(lineIrm), "LinearKinkIrm");

        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(line))));
        _setCaps(LineIds.adapterIdData(address(line)), LINE_CAP);
        _setCaps(LineIds.collateralIdData(address(ve)), LINE_CAP);
    }

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

    /// @dev Direct allocation by `admin`; only while `admin` is still a vault allocator (unit fixtures).
    function _allocateMorpho(uint256 assets) internal {
        vm.prank(admin);
        vault.allocate(address(morphoAdapter), abi.encode(btcMarket), assets);
    }

    /// @dev Direct deallocation by `admin`; only while `admin` is still a vault allocator (unit fixtures).
    function _deallocateMorpho(uint256 assets) internal {
        vm.prank(admin);
        vault.deallocate(address(morphoAdapter), abi.encode(btcMarket), assets);
    }

    /* Actors: lenders and Morpho borrowers */

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

    /// @notice `who` liquidates all of `user`'s collateral; any debt left over is socialised by Morpho as bad debt.
    function _liquidateMorpho(address who, address user) internal returns (uint256 seized, uint256 repaid) {
        morpho.accrueInterest(btcMarket);
        Position memory p = morpho.position(btcMarketId, user);
        uint256 budget = morpho.market(btcMarketId).totalBorrowAssets + 1e18;
        musd.mint(who, budget);
        vm.startPrank(who);
        musd.approve(address(morpho), budget);
        (seized, repaid) = morpho.liquidate(btcMarket, user, p.collateral, 0, "");
        vm.stopPrank();
    }

    /// @notice Funds the PoolsVoter and makes `rewardContract` pay `amount` of `token` on the next claim.
    function _setVoterReward(address rewardContract, MockERC20 token, uint256 amount) internal {
        token.mint(address(poolsVoter), amount);
        poolsVoter.setReward(rewardContract, address(token), amount);
    }

    /* Actors: veBTC line */

    /// @notice Approves the line for `tokenId` and opens a loan of `amount` as `user`.
    function _open(address user, uint256 tokenId, uint256 amount) internal returns (uint256 loanId) {
        vm.startPrank(user);
        ve.approve(address(line), tokenId);
        loanId = line.open(tokenId, amount);
        vm.stopPrank();
    }

    /// @notice Locks `btcAmount` for 28 days (end on the 4th Thursday) and borrows `amount` against it.
    function _openTimed(address user, uint256 btcAmount, uint256 amount)
        internal
        returns (uint256 loanId, uint256 tokenId)
    {
        tokenId = _lockVeBTC(user, btcAmount, 28 days);
        loanId = _open(user, tokenId, amount);
    }

    function _openPermanent(address user, uint256 btcAmount, uint256 amount)
        internal
        returns (uint256 loanId, uint256 tokenId)
    {
        tokenId = _lockPermanent(user, btcAmount);
        loanId = _open(user, tokenId, amount);
    }

    /// @notice Mints MUSD to `payer` and repays up to `amount` of `loanId`.
    function _repay(address payer, uint256 loanId, uint256 amount) internal returns (uint256 repaid) {
        uint256 debt = line.debtOf(loanId);
        uint256 budget = amount < debt ? amount : debt;
        musd.mint(payer, budget);
        vm.startPrank(payer);
        musd.approve(address(line), budget);
        repaid = line.repay(loanId, amount);
        vm.stopPrank();
    }

    /// @notice Mints the current auction price to `who` and bids exactly that.
    function _bid(address who, uint256 loanId) internal returns (uint256 price) {
        price = line.auctionPrice(loanId);
        musd.mint(who, price);
        vm.startPrank(who);
        musd.approve(address(line), price);
        line.bid(loanId, price);
        vm.stopPrank();
    }

    function _escrowOf(uint256 loanId) internal view returns (LoanEscrow) {
        return LoanEscrow(line.loan(loanId).escrow);
    }

    /// @notice MUSD value of `btcAmount` at the unshocked feed price.
    function _value(uint256 btcAmount) internal pure returns (uint256) {
        return btcAmount * uint256(BTC_USD) / 1e18;
    }

    function _makeStale() internal {
        aggregator.setUpdatedAt(vm.getBlockTimestamp() - ORACLE_MAX_AGE - 1);
    }

    /* Actors: voters, sponsors, keeper */

    /// @notice Mints `assets` MUSD to `who` and posts them as an incentive for `lineId` in the current epoch.
    function _post(address who, uint256 lineId, uint256 assets) internal returns (uint256 shares) {
        musd.mint(who, assets);
        vm.startPrank(who);
        musd.approve(address(pool), assets);
        shares = pool.postIncentive(lineId, assets);
        vm.stopPrank();
    }

    function _vote(address who, uint256 tokenId, uint256[] memory lineIds, uint256[] memory weights) internal {
        vm.prank(who);
        voter.vote(tokenId, lineIds, weights);
    }

    function _voteAll(address who, uint256 tokenId, uint256 lineId) internal {
        _vote(who, tokenId, _arr(lineId), _arr(BPS));
    }

    function _rebalance() internal {
        vm.prank(keeper);
        allocator.rebalance();
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

    /* Arrays */

    function _arr(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _arr(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _arr(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }
}
