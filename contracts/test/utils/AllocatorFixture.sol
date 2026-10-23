// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {VoteAllocator} from "../../src/VoteAllocator.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {MorphoPriceOracle} from "../../src/oracles/MorphoPriceOracle.sol";
import {SkipPriceSource} from "../../src/oracles/SkipPriceSource.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {LineFixture} from "./LineFixture.sol";

/// @notice Unit fixture: LineFixture plus a CreditVoter with three lines and a VoteAllocator holding the vault's
/// allocator role. No SuretyPool is set; tests install their own.
/// @dev
/// - Lines: 0 = BTC Morpho market (fixture market, priced by `stressedSource`), 1 = the VeBTCCreditLine (also
///   `stressedSource`), 2 = a second Morpho market on the same adapter with "cbBTC" collateral and its own feed, so
///   one line's oracle can go stale while the others stay live.
/// - The cbBTC market gets MORPHO_CAP caps on its collateral and market ids; the adapter id is shared with line 0.
/// - `admin` stays a vault allocator from SuretyFixture; tests only move capital through the VoteAllocator.
/// - Voters lock permanently, so their power is exactly the BTC amount in every epoch after the lock.
abstract contract AllocatorFixture is LineFixture {
    uint256 internal constant BTC_LINE = MORPHO_LINE;
    uint256 internal constant CBTC_LINE = 2;

    MockERC20 internal cbtc;
    MockAggregator internal cbtcAggregator;
    SkipPriceSource internal cbtcSource;
    MorphoPriceOracle internal cbtcOracle;
    MarketParams internal cbtcMarket;

    function setUp() public virtual override {
        super.setUp();
        _deployCbtcMarket();
        _deployAllocator();
    }

    function _deployCbtcMarket() internal {
        cbtc = new MockERC20("Bridged BTC", "cbBTC", 18);
        cbtcAggregator = new MockAggregator(BTC_USD);
        cbtcSource = new SkipPriceSource(IAggregatorV3(address(cbtcAggregator)), ORACLE_MAX_AGE);
        cbtcOracle = new MorphoPriceOracle(cbtcSource);
        vm.label(address(cbtc), "cbBTC");
        vm.label(address(cbtcOracle), "cbBTCOracle");

        cbtcMarket = MarketParams({
            loanToken: address(musd), collateralToken: address(cbtc), oracle: address(cbtcOracle), irm: irm, lltv: LLTV
        });
        morpho.createMarket(cbtcMarket);
        _setCaps(LineIds.collateralIdData(address(cbtc)), MORPHO_CAP);
        _setCaps(LineIds.marketParamsIdData(address(morphoAdapter), cbtcMarket), MORPHO_CAP);
    }

    function _deployAllocator() internal {
        voter = new CreditVoter(IVeBTC(address(ve)), EPOCH_LENGTH, admin);
        vm.startPrank(admin);
        voter.addLine(address(morphoAdapter), abi.encode(btcMarket), ICreditVoter.LineKind.Morpho, "BTC / Morpho");
        voter.addLine(address(line), "", ICreditVoter.LineKind.VeBTC, "veBTC credit");
        voter.addLine(address(morphoAdapter), abi.encode(cbtcMarket), ICreditVoter.LineKind.Morpho, "cbBTC / Morpho");
        vm.stopPrank();

        allocator = new VoteAllocator(address(vault), voter, admin, IDLE_BUFFER_BPS);
        vm.label(address(voter), "CreditVoter");
        vm.label(address(allocator), "VoteAllocator");
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (address(allocator), true)));
    }

    /* Voting */

    /// @notice Permanent lock of `amount` BTC for `user`: its power is `amount` from the next epoch on.
    function _voterLock(address user, uint256 amount) internal returns (uint256 tokenId) {
        tokenId = _lockPermanent(user, amount);
    }

    function _vote(address user, uint256 tokenId, uint256 lineId) internal {
        _voteAll(user, tokenId, lineId);
    }

    function _vote2(address user, uint256 tokenId, uint256 lineA, uint256 weightA, uint256 lineB) internal {
        _vote(user, tokenId, _arr(lineA, lineB), _arr(weightA, BPS - weightA));
    }

    /* Rebalancing */

    /// @notice Assets the vault would hold in lines at a perfect rebalance: total assets minus the idle buffer.
    function _deployable() internal view returns (uint256) {
        return vault.totalAssets() * (BPS - IDLE_BUFFER_BPS) / BPS;
    }

    function _idle() internal view returns (uint256) {
        return musd.balanceOf(address(vault));
    }
}
