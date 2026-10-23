// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/*
 * script/README: deploying Surety
 *
 *   forge script script/Deploy.s.sol --rpc-url mezo_testnet [--broadcast] [--verify]
 *   forge script script/Deploy.s.sol --rpc-url mezo_mainnet [--broadcast] [--verify]
 *
 * One run deploys and wires the whole system on Mezo testnet (31611) or mainnet (31612): VaultV2 (MUSD) with a
 * MorphoMarketV1AdapterV2, a BTC/MUSD Morpho market priced by our oracle, CreditVoter, VeBTCCreditLine (+ its
 * LinearKinkIrm and LoanEscrow implementation), VoteAllocator, SuretyPool and the vault's DepositGate. Then it puts
 * the Morpho adapter's own timelocks (burnShares, setSkimRecipient, abdicate, increaseTimelock) at VAULT_TIMELOCK
 * before the vault adds it, sets the vault's roles, caps, fees, penalties, receive-shares gate and max rate, lists
 * the BTC Morpho line (0) and the veBTC line (1) and ends the CreditVoter's bootstrap (later lines wait its
 * LINE_TIMELOCK, which is VAULT_TIMELOCK), checkpoints the Morpho line, raises the vault timelocks last (mainnet), and
 * writes `deployments/<chainId>.json` (the schema the SDK reads). Dry runs (no --broadcast) write
 * `deployments/dry-run/<chainId>.json` instead.
 *
 * The deployer key ends up as owner of every contract and as the vault's owner, curator and sentinel.
 *
 * Environment (all optional; defaults are per chain):
 *   DEPLOYER_KEY          private key to broadcast with; otherwise --sender / --account / the default sender
 *   STRESS                true: lines and the Morpho oracle price through StressedPriceSource, which anyone can
 *                         shock (testnet stress deployment). Refused on mainnet. Default false.
 *   EPOCH_LENGTH          seconds; 3600 testnet, 604800 mainnet (Mezo's Thursday flip)
 *   MUSD, BTC, VEBTC, POOLS_VOTER, REWARDS_DISTRIBUTOR, SKIP_AGGREGATOR
 *                         Mezo addresses; default to the known testnet / mainnet deployments
 *   MORPHO, MORPHO_IRM    Morpho Blue and AdaptiveCurveIrm; mainnet defaults to Mezo's. On testnet, unset means
 *                         deploy the pinned stack here first (as script/DeployMorphoStack.s.sol does)
 *   MORPHO_CAP, LINE_CAP  absolute caps (MUSD wei) on the Morpho ids (adapter, BTC, market) and the veBTC line ids
 *                         (adapter, veBTC); 10,000,000 MUSD testnet, 2,000 MUSD mainnet. Relative caps are 100%.
 *   AUCTION_DURATION      veBTC auction decay, seconds; 600 testnet, 21600 mainnet
 *   MIN_TERM              minimum lock time left to borrow, seconds; 3600 testnet, 259200 mainnet
 *   VAULT_TIMELOCK        seconds set on every timelockable curator function of the vault (after configuration)
 *                         and of the Morpho adapter (before the vault adds it), and the CreditVoter's line
 *                         timelock; 0 testnet, 86400 mainnet (the CreditVoter refuses 0 on mainnet)
 *   SIMULATE_PRECOMPILES  true: etch mock code over the Skip BTC/USD precompile (seeded with SKIP_PRICE, default
 *                         $81,350) so a dry run on a local fork can read it; a fork cannot execute Mezo's native
 *                         precompiles. Refused with --broadcast. Default false.
 *   DEPLOYMENT_OUT        output path override
 *
 * Dry run on a local fork (nothing is broadcast). SIMULATE_PRECOMPILES covers the script's own execution; forge then
 * replays the transactions against the RPC, so the anvil node needs the same stand-in:
 *   anvil --fork-url https://rpc.test.mezo.org --port 8545
 *   cast rpc anvil_setCode 0x7b7c000000000000000000000000000000000015 \
 *     $(forge inspect test/mocks/MockAggregator.sol:MockAggregator deployedBytecode) --rpc-url http://127.0.0.1:8545
 *   cast send 0x7b7c000000000000000000000000000000000015 "setAnswer(int256)" 81350000000000000000000 \
 *     --private-key <an anvil dev key> --rpc-url http://127.0.0.1:8545
 *   STRESS=true SIMULATE_PRECOMPILES=true forge script script/Deploy.s.sol --fork-url http://127.0.0.1:8545
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {console2} from "forge-std/Script.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";
import {VmSafe} from "forge-std/Vm.sol";

import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";

import {CreditVoter} from "../src/CreditVoter.sol";
import {DepositGate} from "../src/DepositGate.sol";
import {SuretyPool} from "../src/SuretyPool.sol";
import {VoteAllocator} from "../src/VoteAllocator.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {ICreditVoter} from "../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../src/interfaces/IEscrowRegistry.sol";
import {IPoolsVoter} from "../src/interfaces/IPoolsVoter.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IRewardsDistributor} from "../src/interfaces/IRewardsDistributor.sol";
import {IVeBTC} from "../src/interfaces/IVeBTC.sol";
import {LineIds} from "../src/libraries/LineIds.sol";
import {LinearKinkIrm} from "../src/lines/LinearKinkIrm.sol";
import {VeBTCCreditLine} from "../src/lines/VeBTCCreditLine.sol";
import {MorphoPriceOracle} from "../src/oracles/MorphoPriceOracle.sol";
import {SkipPriceSource} from "../src/oracles/SkipPriceSource.sol";
import {StressedPriceSource} from "../src/oracles/StressedPriceSource.sol";
import {MockAggregator} from "../test/mocks/MockAggregator.sol";
import {MorphoStackDeployer} from "./DeployMorphoStack.s.sol";

/// @notice Deploys and wires Surety on Mezo testnet or mainnet; see the README block above for the environment.
contract Deploy is MorphoStackDeployer {
    using MarketParamsLib for MarketParams;

    uint256 internal constant MEZO_TESTNET = 31611;

    uint256 internal constant ORACLE_MAX_AGE = 60;
    /// @dev Skip BTC/USD on Mezo reports 18 decimals; SkipPriceSource re-checks this on every read.
    uint8 internal constant SKIP_DECIMALS = 18;
    uint256 internal constant SEASON = 4;
    uint256 internal constant IDLE_BUFFER_BPS = 1000;
    uint256 internal constant VOTER_FEE = 0.1e18;
    uint256 internal constant FORCE_DEALLOCATE_PENALTY = 0.01e18;
    uint256 internal constant MORPHO_LINE = 0;

    address internal constant BTC_PRECOMPILE = 0x7b7C000000000000000000000000000000000000;
    address internal constant SKIP_BTC_USD = 0x7b7c000000000000000000000000000000000015;

    struct Config {
        bool mainnet;
        bool stress;
        bool simulatePrecompiles;
        uint256 epochLength;
        address musd;
        address btc;
        address veBTC;
        address poolsVoter;
        address rewardsDistributor;
        address skipAggregator;
        address morpho;
        address irm;
        uint256 morphoCap;
        uint256 lineCap;
        uint32 auctionDuration;
        uint32 minTerm;
        uint256 timelock;
    }

    struct Deployed {
        address deployer;
        uint256 startBlock;
        VaultV2 vault;
        MorphoMarketV1AdapterV2 morphoAdapter;
        SkipPriceSource skipSource;
        IPriceSource priceSource;
        MorphoPriceOracle morphoOracle;
        LinearKinkIrm irmLine;
        VeBTCCreditLine line;
        CreditVoter voter;
        VoteAllocator allocator;
        SuretyPool pool;
        DepositGate gate;
        MarketParams market;
    }

    function run() external {
        Config memory c = _config();
        Deployed memory d;
        if (c.simulatePrecompiles) _simulatePrecompiles();
        d.startBlock = block.number;

        d.deployer = _startBroadcast();
        if (c.morpho == address(0)) (c.morpho, c.irm) = _deployMorphoStack(d.deployer);
        _deployOracles(c, d);
        _deployCore(c, d);
        _configureVault(c, d);
        _wireSurety(d);
        if (c.timelock != 0) _raiseTimelocks(d.vault, c.timelock);
        vm.stopBroadcast();

        _writeDeployment(c, d);
        _log(c, d);
    }

    /* Configuration */

    function _config() internal view returns (Config memory c) {
        require(block.chainid == MEZO_TESTNET || block.chainid == MEZO_MAINNET, "Mezo testnet or mainnet only");
        c.mainnet = block.chainid == MEZO_MAINNET;
        c.stress = vm.envOr("STRESS", false);
        require(!(c.stress && c.mainnet), "STRESS is a testnet-only deployment");
        c.simulatePrecompiles = vm.envOr("SIMULATE_PRECOMPILES", false);
        require(
            !(c.simulatePrecompiles && vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)),
            "SIMULATE_PRECOMPILES is for dry runs"
        );

        c.epochLength = vm.envOr("EPOCH_LENGTH", c.mainnet ? uint256(1 weeks) : uint256(1 hours));
        c.musd = vm.envOr(
            "MUSD", c.mainnet ? 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186 : 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503
        );
        c.btc = vm.envOr("BTC", BTC_PRECOMPILE);
        c.veBTC = vm.envOr(
            "VEBTC", c.mainnet ? 0x3D4b1b884A7a1E59fE8589a3296EC8f8cBB6f279 : 0x38E35d92E6Bfc6787272A62345856B13eA12130a
        );
        c.poolsVoter = vm.envOr(
            "POOLS_VOTER",
            c.mainnet ? 0x48233cCC97B87Ba93bCA212cbEe48e3210211f03 : 0x263F1Fd5fB7F866881e1B6cD7d5d6c40Fd985F0D
        );
        c.rewardsDistributor = vm.envOr(
            "REWARDS_DISTRIBUTOR",
            c.mainnet ? 0xb58477e074265BdC7F7ca6100eD0f7De264F74A2 : 0x9050218f89F0b5b17df4a30Ba4Fc97C72E307442
        );
        c.skipAggregator = vm.envOr("SKIP_AGGREGATOR", SKIP_BTC_USD);
        c.morpho = vm.envOr("MORPHO", c.mainnet ? 0x565834cE7E40b8987BC20EbF83E2159467bDA311 : address(0));
        c.irm = vm.envOr("MORPHO_IRM", c.mainnet ? 0x3760Ebc636F912a4dB9540fdA4Dec09C25C6C1e7 : address(0));
        require((c.morpho == address(0)) == (c.irm == address(0)), "set MORPHO and MORPHO_IRM together");

        c.morphoCap = vm.envOr("MORPHO_CAP", c.mainnet ? uint256(2_000e18) : uint256(10_000_000e18));
        c.lineCap = vm.envOr("LINE_CAP", c.mainnet ? uint256(2_000e18) : uint256(10_000_000e18));
        c.auctionDuration = uint32(vm.envOr("AUCTION_DURATION", c.mainnet ? uint256(6 hours) : uint256(10 minutes)));
        c.minTerm = uint32(vm.envOr("MIN_TERM", c.mainnet ? uint256(3 days) : uint256(1 hours)));
        c.timelock = vm.envOr("VAULT_TIMELOCK", c.mainnet ? uint256(1 days) : uint256(0));

        require(IVeBTC(c.veBTC).token() == c.btc, "veBTC does not lock BTC");
    }

    /// @dev Dry runs on a local fork only: Mezo's Skip feed is a native precompile behind a stub that a fork cannot
    /// execute, so a settable aggregator stands in for it.
    function _simulatePrecompiles() internal {
        int256 price = int256(vm.envOr("SKIP_PRICE", uint256(81_350e18)));
        require(price > 0, "SKIP_PRICE");
        vm.etch(SKIP_BTC_USD, address(new MockAggregator(price)).code);
        MockAggregator(SKIP_BTC_USD).setAnswer(price);
        console2.log("SIMULATE_PRECOMPILES: Skip BTC/USD replaced by a mock for this dry run");
    }

    /* Deployment */

    function _deployOracles(Config memory c, Deployed memory d) internal {
        d.skipSource = new SkipPriceSource(IAggregatorV3(c.skipAggregator), ORACLE_MAX_AGE, SKIP_DECIMALS);
        d.priceSource = c.stress ? IPriceSource(address(new StressedPriceSource(d.skipSource))) : d.skipSource;
        d.morphoOracle = new MorphoPriceOracle(d.priceSource);
        d.market = MarketParams({
            loanToken: c.musd, collateralToken: c.btc, oracle: address(d.morphoOracle), irm: c.irm, lltv: MORPHO_LLTV
        });
        if (IMorpho(c.morpho).market(d.market.id()).lastUpdate == 0) IMorpho(c.morpho).createMarket(d.market);
    }

    function _deployCore(Config memory c, Deployed memory d) internal {
        d.vault = new VaultV2(d.deployer, c.musd);
        d.morphoAdapter = new MorphoMarketV1AdapterV2(address(d.vault), c.morpho, c.irm);
        d.irmLine = new LinearKinkIrm(0.02e18, 0.08e18, 0.6e18, 0.8e18);
        d.line = new VeBTCCreditLine(
            address(d.vault),
            IERC20(c.musd),
            IVeBTC(c.veBTC),
            IPoolsVoter(c.poolsVoter),
            IRewardsDistributor(c.rewardsDistributor),
            d.priceSource,
            d.irmLine,
            VeBTCCreditLine.Params({
                maxLtvTimedBps: 5000,
                maxLtvPermanentBps: 4000,
                liqLtvBps: 7000,
                liqFeeBps: 300,
                floorBps: 7000,
                auctionDuration: c.auctionDuration,
                minTerm: c.minTerm
            }),
            d.deployer
        );
        d.voter = new CreditVoter(
            IVeBTC(c.veBTC), c.epochLength, d.deployer, IVaultV2(address(d.vault)), address(d.morphoAdapter), c.timelock
        );
        d.allocator = new VoteAllocator(address(d.vault), d.voter, d.deployer, IDLE_BUFFER_BPS);
        d.pool = new SuretyPool(
            address(d.vault),
            d.voter,
            IERC20(c.musd),
            IMorpho(c.morpho),
            address(d.morphoAdapter),
            IEscrowRegistry(address(d.line)),
            d.deployer,
            SEASON
        );
        d.gate = new DepositGate(d.pool);
    }

    /// @dev Roles, adapters, caps, fees, penalties and the deposit gate. Timelocks are still 0, so each curator call
    /// is submitted and executed right away. The performance-fee recipient is set before the fee, which VaultV2
    /// requires. The Morpho adapter's timelocks are raised before the vault adds it, as its NatSpec requires.
    function _configureVault(Config memory c, Deployed memory d) internal {
        VaultV2 vault = d.vault;
        vault.setCurator(d.deployer);
        vault.setIsSentinel(d.deployer, true);
        vault.setName("Surety MUSD");
        vault.setSymbol("srMUSD");

        if (c.timelock != 0) _raiseAdapterTimelocks(d.morphoAdapter, c.timelock);
        _curate(vault, abi.encodeCall(IVaultV2.addAdapter, (address(d.morphoAdapter))));
        _curate(vault, abi.encodeCall(IVaultV2.addAdapter, (address(d.line))));
        _caps(vault, LineIds.adapterIdData(address(d.morphoAdapter)), c.morphoCap);
        _caps(vault, LineIds.collateralIdData(c.btc), c.morphoCap);
        _caps(vault, LineIds.marketParamsIdData(address(d.morphoAdapter), d.market), c.morphoCap);
        _caps(vault, LineIds.adapterIdData(address(d.line)), c.lineCap);
        _caps(vault, LineIds.collateralIdData(c.veBTC), c.lineCap);

        _curate(vault, abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(d.pool))));
        _curate(vault, abi.encodeCall(IVaultV2.setPerformanceFee, (VOTER_FEE)));
        _curate(
            vault,
            abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(d.morphoAdapter), FORCE_DEALLOCATE_PENALTY))
        );
        _curate(vault, abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(d.line), FORCE_DEALLOCATE_PENALTY)));
        // The VoteAllocator is the only allocator and no liquidity adapter is set.
        _curate(vault, abi.encodeCall(IVaultV2.setIsAllocator, (address(d.allocator), true)));
        // New shares wait while a loss is pending, uncovered or being re-recognised; withdrawals are never gated.
        _curate(vault, abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(d.gate))));
    }

    /// @dev Puts `duration` on the MorphoMarketV1AdapterV2 functions that could hurt depositors without the vault's
    /// timelocks: `burnShares` (writes the line off), `setSkimRecipient` and `abdicate`, then `increaseTimelock`
    /// itself, last so the earlier raises are not delayed by it. The adapter's `submit` takes the vault's curator.
    function _raiseAdapterTimelocks(MorphoMarketV1AdapterV2 adapter, uint256 duration) internal {
        bytes4[4] memory selectors = [
            IMorphoMarketV1AdapterV2.burnShares.selector,
            IMorphoMarketV1AdapterV2.setSkimRecipient.selector,
            IMorphoMarketV1AdapterV2.abdicate.selector,
            IMorphoMarketV1AdapterV2.increaseTimelock.selector
        ];
        for (uint256 i; i < selectors.length; ++i) {
            bytes memory data = abi.encodeCall(IMorphoMarketV1AdapterV2.increaseTimelock, (selectors[i], duration));
            adapter.submit(data);
            (bool ok, bytes memory ret) = address(adapter).call(data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }

    /// @dev Lines, cross-references, the vault's max rate, and the Morpho line's first loss checkpoint (losses before
    /// a line's first checkpoint are not recorded).
    function _wireSurety(Deployed memory d) internal {
        d.voter
            .addLine(
                address(d.morphoAdapter), abi.encode(d.market), ICreditVoter.LineKind.Morpho, "BTC / MUSD (Morpho)"
            );
        d.voter.addLine(address(d.line), "", ICreditVoter.LineKind.VeBTC, "veBTC credit line");
        // Lines listed from now on wait the CreditVoter's line timelock (the vault timelock, 1 day on mainnet).
        d.voter.endBootstrap();
        d.voter.setEscrowRegistry(IEscrowRegistry(address(d.line)));
        d.line.setSuretyPool(address(d.pool));
        d.pool.setAllocator(address(d.allocator));
        d.allocator.setSuretyPool(address(d.pool));
        d.allocator.setMaxRate(MAX_MAX_RATE);
        d.pool.checkpoint(MORPHO_LINE);
    }

    /// @dev Puts `duration` on every timelockable curator function. `increaseTimelock` goes last, so the earlier
    /// raises are not delayed by it; decreases are timelocked by the target function's own timelock.
    function _raiseTimelocks(VaultV2 vault, uint256 duration) internal {
        bytes4[] memory selectors = new bytes4[](17);
        selectors[0] = IVaultV2.addAdapter.selector;
        selectors[1] = IVaultV2.removeAdapter.selector;
        selectors[2] = IVaultV2.increaseAbsoluteCap.selector;
        selectors[3] = IVaultV2.increaseRelativeCap.selector;
        selectors[4] = IVaultV2.setIsAllocator.selector;
        selectors[5] = IVaultV2.setPerformanceFee.selector;
        selectors[6] = IVaultV2.setPerformanceFeeRecipient.selector;
        selectors[7] = IVaultV2.setManagementFee.selector;
        selectors[8] = IVaultV2.setManagementFeeRecipient.selector;
        selectors[9] = IVaultV2.setForceDeallocatePenalty.selector;
        selectors[10] = IVaultV2.setAdapterRegistry.selector;
        selectors[11] = IVaultV2.setReceiveSharesGate.selector;
        selectors[12] = IVaultV2.setSendSharesGate.selector;
        selectors[13] = IVaultV2.setReceiveAssetsGate.selector;
        selectors[14] = IVaultV2.setSendAssetsGate.selector;
        selectors[15] = IVaultV2.abdicate.selector;
        selectors[16] = IVaultV2.increaseTimelock.selector;
        for (uint256 i; i < selectors.length; ++i) {
            _curate(vault, abi.encodeCall(IVaultV2.increaseTimelock, (selectors[i], duration)));
        }
    }

    function _curate(VaultV2 vault, bytes memory data) internal {
        vault.submit(data);
        (bool ok, bytes memory ret) = address(vault).call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _caps(VaultV2 vault, bytes memory idData, uint256 absoluteCap) internal {
        _curate(vault, abi.encodeCall(IVaultV2.increaseAbsoluteCap, (idData, absoluteCap)));
        _curate(vault, abi.encodeCall(IVaultV2.increaseRelativeCap, (idData, 1e18)));
    }

    /* Output */

    function _writeDeployment(Config memory c, Deployed memory d) internal {
        string memory dir = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) ? "deployments/" : "deployments/dry-run/";
        string memory path = vm.envOr("DEPLOYMENT_OUT", string.concat(dir, vm.toString(block.chainid), ".json"));
        if (bytes(vm.envOr("DEPLOYMENT_OUT", string(""))).length == 0) vm.createDir(dir, true);
        vm.writeFile(path, _json(c, d));
        console2.log("Deployment written to", path);
    }

    function _json(Config memory c, Deployed memory d) internal view returns (string memory) {
        string memory head = string.concat(
            "{\n",
            _field("chainId", vm.toString(block.chainid), true),
            _field("epochLength", vm.toString(c.epochLength), true),
            _field("deployedAt", vm.toString(d.startBlock), true)
        );
        string memory body = string.concat(
            '  "contracts": {\n', _contractsJson(c, d), "  },\n", '  "external": {\n', _externalJson(c), "  },\n"
        );
        return string.concat(head, body, '  "lines": [\n', _linesJson(d), '  ],\n  "proof": {\n    "txs": []\n  }\n}\n');
    }

    function _contractsJson(Config memory c, Deployed memory d) internal view returns (string memory) {
        string memory vaultSide = string.concat(
            _addr("vault", address(d.vault), true),
            _addr("morphoAdapter", address(d.morphoAdapter), true),
            _addr("morpho", c.morpho, true),
            _addr("irm", c.irm, true)
        );
        string memory surety = string.concat(
            _addr("creditVoter", address(d.voter), true),
            _addr("voteAllocator", address(d.allocator), true),
            _addr("suretyPool", address(d.pool), true),
            _addr("depositGate", address(d.gate), true),
            _addr("veBTCLine", address(d.line), true)
        );
        address escrowImpl = d.line.escrowImplementation();
        string memory parts = string.concat(
            _addr("loanEscrowImpl", escrowImpl, true),
            _addr("irmLine", address(d.irmLine), true),
            _addr("priceSource", address(d.priceSource), true)
        );
        string memory oracles = string.concat(
            _addr("skipSource", address(d.skipSource), true), _addr("morphoOracle", address(d.morphoOracle), false)
        );
        return string.concat(vaultSide, surety, parts, oracles);
    }

    function _externalJson(Config memory c) internal pure returns (string memory) {
        return string.concat(
            _addr("musd", c.musd, true),
            _addr("btc", c.btc, true),
            _addr("veBTC", c.veBTC, true),
            _addr("poolsVoter", c.poolsVoter, true),
            _addr("rewardsDistributor", c.rewardsDistributor, true),
            _addr("skipAggregator", c.skipAggregator, false)
        );
    }

    function _linesJson(Deployed memory d) internal pure returns (string memory) {
        MarketParams memory m = d.market;
        string memory params = string.concat(
            '      "marketParams": {\n',
            _addrAt("        ", "loanToken", m.loanToken, true),
            _addrAt("        ", "collateralToken", m.collateralToken, true),
            _addrAt("        ", "oracle", m.oracle, true),
            _addrAt("        ", "irm", m.irm, true),
            '        "lltv": "',
            vm.toString(m.lltv),
            '"\n      }\n'
        );
        string memory morphoLine = string.concat(
            "    {\n",
            '      "id": 0,\n      "kind": "Morpho",\n      "name": "BTC / MUSD (Morpho)",\n',
            '      "adapter": "',
            vm.toString(address(d.morphoAdapter)),
            '",\n      "marketId": "',
            vm.toString(Id.unwrap(m.id())),
            '",\n',
            params,
            "    },\n"
        );
        return string.concat(
            morphoLine,
            "    {\n",
            '      "id": 1,\n      "kind": "VeBTC",\n      "name": "veBTC credit line",\n',
            '      "adapter": "',
            vm.toString(address(d.line)),
            '"\n    }\n'
        );
    }

    function _field(string memory key, string memory value, bool comma) internal pure returns (string memory) {
        return string.concat('  "', key, '": ', value, comma ? ",\n" : "\n");
    }

    function _addr(string memory key, address value, bool comma) internal pure returns (string memory) {
        return _addrAt("    ", key, value, comma);
    }

    function _addrAt(string memory indent, string memory key, address value, bool comma)
        internal
        pure
        returns (string memory)
    {
        return string.concat(indent, '"', key, '": "', vm.toString(value), comma ? '",\n' : '"\n');
    }

    function _log(Config memory c, Deployed memory d) internal pure {
        console2.log("chain        ", c.mainnet ? "Mezo mainnet" : "Mezo testnet");
        console2.log("stress oracle", c.stress);
        console2.log("deployer     ", d.deployer);
        console2.log("vault        ", address(d.vault));
        console2.log("morphoAdapter", address(d.morphoAdapter));
        console2.log("morpho       ", c.morpho);
        console2.log("creditVoter  ", address(d.voter));
        console2.log("voteAllocator", address(d.allocator));
        console2.log("suretyPool   ", address(d.pool));
        console2.log("depositGate  ", address(d.gate));
        console2.log("veBTCLine    ", address(d.line));
        console2.log("priceSource  ", address(d.priceSource));
    }
}
