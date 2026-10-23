// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Test} from "forge-std/Test.sol";
import {IMorpho, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {SuretyPool} from "../../src/SuretyPool.sol";
import {VoteAllocator} from "../../src/VoteAllocator.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../../src/interfaces/IEscrowRegistry.sol";
import {IPoolsVoter} from "../../src/interfaces/IPoolsVoter.sol";
import {IRewardsDistributor} from "../../src/interfaces/IRewardsDistributor.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {LinearKinkIrm} from "../../src/lines/LinearKinkIrm.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Surety against live Mezo mainnet state: the real veBTC, MUSD, Morpho Blue and AdaptiveCurveIrm.
/// @dev Opt-in: runs only with `SURETY_FORK=true` (RPC from `SURETY_FORK_RPC`, else `https://mezo.drpc.org`, else
/// `mezo_mainnet` in foundry.toml); otherwise, or when no RPC answers, every test is skipped.
/// Mezo's BTC token and Skip BTC/USD feed are chain precompiles that a local fork cannot execute, so mock code is
/// etched at their addresses: an ERC-20 for BTC (balances start empty) and the settable aggregator for Skip, primed
/// with a recent BTC price. Everything else is the deployed bytecode and storage. The veBTC NFT used is picked at
/// run time from known live candidates (`SURETY_FORK_TOKEN` overrides): NORMAL, no grant manager, power at the
/// current epoch start, owned by an EOA, and a lock that outlives the line's minimum term.
contract LiveMezoTest is Test {
    using MarketParamsLib for MarketParams;

    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant BTC = 0x7b7C000000000000000000000000000000000000;
    address internal constant SKIP_BTC_USD = 0x7b7c000000000000000000000000000000000015;
    address internal constant VEBTC = 0x3D4b1b884A7a1E59fE8589a3296EC8f8cBB6f279;
    address internal constant POOLS_VOTER = 0x48233cCC97B87Ba93bCA212cbEe48e3210211f03;
    address internal constant REWARDS_DISTRIBUTOR = 0xb58477e074265BdC7F7ca6100eD0f7De264F74A2;
    address internal constant MORPHO = 0x565834cE7E40b8987BC20EbF83E2159467bDA311;
    address internal constant ADAPTIVE_CURVE_IRM = 0x3760Ebc636F912a4dB9540fdA4Dec09C25C6C1e7;
    uint256 internal constant LLTV = 0.86e18;
    uint256 internal constant EPOCH_LENGTH = 1 weeks;
    uint256 internal constant SEASON = 4;
    uint256 internal constant IDLE_BUFFER_BPS = 1000;
    uint256 internal constant BPS = 10_000;
    /// @dev BTC/USD read from the Skip feed on 2026-10-23 (block 12,712,942).
    int256 internal constant BTC_USD = 81_350.23247e18;
    uint256 internal constant DEPOSIT = 10_000e18;
    string internal constant FALLBACK_RPC = "https://mezo.drpc.org";

    IVeBTC internal ve = IVeBTC(VEBTC);
    IERC20 internal musd = IERC20(MUSD);
    IMorpho internal morpho = IMorpho(MORPHO);

    address internal admin = makeAddr("admin");
    address internal lender = makeAddr("lender");
    address internal btcBorrower = makeAddr("btcBorrower");
    address internal keeper = makeAddr("keeper");

    MarketParams internal market;
    VaultV2 internal vault;
    MorphoMarketV1AdapterV2 internal morphoAdapter;
    VeBTCCreditLine internal line;
    CreditVoter internal voter;
    VoteAllocator internal allocator;
    SuretyPool internal pool;

    uint256 internal tokenId;
    address internal tokenOwner;

    function setUp() public {
        if (!vm.envOr("SURETY_FORK", false) || !_fork()) {
            vm.skip(true);
            return;
        }
        _etchPrecompiles();
        tokenId = _pickToken();
        if (tokenId == 0) {
            vm.skip(true);
            return;
        }
        tokenOwner = ve.ownerOf(tokenId);
        _deploy();
    }

    /* Tests */

    /// @dev The live veBTC answers the reads Surety depends on, and Mezo's Morpho has the LLTV and IRM enabled.
    function test_fork_readsLiveVeBTCAndMorpho() public view {
        assertEq(ve.token(), BTC, "veBTC locks the BTC precompile");
        IVeBTC.LockedBalance memory lock = ve.locked(tokenId);
        assertGt(lock.amount, 0);
        assertTrue(lock.isPermanent || lock.end > block.timestamp);
        assertEq(uint8(ve.escrowType(tokenId)), uint8(IVeBTC.EscrowType.NORMAL));
        assertEq(ve.grantManager(tokenId), address(0));
        uint256 epoch = voter.currentEpoch();
        // Day 0 of unix time is a Thursday; with Sunday = 0 a Thursday is weekday 4.
        assertEq((epoch / 1 days + 4) % 7, 4, "weekly epochs flip on Thursdays like Mezo's");
        assertGt(ve.votingPowerOfNFTAt(tokenId, epoch), 0);
        assertTrue(ve.isApprovedOrOwner(tokenOwner, tokenId));

        assertTrue(_call(MORPHO, abi.encodeWithSignature("isLltvEnabled(uint256)", LLTV)));
        assertTrue(_call(MORPHO, abi.encodeWithSignature("isIrmEnabled(address)", ADAPTIVE_CURVE_IRM)));
        assertGt(morpho.market(market.id()).lastUpdate, 0, "our BTC/MUSD market exists on Mezo's Morpho");
        assertEq(line.ids()[1], LineIds.collateralId(VEBTC));
    }

    /// @dev Deposit real MUSD, vote with a real veBTC NFT, rebalance into Mezo's Morpho and our veBTC line, borrow on
    /// both, accrue for a day, rebalance again, repay the veBTC loan and get the NFT back.
    function test_fork_shortCycle() public {
        deal(MUSD, lender, DEPOSIT);
        vm.startPrank(lender);
        musd.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, lender);
        vm.stopPrank();

        uint256[] memory lineIds = new uint256[](2);
        uint256[] memory weights = new uint256[](2);
        lineIds[1] = 1;
        weights[0] = 5000;
        weights[1] = 5000;
        uint256 epoch = voter.currentEpoch();
        vm.prank(tokenOwner);
        voter.vote(tokenId, lineIds, weights);
        assertEq(voter.totalVotes(epoch), ve.votingPowerOfNFTAt(tokenId, epoch));

        // Bootstrap: no closed epoch has votes yet, so the live tally drives the first allocation.
        vm.prank(keeper);
        allocator.rebalance();
        uint256 half = DEPOSIT * (BPS - IDLE_BUFFER_BPS) / BPS / 2;
        assertApproxEqAbs(allocator.lineAssets(0), half, 2, "half to Mezo's Morpho");
        assertApproxEqAbs(allocator.lineAssets(1), half, 1, "half to the veBTC line");
        assertEq(morpho.market(market.id()).totalSupplyAssets, half);

        // A BTC borrower on Mezo's Morpho (BTC from the etched token).
        MockERC20(BTC).mint(btcBorrower, 0.1e18);
        vm.startPrank(btcBorrower);
        IERC20(BTC).approve(MORPHO, 0.1e18);
        morpho.supplyCollateral(market, 0.1e18, btcBorrower, "");
        morpho.borrow(market, 2_000e18, 0, btcBorrower, btcBorrower);
        vm.stopPrank();
        assertEq(musd.balanceOf(btcBorrower), 2_000e18);

        // The NFT's owner borrows against it through the veBTC line; the real NFT moves into a fresh escrow.
        uint256 amount = line.maxBorrow(tokenId) / 2;
        assertGt(amount, 0);
        vm.startPrank(tokenOwner);
        IERC721(VEBTC).approve(address(line), tokenId);
        uint256 loanId = line.open(tokenId, amount);
        vm.stopPrank();
        address escrow = line.loan(loanId).escrow;
        assertEq(ve.ownerOf(tokenId), escrow);
        assertTrue(line.isEscrow(escrow));

        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 28_800);
        uint256 morphoBefore = allocator.lineAssets(0);
        uint256 lineBefore = allocator.lineAssets(1);
        assertGt(morphoBefore, half, "Morpho interest");
        assertGt(lineBefore, half, "veBTC line interest");
        vm.prank(keeper);
        allocator.rebalance();
        (, uint256 pendingMorpho,) = allocator.ledger(0);
        (, uint256 pendingLine,) = allocator.ledger(1);
        assertGt(pendingMorpho, 0);
        assertGt(pendingLine, 0);
        assertGt(vault.totalAssets(), DEPOSIT);

        uint256 debt = line.debtOf(loanId);
        deal(MUSD, tokenOwner, debt);
        vm.startPrank(tokenOwner);
        musd.approve(address(line), debt);
        line.repay(loanId, debt);
        vm.stopPrank();
        assertEq(ve.ownerOf(tokenId), tokenOwner, "NFT back with its owner");
        assertEq(pool.checkpoint(0) + pool.checkpoint(1), 0, "no losses");
    }

    /* Setup */

    /// @dev Forks `SURETY_FORK_RPC` if set, else the dRPC endpoint, else foundry.toml's `mezo_mainnet`; at
    /// `SURETY_FORK_BLOCK` if set, else the latest block. dRPC goes first because the boar.network endpoint answers
    /// 504 to account lookups of addresses that do not exist yet, which every deployment in a fork makes.
    function _fork() internal returns (bool) {
        uint256 blockNumber = vm.envOr("SURETY_FORK_BLOCK", uint256(0));
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

    /// @dev Replaces the BTC and Skip precompiles with mock code; their storage at those addresses starts empty.
    function _etchPrecompiles() internal {
        vm.etch(BTC, address(new MockERC20("Bitcoin", "BTC", 18)).code);
        vm.etch(SKIP_BTC_USD, address(new MockAggregator(BTC_USD)).code);
        MockAggregator(SKIP_BTC_USD).setAnswer(BTC_USD);
        vm.label(BTC, "BTC (etched)");
        vm.label(SKIP_BTC_USD, "Skip BTC/USD (etched)");
        vm.label(VEBTC, "veBTC");
        vm.label(MUSD, "MUSD");
        vm.label(MORPHO, "Morpho");
    }

    /// @dev First usable NFT among `SURETY_FORK_TOKEN` and known live candidates; 0 if none.
    function _pickToken() internal view returns (uint256) {
        uint256[4] memory candidates = [vm.envOr("SURETY_FORK_TOKEN", uint256(0)), 5500, 5900, 10];
        uint256 epoch = block.timestamp - block.timestamp % EPOCH_LENGTH;
        for (uint256 i; i < candidates.length; ++i) {
            uint256 id = candidates[i];
            if (id == 0) continue;
            address owner = ve.ownerOf(id);
            if (owner == address(0) || owner.code.length != 0) continue;
            if (ve.escrowType(id) != IVeBTC.EscrowType.NORMAL || ve.grantManager(id) != address(0)) continue;
            IVeBTC.LockedBalance memory lock = ve.locked(id);
            if (lock.amount <= 0 || (!lock.isPermanent && lock.end < block.timestamp + 3 days + 1 days)) continue;
            if (ve.votingPowerOfNFTAt(id, epoch) == 0) continue;
            return id;
        }
        return 0;
    }

    /// @dev The mainnet wiring of Deploy.s.sol on Mezo's Morpho (timelocks left at 0).
    function _deploy() internal {
        SkipPriceSource source = new SkipPriceSource(IAggregatorV3(SKIP_BTC_USD), 60, 18);
        MorphoPriceOracle oracle = new MorphoPriceOracle(source);
        market = MarketParams({
            loanToken: MUSD, collateralToken: BTC, oracle: address(oracle), irm: ADAPTIVE_CURVE_IRM, lltv: LLTV
        });
        morpho.createMarket(market);

        vault = new VaultV2(admin, MUSD);
        morphoAdapter = new MorphoMarketV1AdapterV2(address(vault), MORPHO, ADAPTIVE_CURVE_IRM);
        LinearKinkIrm irm = new LinearKinkIrm(0.02e18, 0.08e18, 0.6e18, 0.8e18);
        line = new VeBTCCreditLine(
            address(vault),
            musd,
            ve,
            IPoolsVoter(POOLS_VOTER),
            IRewardsDistributor(REWARDS_DISTRIBUTOR),
            source,
            irm,
            VeBTCCreditLine.Params({
                maxLtvTimedBps: 5000,
                maxLtvPermanentBps: 4000,
                liqLtvBps: 7000,
                liqFeeBps: 300,
                floorBps: 7000,
                auctionDuration: 6 hours,
                minTerm: 3 days
            }),
            admin
        );
        voter = new CreditVoter(ve, EPOCH_LENGTH, admin);
        allocator = new VoteAllocator(address(vault), voter, admin, IDLE_BUFFER_BPS);
        pool = new SuretyPool(
            address(vault), voter, musd, morpho, address(morphoAdapter), IEscrowRegistry(address(line)), admin, SEASON
        );

        vm.startPrank(admin);
        vault.setCurator(admin);
        voter.addLine(address(morphoAdapter), abi.encode(market), ICreditVoter.LineKind.Morpho, "BTC / Morpho");
        voter.addLine(address(line), "", ICreditVoter.LineKind.VeBTC, "veBTC credit");
        voter.setEscrowRegistry(IEscrowRegistry(address(line)));
        line.setSuretyPool(address(pool));
        pool.setAllocator(address(allocator));
        allocator.setSuretyPool(address(pool));
        vm.stopPrank();

        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (address(allocator), true)));
        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(morphoAdapter))));
        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(line))));
        _caps(LineIds.adapterIdData(address(morphoAdapter)));
        _caps(LineIds.collateralIdData(BTC));
        _caps(LineIds.marketParamsIdData(address(morphoAdapter), market));
        _caps(LineIds.adapterIdData(address(line)));
        _caps(LineIds.collateralIdData(VEBTC));
        _curate(abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(pool))));
        _curate(abi.encodeCall(IVaultV2.setPerformanceFee, (0.1e18)));
        _curate(abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(morphoAdapter), 0.01e18)));
        _curate(abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(line), 0.01e18)));
        vm.prank(admin);
        allocator.setMaxRate(MAX_MAX_RATE);
        pool.checkpoint(0);
    }

    function _curate(bytes memory data) internal {
        vm.startPrank(admin);
        vault.submit(data);
        (bool ok,) = address(vault).call(data);
        vm.stopPrank();
        require(ok, "curator call failed");
    }

    function _caps(bytes memory idData) internal {
        _curate(abi.encodeCall(IVaultV2.increaseAbsoluteCap, (idData, 1_000_000e18)));
        _curate(abi.encodeCall(IVaultV2.increaseRelativeCap, (idData, 1e18)));
    }

    function _call(address target, bytes memory data) internal view returns (bool) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        return ok && abi.decode(ret, (bool));
    }
}
