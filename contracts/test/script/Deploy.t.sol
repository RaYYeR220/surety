// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {IMorpho, Id, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {Deploy} from "../../script/Deploy.s.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IPegSource} from "../../src/interfaces/IPegSource.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {StressedPriceSource} from "../../src/oracles/StressedPriceSource.sol";
import {BtcCrossPegSource} from "../../src/oracles/peg/BtcCrossPegSource.sol";
import {ClTwapPegSource} from "../../src/oracles/peg/ClTwapPegSource.sol";
import {StableTwapPegSource} from "../../src/oracles/peg/StableTwapPegSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockBtcPrecompile} from "../mocks/MockBtcPrecompile.sol";
import {MockDistributor} from "../mocks/MockDistributor.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPoolsVoter} from "../mocks/MockPoolsVoter.sol";
import {MockSavingsRate} from "../mocks/MockSavingsRate.sol";
import {MockBasicPool, MockCLPool} from "../mocks/MockTigrisPools.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";

/// @notice Runs script/Deploy.s.sol against local stand-ins for Mezo (MUSD, the BTC precompile, veBTC, PoolsVoter,
/// the rewards distributor, sMUSD, the Skip feed, Tigris pools) and the pinned Morpho Blue + AdaptiveCurveIrm, as
/// testnet and as mainnet, and checks the wiring it leaves behind and the deployment file it would write.
/// @dev The script broadcasts from forge's default sender, which owns everything afterwards (as the deployer key does
/// on chain). Mezo's addresses are replaced in the script's config struct, not through the environment, so parallel
/// tests cannot see each other's settings.
contract DeployScriptTest is Test {
    using MarketParamsLib for MarketParams;

    uint256 internal constant START_TIME = 1792771353;
    address internal constant SKIP_BTC_USD = 0x7b7c000000000000000000000000000000000015;
    int256 internal constant BTC_USD = 81_350e18;
    uint256 internal constant DAY = 1 days;

    Deploy internal script;
    MockERC20 internal musd;
    address internal btc;
    MockVeBTC internal ve;
    MockPoolsVoter internal poolsVoter;
    MockDistributor internal distributor;
    MockSavingsRate internal smusd;
    IMorpho internal morpho;
    address internal irm;

    address internal relayer = makeAddr("relayer");
    address internal treasury = makeAddr("treasury");
    address internal lender = makeAddr("lender");

    function setUp() public {
        vm.warp(START_TIME);
        script = new Deploy();

        musd = new MockERC20("Mezo USD", "MUSD", 18);
        btc = new MockBtcPrecompile().etch();
        ve = new MockVeBTC(btc);
        poolsVoter = new MockPoolsVoter(ve);
        ve.setVoter(address(poolsVoter));
        distributor = new MockDistributor(ve);
        smusd = new MockSavingsRate(IERC20(address(musd)));
        vm.etch(SKIP_BTC_USD, address(new MockAggregator(BTC_USD)).code);
        MockAggregator(SKIP_BTC_USD).setAnswer(BTC_USD);

        morpho = IMorpho(vm.deployCode("Morpho.sol:Morpho", abi.encode(address(this))));
        irm = vm.deployCode("AdaptiveCurveIrm.sol:AdaptiveCurveIrm", abi.encode(address(morpho)));
        morpho.enableIrm(irm);
        morpho.enableLltv(0.77e18);
        morpho.enableLltv(0.86e18);

        // What the deployer holds before the run: gas money and the Sponsor's funding.
        vm.deal(DEFAULT_SENDER, 1e18);
        musd.mint(DEFAULT_SENDER, 1_000e18);
    }

    /* Testnet */

    function test_testnet_wiring() public {
        (Deploy.Config memory c, Deploy.Deployed memory d) = _deployTestnet();
        assertEq(d.deployer, DEFAULT_SENDER);
        assertEq(d.treasury, d.deployer, "treasury defaults to the deployer");

        _checkVault(c, d);
        _checkAllocator(d);
        _checkLine(c, d, 600, 3600);
        _checkMarket(c, d, 0.77e18);

        // Testnet prices: a stressed BTC/USD and a single stressed peg source at $1.
        assertEq(address(d.btcUsdSource), address(d.btcMusd.btcUsd()));
        assertEq(address(StressedPriceSource(address(d.btcUsdSource)).base()), address(d.skipSource));
        IPegSource[] memory sources = d.peg.sources();
        assertEq(sources.length, 1);
        assertEq(address(sources[0]), address(d.stressedPeg));
        assertEq(d.peg.minSources(), 1);
        assertEq(d.peg.maxSpreadBps(), 1000);
        assertEq(d.peg.bandBps(), 300);
        assertEq(MorphoPriceOracle(d.market.oracle).price(), uint256(BTC_USD) * 1e18, "BTC in MUSD at $1");

        // A depeg on the stressed source closes the allocator's funding gate.
        assertTrue(d.allocator.pegGateOpen());
        d.stressedPeg.stress(0.9e18, 1 hours);
        assertFalse(d.allocator.pegGateOpen());
        assertFalse(d.line.peg().pegHealthy());

        // Testnet keeps every vault timelock at zero.
        assertEq(d.vault.timelock(IVaultV2.setManagementFee.selector), 0);
    }

    function test_testnet_sponsor() public {
        (, Deploy.Deployed memory d) = _deployTestnet();
        assertEq(d.sponsor.owner(), d.deployer);
        assertEq(address(d.sponsor.veBTC()), address(ve));
        assertEq(address(d.sponsor.musd()), address(musd));
        assertEq(d.sponsor.minTerm(), 3600);
        assertEq(d.sponsor.btcGas(), 0.00005e18);
        assertEq(d.sponsor.lockAmount(), 0.001e18);
        assertEq(d.sponsor.musdAmount(), 50e18);
        assertEq(d.sponsor.lockDuration(), 28 days);
        assertEq(d.sponsor.dailyLimit(), 100);
        assertTrue(d.sponsor.isRelayer(relayer));
        assertEq(address(d.sponsor).balance, 0.006e18);
        assertEq(musd.balanceOf(address(d.sponsor)), 300e18);
        assertEq(d.sponsor.kitsLeft(), 5, "0.006 BTC pays for five kits of 0.00105");

        // A relayer hands a new wallet its kit.
        address newcomer = makeAddr("newcomer");
        vm.prank(relayer);
        uint256 tokenId = d.sponsor.starterKit(newcomer);
        assertEq(ve.ownerOf(tokenId), newcomer);
        assertEq(musd.balanceOf(newcomer), 50e18);
    }

    function test_testnet_deploymentFile() public {
        (Deploy.Config memory c, Deploy.Deployed memory d) = _deployTestnet();
        string memory json = script.deploymentJson(c, d);
        assertEq(vm.parseJsonUint(json, ".version"), 2);
        assertEq(vm.parseJsonUint(json, ".chainId"), 31611);
        assertEq(vm.parseJsonUint(json, ".epochLength"), 3600);
        assertTrue(vm.parseJsonBool(json, ".stress"));
        assertEq(vm.parseJsonAddress(json, ".contracts.vault"), address(d.vault));
        assertEq(vm.parseJsonAddress(json, ".contracts.priceSource"), address(d.btcMusd));
        assertEq(vm.parseJsonAddress(json, ".contracts.btcMusdSource"), address(d.btcMusd));
        assertEq(vm.parseJsonAddress(json, ".contracts.btcUsdSource"), address(d.btcUsdSource));
        assertEq(vm.parseJsonAddress(json, ".contracts.musdPeg"), address(d.peg));
        assertEq(vm.parseJsonAddress(json, ".contracts.stressedPegSource"), address(d.stressedPeg));
        assertEq(vm.parseJsonAddress(json, ".contracts.savingsAdapter"), address(d.savings));
        assertEq(vm.parseJsonAddress(json, ".contracts.shareMarket"), address(d.shareMarket));
        assertEq(vm.parseJsonAddress(json, ".contracts.sponsor"), address(d.sponsor));
        assertEq(vm.parseJsonAddress(json, ".contracts.treasury"), d.treasury);
        assertEq(vm.parseJsonAddress(json, ".external.smusd"), address(smusd));
        assertEq(vm.parseJsonBytes32(json, ".morphoMarketId"), Id.unwrap(d.market.id()));
        assertEq(vm.parseJsonBytes32(json, ".lines[0].marketId"), Id.unwrap(d.market.id()));
        assertEq(vm.parseJsonUint(json, ".lineParams.floorBps"), 8500);
        assertEq(vm.parseJsonUint(json, ".lineParams.auctionDuration"), 600);
        assertEq(vm.parseJsonUint(json, ".lineParams.originationFeeBps"), 25);
        assertEq(vm.parseJsonString(json, ".pegSources[0].kind"), "Stressed");
        assertEq(vm.parseJsonAddress(json, ".pegSources[0].address"), address(d.stressedPeg));
        assertEq(vm.parseJsonUint(json, ".peg.minSources"), 1);
        assertEq(vm.parseJsonUint(json, ".fees.managementFee"), 63_419_583);
        assertEq(vm.parseJsonAddress(json, ".sponsorKit.relayer"), relayer);
        assertEq(vm.parseJsonUint(json, ".sponsorKit.fundedBtc"), 0.006e18);
        assertEq(vm.parseJsonStringArray(json, ".proof.txs").length, 0, "no proof yet");
    }

    /* Mainnet */

    function test_mainnet_wiring() public {
        (Deploy.Config memory c, Deploy.Deployed memory d) = _deployMainnet();
        assertEq(d.treasury, treasury);

        _checkVault(c, d);
        _checkAllocator(d);
        _checkLine(c, d, 6 hours, 3 days);
        _checkMarket(c, d, 0.86e18);

        // Mainnet prices: plain Skip, four pool sources in order, 2 of 4 needed.
        assertEq(address(d.btcUsdSource), address(d.skipSource));
        assertEq(address(d.btcMusd.btcUsd()), address(d.skipSource));
        assertEq(address(d.stressedPeg), address(0));
        IPegSource[] memory sources = d.peg.sources();
        assertEq(sources.length, 4);
        assertEq(address(ClTwapPegSource(address(sources[0])).pool()), c.pegClPool);
        assertEq(ClTwapPegSource(address(sources[0])).window(), 1800);
        assertEq(ClTwapPegSource(address(sources[0])).minLiquidity(), 1e19);
        assertEq(address(StableTwapPegSource(address(sources[1])).pool()), c.pegUsdcPool);
        assertEq(StableTwapPegSource(address(sources[1])).granularity(), 2);
        assertEq(StableTwapPegSource(address(sources[1])).maxAge(), 6 hours);
        assertEq(StableTwapPegSource(address(sources[2])).granularity(), 2);
        assertEq(StableTwapPegSource(address(sources[2])).maxAge(), 6 hours);
        assertEq(address(StableTwapPegSource(address(sources[2])).pool()), c.pegUsdtPool);
        assertEq(address(BtcCrossPegSource(address(sources[3])).pool()), c.pegBtcPool);
        assertEq(address(BtcCrossPegSource(address(sources[3])).btcUsd()), address(d.skipSource));
        assertEq(BtcCrossPegSource(address(sources[3])).btcDecimals(), 18);
        assertEq(BtcCrossPegSource(address(sources[3])).window(), 1800);
        assertEq(BtcCrossPegSource(address(sources[3])).minLiquidity(), 2e20);
        assertEq(d.peg.minSources(), 2);
        assertEq(d.peg.maxSpreadBps(), 1000);
        assertEq(d.peg.bandBps(), 300);

        // Caps of the capped launch, and the timelocks raised last.
        assertEq(d.vault.absoluteCap(keccak256(LineIds.adapterIdData(address(d.line)))), 2_000e18);
        assertEq(d.vault.absoluteCap(keccak256(LineIds.adapterIdData(address(d.morphoAdapter)))), 2_000e18);
        assertEq(d.vault.timelock(IVaultV2.setManagementFee.selector), DAY);
        assertEq(d.vault.timelock(IVaultV2.addAdapter.selector), DAY);
        assertEq(d.vault.timelock(IVaultV2.increaseTimelock.selector), DAY);
        assertEq(d.voter.LINE_TIMELOCK(), DAY);
        assertEq(address(d.sponsor), address(0), "no Sponsor on mainnet");
    }

    function test_mainnet_deploymentFile() public {
        (Deploy.Config memory c, Deploy.Deployed memory d) = _deployMainnet();
        string memory json = script.deploymentJson(c, d);
        assertEq(vm.parseJsonUint(json, ".version"), 2);
        assertEq(vm.parseJsonUint(json, ".chainId"), 31612);
        assertFalse(vm.parseJsonBool(json, ".stress"));
        assertEq(vm.parseJsonUint(json, ".timelock"), DAY);
        assertFalse(vm.keyExistsJson(json, ".contracts.sponsor"));
        assertFalse(vm.keyExistsJson(json, ".contracts.stressedPegSource"));
        assertFalse(vm.keyExistsJson(json, ".sponsorKit"));
        assertEq(vm.parseJsonString(json, ".pegSources[0].kind"), "ClTwap");
        assertEq(vm.parseJsonUint(json, ".pegSources[0].window"), 1800);
        assertEq(vm.parseJsonUint(json, ".pegSources[0].minLiquidity"), 1e19);
        assertEq(vm.parseJsonString(json, ".pegSources[1].kind"), "StableTwap");
        assertEq(vm.parseJsonUint(json, ".pegSources[1].granularity"), 2);
        assertEq(vm.parseJsonUint(json, ".pegSources[1].maxAge"), 6 hours);
        assertEq(vm.parseJsonUint(json, ".pegSources[3].minLiquidity"), 2e20);
        assertEq(vm.parseJsonUint(json, ".peg.maxSpreadBps"), 1000);
        assertEq(vm.parseJsonUint(json, ".peg.maxPremiumBps"), 300);
        assertEq(vm.parseJsonAddress(json, ".pegSources[2].pool"), c.pegUsdtPool);
        assertEq(vm.parseJsonString(json, ".pegSources[3].kind"), "BtcCross");
        assertEq(vm.parseJsonAddress(json, ".pegSources[3].btcUsd"), address(d.skipSource));
        assertEq(vm.parseJsonUint(json, ".peg.minSources"), 2);
        assertEq(vm.parseJsonUint(json, ".caps.line"), 2_000e18);
        assertEq(vm.parseJsonUint(json, ".lineParams.minTerm"), 3 days);
        assertEq(vm.parseJsonAddress(json, ".fees.managementFeeRecipient"), treasury);
        assertEq(vm.parseJsonUint(json, ".lines[0].marketParams.lltv"), 0.86e18);
    }

    /// @dev Neither a stressed source nor a testnet configuration (stressed peg, Sponsor) gets onto mainnet.
    function test_mainnet_refusesStressedSources() public {
        vm.chainId(31612);
        Deploy.Config memory c = script.config();
        _mocks(c);
        c.stress = true;
        vm.expectRevert(bytes("STRESS is a testnet-only deployment"));
        script.deploy(c);

        // A testnet config (stressed peg, Sponsor) on chain 31612.
        c.stress = false;
        c.mainnet = false;
        c.relayer = relayer;
        vm.expectRevert(bytes("config is for another chain"));
        script.deploy(c);
    }

    /// @dev The script refuses a configuration the chain does not support before deploying anything.
    function test_refusesWhatTheChainDoesNotEnable() public {
        vm.chainId(31611);
        Deploy.Config memory c = _testnetConfig();
        c.lltv = 0.5e18;
        vm.expectRevert(bytes("MORPHO_LLTV is not enabled on MORPHO"));
        script.deploy(c);

        c = _testnetConfig();
        c.relayer = address(0);
        vm.expectRevert(bytes("RELAYER_ADDRESS is required on testnet"));
        script.deploy(c);

        c = _testnetConfig();
        c.savingsCap = 1e26;
        vm.expectRevert(bytes("SAVINGS_CAP below 1e27"));
        script.deploy(c);
    }

    /* Shared checks */

    function _checkVault(Deploy.Config memory c, Deploy.Deployed memory d) internal {
        IVaultV2 vault = IVaultV2(address(d.vault));
        assertEq(vault.asset(), address(musd));
        assertEq(vault.owner(), d.deployer);
        assertEq(vault.curator(), d.deployer);
        assertTrue(vault.isSentinel(d.deployer));
        assertEq(vault.adaptersLength(), 3);
        assertTrue(vault.isAdapter(address(d.morphoAdapter)));
        assertTrue(vault.isAdapter(address(d.line)));
        assertTrue(vault.isAdapter(address(d.savings)));

        // Liquidity adapter = savings, which no cap ever binds.
        assertEq(vault.liquidityAdapter(), address(d.savings));
        bytes32 savingsId = keccak256(LineIds.adapterIdData(address(d.savings)));
        assertEq(savingsId, d.savings.adapterId());
        assertGe(vault.absoluteCap(savingsId), 1e27);
        assertEq(vault.relativeCap(savingsId), 1e18);
        assertEq(vault.forceDeallocatePenalty(address(d.savings)), 0.01e18);
        assertEq(vault.forceDeallocatePenalty(address(d.line)), 0.01e18);
        assertEq(vault.forceDeallocatePenalty(address(d.morphoAdapter)), 0.01e18);
        assertEq(address(d.savings.savings()), c.smusd);

        // Fees: 10% performance fee to the pool, 0.20%/yr management fee to the treasury.
        assertEq(vault.performanceFee(), 0.1e18);
        assertEq(vault.performanceFeeRecipient(), address(d.pool));
        assertEq(vault.managementFee(), 63_419_583);
        assertEq(vault.managementFee(), script.MANAGEMENT_FEE());
        assertEq(vault.managementFeeRecipient(), d.treasury);
        assertEq(vault.receiveSharesGate(), address(d.gate));
        assertEq(address(d.gate.pool()), address(d.pool));
        assertEq(d.gate.treasury(), d.treasury, "the gate lets the management-fee recipient through");
        assertEq(vault.managementFeeRecipient(), d.gate.treasury());
        assertEq(vault.maxRate(), 200e16 / uint256(365 days));

        // ShareMarket sells srMUSD for MUSD with 10 bps to the treasury.
        assertEq(address(d.shareMarket.vault()), address(d.vault));
        assertEq(d.shareMarket.treasury(), d.treasury);
        assertEq(d.shareMarket.feeBps(), 10);

        // A deposit lands in sMUSD through the liquidity adapter.
        musd.mint(lender, 100e18);
        vm.startPrank(lender);
        musd.approve(address(vault), 100e18);
        vault.deposit(100e18, lender);
        vm.stopPrank();
        assertEq(smusd.balanceOf(address(d.savings)), 100e18);
        assertEq(musd.balanceOf(address(vault)), 0);
        assertEq(vault.totalAssets(), 100e18);
    }

    function _checkAllocator(Deploy.Deployed memory d) internal view {
        assertTrue(d.vault.isAllocator(address(d.allocator)));
        assertFalse(d.vault.isAllocator(d.deployer), "the VoteAllocator is the only allocator");
        assertEq(d.allocator.savings(), address(d.savings));
        assertTrue(d.allocator.parking());
        assertEq(address(d.allocator.peg()), address(d.peg));
        assertEq(d.allocator.suretyPool(), address(d.pool));
        assertEq(d.pool.allocator(), address(d.allocator));
        assertEq(d.voter.lineCount(), 2);
        ICreditVoter.Line memory morphoLine = d.voter.line(0);
        assertEq(morphoLine.adapter, address(d.morphoAdapter));
        assertEq(keccak256(morphoLine.data), keccak256(abi.encode(d.market)));
        assertEq(d.voter.line(1).adapter, address(d.line));
        assertEq(address(d.voter.escrowRegistry()), address(d.line));
    }

    function _checkLine(Deploy.Config memory, Deploy.Deployed memory d, uint32 auctionDuration, uint32 minTerm)
        internal
        view
    {
        VeBTCCreditLine.Params memory p = d.line.params();
        assertEq(p.maxLtvTimedBps, 5000);
        assertEq(p.maxLtvPermanentBps, 4000);
        assertEq(p.liqLtvBps, 6500);
        assertEq(p.liqFeeBps, 300);
        assertEq(p.floorBps, 8500);
        assertEq(p.auctionDuration, auctionDuration);
        assertEq(p.minTerm, minTerm);
        assertEq(p.originationFeeBps, 25);
        assertEq(p.protocolShareBps, 2000);
        assertEq(p.keeperShareBps, 5000);
        assertEq(d.line.treasury(), d.treasury);
        assertEq(address(d.line.peg()), address(d.peg));
        assertTrue(d.line.pegCheck(), "peg check on");
        assertEq(address(d.line.oracle()), address(d.btcMusd));
        assertEq(d.line.suretyPool(), address(d.pool));
        assertEq(d.line.owner(), d.deployer);
        assertEq(address(d.line.ve()), address(ve));
    }

    /// @dev Market oracle = MorphoPriceOracle(BtcMusdPriceSource(btcUsd, peg)), on a new market of Mezo's Morpho.
    function _checkMarket(Deploy.Config memory c, Deploy.Deployed memory d, uint256 lltv) internal view {
        MarketParams memory m = morpho.idToMarketParams(d.market.id());
        assertEq(m.loanToken, address(musd));
        assertEq(m.collateralToken, btc);
        assertEq(m.oracle, address(d.morphoOracle));
        assertEq(m.irm, irm);
        assertEq(m.lltv, lltv);
        assertEq(address(MorphoPriceOracle(m.oracle).source()), address(d.btcMusd));
        assertEq(address(d.btcMusd.peg()), address(d.peg));
        assertEq(d.btcMusd.maxPremiumBps(), 300);
        assertGt(morpho.market(d.market.id()).lastUpdate, 0, "market created");
        assertEq(d.morphoAdapter.morpho(), c.morpho);
        assertEq(d.morphoAdapter.adaptiveCurveIrm(), irm);
    }

    /* Runs */

    function _testnetConfig() internal view returns (Deploy.Config memory c) {
        c = script.config();
        _mocks(c);
        c.stress = true;
        c.relayer = relayer;
    }

    function _deployTestnet() internal returns (Deploy.Config memory c, Deploy.Deployed memory d) {
        vm.chainId(31611);
        c = _testnetConfig();
        d = script.deploy(c);
    }

    function _deployMainnet() internal returns (Deploy.Config memory c, Deploy.Deployed memory d) {
        vm.chainId(31612);
        c = script.config();
        _mocks(c);
        c.treasury = treasury;
        MockERC20 usdc = new MockERC20("Mezo USDC", "mUSDC", 6);
        MockERC20 usdt = new MockERC20("Mezo USDT", "mUSDT", 6);
        c.pegClPool = address(new MockCLPool(address(usdc), address(musd)));
        c.pegUsdcPool = address(new MockBasicPool(address(usdc), address(musd)));
        c.pegUsdtPool = address(new MockBasicPool(address(musd), address(usdt)));
        c.pegBtcPool = address(new MockCLPool(btc, address(musd)));
        d = script.deploy(c);
    }

    function _mocks(Deploy.Config memory c) internal view {
        c.musd = address(musd);
        c.btc = btc;
        c.veBTC = address(ve);
        c.poolsVoter = address(poolsVoter);
        c.rewardsDistributor = address(distributor);
        c.skipAggregator = SKIP_BTC_USD;
        c.smusd = address(smusd);
        c.morpho = address(morpho);
        c.irm = irm;
    }
}
