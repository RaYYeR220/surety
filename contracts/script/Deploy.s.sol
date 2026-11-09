// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/*
 * script/README: deploying Surety
 *
 *   STRESS=true RELAYER_ADDRESS=0x… forge script script/Deploy.s.sol --rpc-url mezo_testnet [--broadcast] [--verify]
 *   forge script script/Deploy.s.sol --rpc-url mezo_mainnet [--broadcast] [--verify]
 *
 * One run deploys and wires the whole system on Mezo testnet (31611) or mainnet (31612), on Mezo's own Morpho Blue:
 * - Prices: SkipPriceSource (BTC/USD; behind StressedPriceSource with STRESS), the MUSD peg (MusdPeg over Mezo's
 *   pools on mainnet, over a StressedPegSource on testnet, which has no usable MUSD pool), BtcMusdPriceSource (BTC in
 *   MUSD through the peg), and MorphoPriceOracle reading BtcMusdPriceSource for a new BTC/MUSD Morpho market.
 * - Core: VaultV2 (MUSD) with a MorphoMarketV1AdapterV2, CreditVoter, VeBTCCreditLine (+ its LinearKinkIrm and
 *   LoanEscrow implementation; priced by BtcMusdPriceSource, gated by the peg, fees to the treasury), VoteAllocator,
 *   SuretyPool, the vault's DepositGate, the SavingsAdapter that parks idle MUSD in sMUSD, and ShareMarket.
 * - Testnet only: the Sponsor that hands new wallets a starter kit, funded from the deployer.
 * Then it puts the Morpho adapter's own timelocks (burnShares, setSkimRecipient, abdicate, increaseTimelock) at
 * VAULT_TIMELOCK before the vault adds it, sets the vault's roles, adapters, caps, fees, penalties and receive-shares
 * gate, makes the VoteAllocator the only allocator with savings as the liquidity adapter and the peg as its funding
 * gate, lists the BTC Morpho line (0) and the veBTC line (1), ends the CreditVoter's bootstrap (later lines wait its
 * LINE_TIMELOCK, which is VAULT_TIMELOCK), checkpoints the Morpho line, raises the vault timelocks last (mainnet), and
 * writes `deployments/<chainId>.json` (schema version 2, which the SDK reads). Dry runs (no --broadcast) write
 * `deployments/dry-run/<chainId>.json` instead.
 *
 * The deployer key ends up as owner of every contract and as the vault's owner, curator and sentinel. The treasury
 * (origination fees, the protocol part of liquidation fees, the vault's management fee, ShareMarket fees) defaults
 * to the deployer until a multisig takes it; it is fixed in the line and ShareMarket, and the vault's management-fee
 * recipient changes only through the vault timelock.
 *
 * Environment (all optional unless marked; defaults are per chain):
 *   DEPLOYER_KEY          private key to broadcast with; otherwise --sender / --account / the default sender
 *   STRESS                true: lines and the Morpho oracle price BTC through StressedPriceSource, which anyone can
 *                         shock (testnet stress deployment). Refused on mainnet. Default false.
 *   EPOCH_LENGTH          seconds; 3600 testnet, 604800 mainnet (Mezo's Thursday flip)
 *   MUSD, BTC, VEBTC, POOLS_VOTER, REWARDS_DISTRIBUTOR, SKIP_AGGREGATOR, SMUSD
 *                         Mezo addresses; default to the known testnet / mainnet deployments
 *   MORPHO, MORPHO_IRM    Mezo's Morpho Blue and the AdaptiveCurveIrm it enables, on each chain
 *   MORPHO_LLTV           LLTV of the new market, WAD; the one Mezo enables: 0.77e18 testnet, 0.86e18 mainnet
 *   MORPHO_CAP, LINE_CAP  absolute caps (MUSD wei) on the Morpho ids (adapter, BTC, market) and the veBTC line ids
 *                         (adapter, veBTC); 10,000,000 MUSD testnet, 2,000 MUSD mainnet. Relative caps are 100%.
 *   SAVINGS_CAP           absolute cap on the savings adapter, at least 1e27 (it takes every deposit, so it must
 *                         never bind); its relative cap is exactly 100%, as the VoteAllocator requires
 *   AUCTION_DURATION      veBTC auction decay, seconds; 600 testnet, 21600 mainnet
 *   MIN_TERM              minimum lock time left to borrow, seconds; 3600 testnet, 259200 mainnet
 *   VAULT_TIMELOCK        seconds set on every timelockable curator function of the vault (after configuration)
 *                         and of the Morpho adapter (before the vault adds it), and the CreditVoter's line
 *                         timelock; 0 testnet, 86400 mainnet (the CreditVoter refuses 0 on mainnet)
 *   TREASURY              fee recipient; default the deployer (placeholder for a multisig)
 *   PEG_MIN_SOURCES, PEG_MAX_SPREAD_BPS, PEG_BAND_BPS
 *                         MusdPeg thresholds; 1 / 1000 / 300 testnet, 2 / 1000 / 300 mainnet
 *   PEG_MAX_PREMIUM_BPS   largest MUSD premium over $1 BtcMusdPriceSource divides by; 300
 *   PEG_WINDOW, PEG_GRANULARITY, PEG_MAX_AGE
 *                         CL TWAP window (1800 s), basic-pool quote periods (2) and the oldest accepted basic-pool
 *                         observation (21600 s) of the mainnet sources
 *   PEG_CL_MIN_LIQUIDITY, PEG_BTC_MIN_LIQUIDITY
 *                         harmonic-mean in-range liquidity the CL mUSDC/MUSD (1e19) and CL BTC/MUSD (2e20) sources
 *                         need over the window (MusdPeg and the sources' notes give the measurements)
 *   PEG_CL_POOL, PEG_USDC_POOL, PEG_USDT_POOL, PEG_BTC_POOL
 *                         mainnet pools: CL mUSDC/MUSD, basic mUSDC/MUSD, basic MUSD/mUSDT, CL BTC/MUSD
 *   RELAYER_ADDRESS       testnet, required: the relayer allowed to hand out starter kits
 *   SPONSOR_BTC, SPONSOR_MUSD
 *                         testnet: what the deployer funds the Sponsor with; 0.006 BTC and 300 MUSD
 *   SIMULATE_PRECOMPILES  true: etch mock code over the Skip BTC/USD precompile (seeded with SKIP_PRICE, default
 *                         $81,350) so a run on a local fork can read it; a fork cannot execute Mezo's native
 *                         precompiles. Nothing in the deployment reads Skip, so a dry run against the live RPC does
 *                         not need it; it only gives the BTC-cross peg reading logged at the end a price. Refused
 *                         with --broadcast. Default false.
 *   DEPLOYMENT_OUT        output path override
 *
 * Dry run (nothing is broadcast; no key needed):
 *   STRESS=true RELAYER_ADDRESS=0x… forge script script/Deploy.s.sol --rpc-url mezo_testnet --sender <deployer>
 *   forge script script/Deploy.s.sol --rpc-url mezo_mainnet --sender <deployer>
 */

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {MorphoMarketV1AdapterV2} from "vault-v2/adapters/MorphoMarketV1AdapterV2.sol";
import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";

import {CreditVoter} from "../src/CreditVoter.sol";
import {DepositGate} from "../src/DepositGate.sol";
import {SavingsAdapter} from "../src/SavingsAdapter.sol";
import {ShareMarket} from "../src/ShareMarket.sol";
import {SuretyPool} from "../src/SuretyPool.sol";
import {VoteAllocator} from "../src/VoteAllocator.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {ICreditVoter} from "../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../src/interfaces/IEscrowRegistry.sol";
import {IMusdSavingsRate} from "../src/interfaces/IMusdSavingsRate.sol";
import {IPegSource} from "../src/interfaces/IPegSource.sol";
import {IPoolsVoter} from "../src/interfaces/IPoolsVoter.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";
import {IRewardsDistributor} from "../src/interfaces/IRewardsDistributor.sol";
import {IBasicPool, ICLPool} from "../src/interfaces/ITigrisPools.sol";
import {IVeBTC} from "../src/interfaces/IVeBTC.sol";
import {LineIds} from "../src/libraries/LineIds.sol";
import {LinearKinkIrm} from "../src/lines/LinearKinkIrm.sol";
import {VeBTCCreditLine} from "../src/lines/VeBTCCreditLine.sol";
import {BtcMusdPriceSource} from "../src/oracles/BtcMusdPriceSource.sol";
import {MorphoPriceOracle} from "../src/oracles/MorphoPriceOracle.sol";
import {SkipPriceSource} from "../src/oracles/SkipPriceSource.sol";
import {StressedPriceSource} from "../src/oracles/StressedPriceSource.sol";
import {BtcCrossPegSource} from "../src/oracles/peg/BtcCrossPegSource.sol";
import {ClTwapPegSource} from "../src/oracles/peg/ClTwapPegSource.sol";
import {MusdPeg} from "../src/oracles/peg/MusdPeg.sol";
import {StableTwapPegSource} from "../src/oracles/peg/StableTwapPegSource.sol";
import {StressedPegSource} from "../src/oracles/peg/StressedPegSource.sol";
import {IVeBTCLocks, Sponsor} from "../src/testnet/Sponsor.sol";
import {MockAggregator} from "../test/mocks/MockAggregator.sol";

/// @notice Deploys and wires Surety on Mezo testnet or mainnet; see the README block above for the environment.
contract Deploy is Script {
    using MarketParamsLib for MarketParams;
    using SafeERC20 for IERC20;

    uint256 public constant MEZO_TESTNET = 31611;
    uint256 public constant MEZO_MAINNET = 31612;
    /// @notice Version of the `deployments/<chainId>.json` schema this script writes.
    uint256 public constant SCHEMA_VERSION = 2;

    uint256 internal constant ORACLE_MAX_AGE = 60;
    /// @dev Skip BTC/USD on Mezo reports 18 decimals; SkipPriceSource re-checks this on every read.
    uint8 internal constant SKIP_DECIMALS = 18;
    /// @dev Mezo's BTC has 18 decimals. It is a precompile forge cannot execute locally, so BtcCrossPegSource takes
    /// them as an argument and checks them on every read.
    uint8 internal constant BTC_DECIMALS = 18;
    uint256 internal constant SEASON = 4;
    uint256 internal constant IDLE_BUFFER_BPS = 1000;
    uint256 internal constant MORPHO_LINE = 0;

    /* Fees */

    /// @notice Voter fee: VaultV2's performance fee, paid to the SuretyPool.
    uint256 public constant VOTER_FEE = 0.1e18;
    /// @notice Vault management fee to the treasury, 0.20% a year, in the unit VaultV2 takes: WAD of total assets
    /// per second. 0.002e18 / 31,536,000 s = 63,419,583 (rounded down from 63,419,583.97), i.e. 0.1999999969% a
    /// year.
    uint256 public constant MANAGEMENT_FEE = 0.002e18 / uint256(365 days);
    uint256 public constant FORCE_DEALLOCATE_PENALTY = 0.01e18;
    uint16 public constant SHARE_MARKET_FEE_BPS = 10;

    /* veBTC line */

    uint16 public constant MAX_LTV_TIMED_BPS = 5000;
    uint16 public constant MAX_LTV_PERMANENT_BPS = 4000;
    uint16 public constant LIQ_LTV_BPS = 6500;
    uint16 public constant LIQ_FEE_BPS = 300;
    uint16 public constant FLOOR_BPS = 8500;
    uint16 public constant ORIGINATION_FEE_BPS = 25;
    uint16 public constant PROTOCOL_SHARE_BPS = 2000;
    uint16 public constant KEEPER_SHARE_BPS = 5000;

    /* Testnet starter kit */

    uint256 public constant KIT_BTC_GAS = 0.00005e18;
    uint256 public constant KIT_LOCK = 0.001e18;
    uint256 public constant KIT_MUSD = 50e18;
    uint256 public constant KIT_LOCK_DURATION = 28 days;
    uint256 public constant KIT_DAILY_LIMIT = 100;

    address internal constant BTC_PRECOMPILE = 0x7b7C000000000000000000000000000000000000;
    address internal constant SKIP_BTC_USD = 0x7b7c000000000000000000000000000000000015;
    address internal constant MAINNET_MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;

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
        address smusd;
        address morpho;
        address irm;
        uint256 lltv;
        uint256 morphoCap;
        uint256 lineCap;
        uint256 savingsCap;
        uint32 auctionDuration;
        uint32 minTerm;
        uint256 timelock;
        /// @dev Zero: the deployer.
        address treasury;
        uint256 pegMinSources;
        uint256 pegMaxSpreadBps;
        uint256 pegBandBps;
        uint16 pegMaxPremiumBps;
        uint32 pegWindow;
        uint256 pegGranularity;
        uint32 pegMaxAge;
        uint128 pegClMinLiquidity;
        uint128 pegBtcMinLiquidity;
        address pegClPool;
        address pegUsdcPool;
        address pegUsdtPool;
        address pegBtcPool;
        address relayer;
        uint256 sponsorBtc;
        uint256 sponsorMusd;
    }

    /// @param kind "ClTwap", "StableTwap", "BtcCross" or "Stressed".
    /// @param pool The pool it reads; zero for a stressed source.
    /// @param param TWAP window (seconds) of CL sources, quote periods of basic-pool sources, zero otherwise.
    /// @param limit Liquidity floor of CL sources, oldest accepted observation (seconds) of basic-pool sources, zero
    /// otherwise.
    struct PegSourceInfo {
        string kind;
        IPegSource source;
        address pool;
        uint256 param;
        uint256 limit;
    }

    struct Deployed {
        address deployer;
        address treasury;
        uint256 startBlock;
        VaultV2 vault;
        MorphoMarketV1AdapterV2 morphoAdapter;
        SkipPriceSource skipSource;
        /// @dev BTC/USD that BtcMusdPriceSource divides: StressedPriceSource with STRESS, else `skipSource`.
        IPriceSource btcUsdSource;
        PegSourceInfo[] pegSources;
        StressedPegSource stressedPeg;
        MusdPeg peg;
        BtcMusdPriceSource btcMusd;
        MorphoPriceOracle morphoOracle;
        MarketParams market;
        LinearKinkIrm irmLine;
        VeBTCCreditLine line;
        CreditVoter voter;
        VoteAllocator allocator;
        SuretyPool pool;
        DepositGate gate;
        SavingsAdapter savings;
        ShareMarket shareMarket;
        Sponsor sponsor;
    }

    function run() external {
        Config memory c = config();
        if (c.simulatePrecompiles) _simulatePrecompiles();
        Deployed memory d = deploy(c);
        _writeDeployment(c, d);
        _log(c, d);
    }

    /* Configuration */

    /// @notice The configuration for the current chain: per-chain defaults, overridden by the environment.
    function config() public view returns (Config memory c) {
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
        _mezoAddresses(c);
        _morphoConfig(c);
        c.morphoCap = vm.envOr("MORPHO_CAP", c.mainnet ? uint256(2_000e18) : uint256(10_000_000e18));
        c.lineCap = vm.envOr("LINE_CAP", c.mainnet ? uint256(2_000e18) : uint256(10_000_000e18));
        c.savingsCap = vm.envOr("SAVINGS_CAP", uint256(1e27));
        c.auctionDuration = uint32(vm.envOr("AUCTION_DURATION", c.mainnet ? uint256(6 hours) : uint256(10 minutes)));
        c.minTerm = uint32(vm.envOr("MIN_TERM", c.mainnet ? uint256(3 days) : uint256(1 hours)));
        c.timelock = vm.envOr("VAULT_TIMELOCK", c.mainnet ? uint256(1 days) : uint256(0));
        c.treasury = vm.envOr("TREASURY", address(0));
        _pegConfig(c);
        c.relayer = vm.envOr("RELAYER_ADDRESS", address(0));
        c.sponsorBtc = vm.envOr("SPONSOR_BTC", uint256(0.006e18));
        c.sponsorMusd = vm.envOr("SPONSOR_MUSD", uint256(300e18));
    }

    function _mezoAddresses(Config memory c) internal view {
        c.musd = vm.envOr("MUSD", c.mainnet ? MAINNET_MUSD : 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503);
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
        c.smusd = vm.envOr(
            "SMUSD", c.mainnet ? 0xb4D498029af77680cD1eF828b967f010d06C51CC : 0x6f461c68B2c5492C0F5CCEc5a264d692aA7A8e16
        );
    }

    /// @dev Mezo's own Morpho Blue and AdaptiveCurveIrm on both chains; each enables a single LLTV.
    function _morphoConfig(Config memory c) internal view {
        c.morpho = vm.envOr(
            "MORPHO", c.mainnet ? 0x565834cE7E40b8987BC20EbF83E2159467bDA311 : 0xCe1da828cA15cb1FDAfa84C366A53C8106655a73
        );
        c.irm = vm.envOr(
            "MORPHO_IRM",
            c.mainnet ? 0x3760Ebc636F912a4dB9540fdA4Dec09C25C6C1e7 : 0x0c97Fe017628636649ff374aD499529F91167441
        );
        c.lltv = vm.envOr("MORPHO_LLTV", c.mainnet ? uint256(0.86e18) : uint256(0.77e18));
    }

    /// @dev Mainnet reads four of Mezo's pools (MusdPeg's notes explain the thresholds); testnet has no usable MUSD
    /// pool and reads a StressedPegSource alone.
    function _pegConfig(Config memory c) internal view {
        c.pegMinSources = vm.envOr("PEG_MIN_SOURCES", c.mainnet ? uint256(2) : uint256(1));
        c.pegMaxSpreadBps = vm.envOr("PEG_MAX_SPREAD_BPS", uint256(1000));
        c.pegBandBps = vm.envOr("PEG_BAND_BPS", uint256(300));
        c.pegMaxPremiumBps = uint16(vm.envOr("PEG_MAX_PREMIUM_BPS", uint256(300)));
        c.pegWindow = uint32(vm.envOr("PEG_WINDOW", uint256(30 minutes)));
        c.pegGranularity = vm.envOr("PEG_GRANULARITY", uint256(2));
        c.pegMaxAge = uint32(vm.envOr("PEG_MAX_AGE", uint256(6 hours)));
        c.pegClMinLiquidity = uint128(vm.envOr("PEG_CL_MIN_LIQUIDITY", uint256(1e19)));
        c.pegBtcMinLiquidity = uint128(vm.envOr("PEG_BTC_MIN_LIQUIDITY", uint256(2e20)));
        c.pegClPool = vm.envOr("PEG_CL_POOL", address(0xCC372B7E15535aB225fe17c1075831D38ef7aC1a));
        c.pegUsdcPool = vm.envOr("PEG_USDC_POOL", address(0xEd812AEc0Fecc8fD882Ac3eccC43f3aA80A6c356));
        c.pegUsdtPool = vm.envOr("PEG_USDT_POOL", address(0x10906a9E9215939561597b4C8e4b98F93c02031A));
        c.pegBtcPool = vm.envOr("PEG_BTC_POOL", address(0x9CBc1537d255768b431488305b1C7EFc2ac95022));
    }

    /// @dev Checks the configuration against the chain before anything is deployed. Mainnet never gets a stressed
    /// source or a Sponsor: those follow `c.mainnet`, which must match the chain.
    function _check(Config memory c) internal view {
        require(c.mainnet == (block.chainid == MEZO_MAINNET), "config is for another chain");
        require(!(c.stress && block.chainid == MEZO_MAINNET), "STRESS is a testnet-only deployment");
        require(IVeBTC(c.veBTC).token() == c.btc, "veBTC does not lock BTC");
        require(IMusdSavingsRate(c.smusd).yieldToken() == c.musd, "sMUSD does not pay MUSD");
        require(IMorpho(c.morpho).isIrmEnabled(c.irm), "MORPHO_IRM is not enabled on MORPHO");
        require(IMorpho(c.morpho).isLltvEnabled(c.lltv), "MORPHO_LLTV is not enabled on MORPHO");
        require(c.savingsCap >= 1e27, "SAVINGS_CAP below 1e27");
        if (!c.mainnet) require(c.relayer != address(0), "RELAYER_ADDRESS is required on testnet");
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

    /// @notice Deploys and wires everything for `c`, broadcasting from the deployer. Writes nothing to disk.
    function deploy(Config memory c) public returns (Deployed memory d) {
        _check(c);
        d.startBlock = block.number;
        d.deployer = _startBroadcast();
        d.treasury = c.treasury == address(0) ? d.deployer : c.treasury;
        _deployPegAndPrices(c, d);
        _deployMarket(c, d);
        _deployCore(c, d);
        _configureVault(c, d);
        _wireSurety(d);
        if (!c.mainnet) _deploySponsor(c, d);
        if (c.timelock != 0) _raiseTimelocks(d.vault, c.timelock);
        vm.stopBroadcast();
        _checkMainnet(d);
    }

    /// @dev Second line of defence behind `_check`: nothing on mainnet can be stressed or hand out kits.
    function _checkMainnet(Deployed memory d) internal view {
        if (block.chainid != MEZO_MAINNET) return;
        require(address(d.btcUsdSource) == address(d.skipSource), "stressed price source on mainnet");
        require(address(d.stressedPeg) == address(0), "stressed peg source on mainnet");
        for (uint256 i; i < d.pegSources.length; ++i) {
            require(keccak256(bytes(d.pegSources[i].kind)) != keccak256("Stressed"), "stressed peg source on mainnet");
        }
        require(address(d.sponsor) == address(0), "Sponsor on mainnet");
    }

    /// @dev Starts broadcasting with `DEPLOYER_KEY` if set, else with the `--sender` / default account.
    function _startBroadcast() internal returns (address deployer) {
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        if (key != 0) {
            vm.startBroadcast(key);
            return vm.addr(key);
        }
        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
    }

    /// @dev Every price contract, in one place: Skip BTC/USD (behind StressedPriceSource on a STRESS deployment),
    /// the MUSD peg sources and MusdPeg over them, BtcMusdPriceSource (BTC in MUSD through the peg, the peg's premium
    /// capped at `pegMaxPremiumBps`) and the Morpho oracle over that.
    /// - Mainnet: CL mUSDC/MUSD (liquidity floor), basic mUSDC/MUSD and basic MUSD/mUSDT (freshness limit), then
    ///   BTC/USD over CL BTC/MUSD (liquidity floor). The cross source reads the plain Skip source; mainnet never runs
    ///   a stressed one. The keeper syncs the basic pools so their observations stay fresh.
    /// - Testnet: a StressedPegSource without a base, a fixed $1 that anyone can push off the peg (or take offline)
    ///   for up to two hours.
    function _deployPegAndPrices(Config memory c, Deployed memory d) internal {
        d.skipSource = new SkipPriceSource(IAggregatorV3(c.skipAggregator), ORACLE_MAX_AGE, SKIP_DECIMALS);
        d.btcUsdSource = c.stress ? IPriceSource(address(new StressedPriceSource(d.skipSource))) : d.skipSource;

        if (c.mainnet) {
            d.pegSources = new PegSourceInfo[](4);
            d.pegSources[0] = PegSourceInfo({
                kind: "ClTwap",
                source: new ClTwapPegSource(ICLPool(c.pegClPool), c.musd, c.pegWindow, c.pegClMinLiquidity),
                pool: c.pegClPool,
                param: c.pegWindow,
                limit: c.pegClMinLiquidity
            });
            d.pegSources[1] = PegSourceInfo({
                kind: "StableTwap",
                source: new StableTwapPegSource(IBasicPool(c.pegUsdcPool), c.musd, c.pegGranularity, c.pegMaxAge),
                pool: c.pegUsdcPool,
                param: c.pegGranularity,
                limit: c.pegMaxAge
            });
            d.pegSources[2] = PegSourceInfo({
                kind: "StableTwap",
                source: new StableTwapPegSource(IBasicPool(c.pegUsdtPool), c.musd, c.pegGranularity, c.pegMaxAge),
                pool: c.pegUsdtPool,
                param: c.pegGranularity,
                limit: c.pegMaxAge
            });
            d.pegSources[3] = PegSourceInfo({
                kind: "BtcCross",
                source: new BtcCrossPegSource(
                    ICLPool(c.pegBtcPool), c.musd, c.pegWindow, c.pegBtcMinLiquidity, d.skipSource, BTC_DECIMALS
                ),
                pool: c.pegBtcPool,
                param: c.pegWindow,
                limit: c.pegBtcMinLiquidity
            });
        } else {
            d.stressedPeg = new StressedPegSource(IPegSource(address(0)));
            d.pegSources = new PegSourceInfo[](1);
            d.pegSources[0] =
                PegSourceInfo({kind: "Stressed", source: d.stressedPeg, pool: address(0), param: 0, limit: 0});
        }

        IPegSource[] memory sources = new IPegSource[](d.pegSources.length);
        for (uint256 i; i < sources.length; ++i) {
            sources[i] = d.pegSources[i].source;
        }
        d.peg = new MusdPeg(sources, c.pegMinSources, c.pegMaxSpreadBps, c.pegBandBps);
        d.btcMusd = new BtcMusdPriceSource(d.btcUsdSource, d.peg, c.pegMaxPremiumBps);
        d.morphoOracle = new MorphoPriceOracle(d.btcMusd);
    }

    /// @dev A new BTC/MUSD market on Mezo's Morpho Blue: its oracle is new, so its id is too, and it is checked
    /// against the previous deployment's market. A market with the same parameters is reused if someone created it
    /// first.
    function _deployMarket(Config memory c, Deployed memory d) internal {
        d.market = MarketParams({
            loanToken: c.musd, collateralToken: c.btc, oracle: address(d.morphoOracle), irm: c.irm, lltv: c.lltv
        });
        bytes32 id = Id.unwrap(d.market.id());
        string memory previous = string.concat("deployments/v1/", vm.toString(block.chainid), ".json");
        if (vm.exists(previous)) {
            require(id != vm.parseJsonBytes32(vm.readFile(previous), ".lines[0].marketId"), "v1 market id");
        }
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
            d.btcMusd,
            d.peg,
            d.irmLine,
            lineParams(c),
            d.treasury,
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
        // The treasury is the management-fee recipient: the gate answers it without asking the pool.
        d.gate = new DepositGate(d.pool, d.treasury);
        d.savings = new SavingsAdapter(address(d.vault), IMusdSavingsRate(c.smusd));
        d.shareMarket = new ShareMarket(IVaultV2(address(d.vault)), d.treasury, SHARE_MARKET_FEE_BPS);
    }

    /// @notice The veBTC line's parameters for `c`.
    function lineParams(Config memory c) public pure returns (VeBTCCreditLine.Params memory) {
        return VeBTCCreditLine.Params({
            maxLtvTimedBps: MAX_LTV_TIMED_BPS,
            maxLtvPermanentBps: MAX_LTV_PERMANENT_BPS,
            liqLtvBps: LIQ_LTV_BPS,
            liqFeeBps: LIQ_FEE_BPS,
            floorBps: FLOOR_BPS,
            auctionDuration: c.auctionDuration,
            minTerm: c.minTerm,
            originationFeeBps: ORIGINATION_FEE_BPS,
            protocolShareBps: PROTOCOL_SHARE_BPS,
            keeperShareBps: KEEPER_SHARE_BPS
        });
    }

    /// @dev Roles, adapters, caps, fees, penalties and the deposit gate. Timelocks are still 0, so each curator call
    /// is submitted and executed right away. Fee recipients are set before their fees, which VaultV2 requires. The
    /// Morpho adapter's timelocks are raised before the vault adds it, as its NatSpec requires.
    function _configureVault(Config memory c, Deployed memory d) internal {
        VaultV2 vault = d.vault;
        vault.setCurator(d.deployer);
        vault.setIsSentinel(d.deployer, true);
        vault.setName("Surety MUSD");
        vault.setSymbol("srMUSD");

        if (c.timelock != 0) _raiseAdapterTimelocks(d.morphoAdapter, c.timelock);
        _curate(vault, abi.encodeCall(IVaultV2.addAdapter, (address(d.morphoAdapter))));
        _curate(vault, abi.encodeCall(IVaultV2.addAdapter, (address(d.line))));
        _curate(vault, abi.encodeCall(IVaultV2.addAdapter, (address(d.savings))));
        _caps(vault, LineIds.adapterIdData(address(d.morphoAdapter)), c.morphoCap);
        _caps(vault, LineIds.collateralIdData(c.btc), c.morphoCap);
        _caps(vault, LineIds.marketParamsIdData(address(d.morphoAdapter), d.market), c.morphoCap);
        _caps(vault, LineIds.adapterIdData(address(d.line)), c.lineCap);
        _caps(vault, LineIds.collateralIdData(c.veBTC), c.lineCap);
        // The savings adapter takes every deposit as the liquidity adapter: its cap must never bind, and the
        // VoteAllocator accepts it only with a relative cap of exactly 100%.
        _caps(vault, LineIds.adapterIdData(address(d.savings)), c.savingsCap);

        _curate(vault, abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(d.pool))));
        _curate(vault, abi.encodeCall(IVaultV2.setPerformanceFee, (VOTER_FEE)));
        _curate(vault, abi.encodeCall(IVaultV2.setManagementFeeRecipient, (d.treasury)));
        _curate(vault, abi.encodeCall(IVaultV2.setManagementFee, (MANAGEMENT_FEE)));
        _curate(
            vault,
            abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(d.morphoAdapter), FORCE_DEALLOCATE_PENALTY))
        );
        _curate(vault, abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(d.line), FORCE_DEALLOCATE_PENALTY)));
        _curate(
            vault, abi.encodeCall(IVaultV2.setForceDeallocatePenalty, (address(d.savings), FORCE_DEALLOCATE_PENALTY))
        );
        // The VoteAllocator is the only allocator. Its `setSavings` (in _wireSurety) makes the savings adapter the
        // vault's liquidity adapter.
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

    /// @dev Lines, cross-references, savings and the peg gate, the vault's max rate, and the Morpho line's first
    /// loss checkpoint (losses before a line's first checkpoint are not recorded).
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
        // Turns parking on: the savings adapter becomes the vault's liquidity adapter.
        d.allocator.setSavings(address(d.savings));
        d.allocator.setPeg(d.peg);
        d.pool.checkpoint(MORPHO_LINE);
    }

    /// @dev Testnet only: the starter-kit Sponsor, its kit, daily limit and relayer, funded from the deployer.
    function _deploySponsor(Config memory c, Deployed memory d) internal {
        d.sponsor = new Sponsor(IVeBTCLocks(c.veBTC), IERC20(c.musd), c.minTerm, d.deployer);
        d.sponsor.setKit(KIT_BTC_GAS, KIT_LOCK, KIT_MUSD, KIT_LOCK_DURATION);
        d.sponsor.setDailyLimit(KIT_DAILY_LIMIT);
        d.sponsor.setRelayer(c.relayer, true);
        if (c.sponsorBtc != 0) {
            // Native BTC; on Mezo it is the same balance the Sponsor reads through the BTC precompile.
            (bool ok,) = payable(address(d.sponsor)).call{value: c.sponsorBtc}("");
            require(ok, "funding the Sponsor with BTC failed");
        }
        if (c.sponsorMusd != 0) IERC20(c.musd).safeTransfer(address(d.sponsor), c.sponsorMusd);
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
        vm.writeFile(path, deploymentJson(c, d));
        console2.log("Deployment written to", path);
    }

    /// @notice `deployments/<chainId>.json`, schema version 2. Testnet-only keys (`stressedPegSource`, `sponsor`,
    /// `sponsorKit`) are left out on mainnet; the proof list starts empty.
    function deploymentJson(Config memory c, Deployed memory d) public view returns (string memory json) {
        json = string.concat("{\n", _headJson(c, d));
        json = string.concat(json, '  "contracts": {\n', _contractsJson(c, d), "  },\n");
        json = string.concat(json, '  "external": {\n', _externalJson(c), "  },\n");
        json = string.concat(json, _marketIdJson(d), _lineParamsJson(c), _pegJson(c, d));
        json = string.concat(json, _feesJson(d), _capsJson(c));
        if (!c.mainnet) json = string.concat(json, _sponsorKitJson(c));
        json = string.concat(json, '  "lines": [\n', _linesJson(d), '  ],\n  "proof": {\n    "txs": []\n  }\n}\n');
    }

    function _headJson(Config memory c, Deployed memory d) internal view returns (string memory) {
        string memory chain = string.concat(
            _field("version", vm.toString(SCHEMA_VERSION), true),
            _field("chainId", vm.toString(block.chainid), true),
            _field("epochLength", vm.toString(c.epochLength), true)
        );
        return string.concat(
            chain,
            _field("deployedAt", vm.toString(d.startBlock), true),
            _field("stress", c.stress ? "true" : "false", true),
            _field("timelock", vm.toString(c.timelock), true)
        );
    }

    function _marketIdJson(Deployed memory d) internal pure returns (string memory) {
        bytes32 id = Id.unwrap(d.market.id());
        return string.concat('  "morphoMarketId": "', vm.toString(id), '",\n');
    }

    function _contractsJson(Config memory c, Deployed memory d) internal view returns (string memory) {
        string memory vaultSide = string.concat(
            _addr("vault", address(d.vault), true),
            _addr("morphoAdapter", address(d.morphoAdapter), true),
            _addr("morpho", c.morpho, true),
            _addr("irm", c.irm, true),
            _addr("savingsAdapter", address(d.savings), true),
            _addr("shareMarket", address(d.shareMarket), true)
        );
        // At most six computed pieces per concatenation: more runs the legacy code generator out of stack.
        address escrowImpl = d.line.escrowImplementation();
        string memory surety = string.concat(
            _addr("creditVoter", address(d.voter), true),
            _addr("voteAllocator", address(d.allocator), true),
            _addr("suretyPool", address(d.pool), true),
            _addr("depositGate", address(d.gate), true)
        );
        surety = string.concat(
            surety,
            _addr("veBTCLine", address(d.line), true),
            _addr("loanEscrowImpl", escrowImpl, true),
            _addr("irmLine", address(d.irmLine), true)
        );
        string memory prices = string.concat(
            _addr("priceSource", address(d.btcMusd), true),
            _addr("btcMusdSource", address(d.btcMusd), true),
            _addr("btcUsdSource", address(d.btcUsdSource), true),
            _addr("skipSource", address(d.skipSource), true),
            _addr("morphoOracle", address(d.morphoOracle), true),
            _addr("musdPeg", address(d.peg), true)
        );
        if (address(d.stressedPeg) != address(0)) {
            prices = string.concat(prices, _addr("stressedPegSource", address(d.stressedPeg), true));
        }
        string memory tail = string.concat(
            address(d.sponsor) == address(0) ? "" : _addr("sponsor", address(d.sponsor), true),
            _addr("treasury", d.treasury, false)
        );
        return string.concat(vaultSide, surety, prices, tail);
    }

    function _externalJson(Config memory c) internal pure returns (string memory) {
        string memory tokens =
            string.concat(_addr("musd", c.musd, true), _addr("btc", c.btc, true), _addr("veBTC", c.veBTC, true));
        return string.concat(
            tokens,
            _addr("poolsVoter", c.poolsVoter, true),
            _addr("rewardsDistributor", c.rewardsDistributor, true),
            _addr("skipAggregator", c.skipAggregator, true),
            _addr("smusd", c.smusd, false)
        );
    }

    function _lineParamsJson(Config memory c) internal pure returns (string memory) {
        VeBTCCreditLine.Params memory p = lineParams(c);
        string memory risk = string.concat(
            _num("maxLtvTimedBps", p.maxLtvTimedBps, true),
            _num("maxLtvPermanentBps", p.maxLtvPermanentBps, true),
            _num("liqLtvBps", p.liqLtvBps, true),
            _num("liqFeeBps", p.liqFeeBps, true),
            _num("floorBps", p.floorBps, true)
        );
        risk = string.concat(
            risk, _num("auctionDuration", p.auctionDuration, true), _num("minTerm", p.minTerm, true)
        );
        string memory fees = string.concat(
            _num("originationFeeBps", p.originationFeeBps, true),
            _num("protocolShareBps", p.protocolShareBps, true),
            _num("keeperShareBps", p.keeperShareBps, false)
        );
        return string.concat('  "lineParams": {\n', risk, fees, "  },\n");
    }

    function _pegJson(Config memory c, Deployed memory d) internal pure returns (string memory) {
        string memory params = string.concat(
            '  "peg": {\n',
            _num("minSources", c.pegMinSources, true),
            _num("maxSpreadBps", c.pegMaxSpreadBps, true),
            _num("bandBps", c.pegBandBps, true),
            _num("maxPremiumBps", c.pegMaxPremiumBps, false),
            "  },\n"
        );
        string memory sources = "";
        for (uint256 i; i < d.pegSources.length; ++i) {
            sources = string.concat(sources, _pegSourceJson(d, i), i + 1 < d.pegSources.length ? ",\n" : "\n");
        }
        return string.concat(params, '  "pegSources": [\n', sources, "  ],\n");
    }

    function _pegSourceJson(Deployed memory d, uint256 i) internal pure returns (string memory) {
        PegSourceInfo memory s = d.pegSources[i];
        bytes32 kind = keccak256(bytes(s.kind));
        string memory extra;
        if (kind == keccak256("ClTwap")) {
            extra = string.concat(
                _addrAt("      ", "pool", s.pool, true),
                _numAt("      ", "window", s.param, true),
                _numAt("      ", "minLiquidity", s.limit, false)
            );
        } else if (kind == keccak256("StableTwap")) {
            extra = string.concat(
                _addrAt("      ", "pool", s.pool, true),
                _numAt("      ", "granularity", s.param, true),
                _numAt("      ", "maxAge", s.limit, false)
            );
        } else if (kind == keccak256("BtcCross")) {
            extra = string.concat(
                _addrAt("      ", "pool", s.pool, true),
                _numAt("      ", "window", s.param, true),
                _numAt("      ", "minLiquidity", s.limit, true),
                _addrAt("      ", "btcUsd", address(d.skipSource), false)
            );
        } else {
            extra = _addrAt("      ", "base", address(0), false);
        }
        return string.concat(
            "    {\n",
            '      "kind": "',
            s.kind,
            '",\n',
            _addrAt("      ", "address", address(s.source), true),
            extra,
            "    }"
        );
    }

    function _feesJson(Deployed memory d) internal pure returns (string memory) {
        string memory vault = string.concat(
            _str("performanceFee", VOTER_FEE, true),
            _addr("performanceFeeRecipient", address(d.pool), true),
            _str("managementFee", MANAGEMENT_FEE, true),
            _addr("managementFeeRecipient", d.treasury, true),
            _str("forceDeallocatePenalty", FORCE_DEALLOCATE_PENALTY, true)
        );
        return string.concat('  "fees": {\n', vault, _num("shareMarketFeeBps", SHARE_MARKET_FEE_BPS, false), "  },\n");
    }

    function _capsJson(Config memory c) internal pure returns (string memory) {
        return string.concat(
            '  "caps": {\n',
            _str("morpho", c.morphoCap, true),
            _str("line", c.lineCap, true),
            _str("savings", c.savingsCap, false),
            "  },\n"
        );
    }

    function _sponsorKitJson(Config memory c) internal pure returns (string memory) {
        string memory kit = string.concat(
            _addr("relayer", c.relayer, true),
            _str("btcGas", KIT_BTC_GAS, true),
            _str("lockAmount", KIT_LOCK, true),
            _str("musd", KIT_MUSD, true),
            _num("lockDuration", KIT_LOCK_DURATION, true),
            _num("dailyLimit", KIT_DAILY_LIMIT, true)
        );
        string memory funding =
            string.concat(_str("fundedBtc", c.sponsorBtc, true), _str("fundedMusd", c.sponsorMusd, false));
        return string.concat('  "sponsorKit": {\n', kit, funding, "  },\n");
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

    /// @dev A JSON number, for values a double holds exactly (basis points, seconds, counts).
    function _num(string memory key, uint256 value, bool comma) internal pure returns (string memory) {
        return string.concat('    "', key, '": ', vm.toString(value), comma ? ",\n" : "\n");
    }

    /// @dev A decimal string, for token amounts and WAD values, which a double cannot hold exactly.
    function _str(string memory key, uint256 value, bool comma) internal pure returns (string memory) {
        return _numAt("    ", key, value, comma);
    }

    function _numAt(string memory indent, string memory key, uint256 value, bool comma)
        internal
        pure
        returns (string memory)
    {
        return string.concat(indent, '"', key, '": "', vm.toString(value), comma ? '",\n' : '"\n');
    }

    function _log(Config memory c, Deployed memory d) internal view {
        console2.log("chain            ", c.mainnet ? "Mezo mainnet" : "Mezo testnet");
        console2.log("stress oracle    ", c.stress);
        console2.log("deployer         ", d.deployer);
        console2.log("treasury         ", d.treasury);
        console2.log("vault            ", address(d.vault));
        console2.log("morphoAdapter    ", address(d.morphoAdapter));
        console2.log("savingsAdapter   ", address(d.savings));
        console2.log("shareMarket      ", address(d.shareMarket));
        console2.log("creditVoter      ", address(d.voter));
        console2.log("voteAllocator    ", address(d.allocator));
        console2.log("suretyPool       ", address(d.pool));
        console2.log("depositGate      ", address(d.gate));
        console2.log("veBTCLine        ", address(d.line));
        console2.log("btcMusdSource    ", address(d.btcMusd));
        console2.log("btcUsdSource     ", address(d.btcUsdSource));
        console2.log("musdPeg          ", address(d.peg));
        console2.log("morphoOracle     ", address(d.morphoOracle));
        console2.log("morpho           ", c.morpho);
        console2.log("market LLTV (WAD)", c.lltv);
        console2.log("market id        ", vm.toString(Id.unwrap(d.market.id())));
        if (address(d.sponsor) != address(0)) {
            console2.log("sponsor          ", address(d.sponsor));
            console2.log("sponsor relayer  ", c.relayer);
            console2.log("sponsor BTC (wei)", c.sponsorBtc);
            console2.log("sponsor MUSD wei ", c.sponsorMusd);
        }
        _logPeg(d);
    }

    /// @dev What the peg reads now. Never reverts; on a local fork without SIMULATE_PRECOMPILES the BTC-cross source
    /// reads as not ok, because forge cannot execute the Skip precompile.
    function _logPeg(Deployed memory d) internal view {
        MusdPeg.Reading[] memory r = d.peg.readings();
        for (uint256 i; i < r.length; ++i) {
            console2.log(
                string.concat("peg source ", vm.toString(i), " ", d.pegSources[i].kind),
                r[i].ok ? "ok" : "no reading",
                r[i].musdUsdWad
            );
        }
        console2.log("peg healthy      ", d.peg.pegHealthy());
    }
}
