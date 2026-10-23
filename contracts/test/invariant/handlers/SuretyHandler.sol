// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IMorpho, Id, MarketParams, Position} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";

import {CreditVoter} from "../../../src/CreditVoter.sol";
import {SuretyPool} from "../../../src/SuretyPool.sol";
import {VoteAllocator} from "../../../src/VoteAllocator.sol";
import {IVeBTC} from "../../../src/interfaces/IVeBTC.sol";
import {VeBTCCreditLine} from "../../../src/lines/VeBTCCreditLine.sol";
import {StressedPriceSource} from "../../../src/oracles/StressedPriceSource.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {MockVeBTC} from "../../mocks/MockVeBTC.sol";

/// @notice Drives the integrated Surety system with realistic, bounded actors: lenders, veBTC voters, a sponsor,
/// veBTC and Morpho borrowers, liquidators/bidders, a price shock source and a keeper. Time only moves through
/// `warp` and `flip`.
/// @dev Records every SuretyPool event into a ghost ledger so cohort conservation can be checked from outside.
contract SuretyHandler is Test {
    using MarketParamsLib for MarketParams;

    struct System {
        VaultV2 vault;
        MockERC20 musd;
        MockERC20 btc;
        MockVeBTC ve;
        CreditVoter voter;
        VoteAllocator allocator;
        SuretyPool pool;
        VeBTCCreditLine line;
        IMorpho morpho;
        MarketParams btcMarket;
        StressedPriceSource stressed;
    }

    /// @notice Pool share flows, from SuretyPool events.
    struct Ledger {
        uint256 incentives;
        uint256 feesToCohorts;
        uint256 feesToReserve;
        uint256 claimedToOwners;
        uint256 claimedToReserve;
        uint256 slashed;
        uint256 fromReserve;
        uint256 refunded;
    }

    uint256 internal constant BPS = 10_000;
    uint256 internal constant LINES = 2;
    uint256 internal constant MAX_LTV_TIMED = 5000;
    uint256 internal constant MAX_LTV_PERMANENT = 4000;

    VaultV2 public immutable vault;
    MockERC20 public immutable musd;
    MockERC20 public immutable btc;
    MockVeBTC public immutable ve;
    CreditVoter public immutable voter;
    VoteAllocator public immutable allocator;
    SuretyPool public immutable pool;
    VeBTCCreditLine public immutable line;
    IMorpho public immutable morpho;
    StressedPriceSource public immutable stressed;
    uint256 public immutable epochLength;
    /// @notice First epoch the handler can have touched; ghost iteration starts here.
    uint256 public immutable firstEpoch;

    MarketParams internal btcMarket;
    Id internal btcMarketId;

    address[] internal lenders;
    address[] internal voters;
    uint256[] internal voterTokens;
    address[] internal borrowers;
    address[] internal morphoBorrowers;
    address internal sponsor;
    address internal keeper;

    uint256 public currentTime;
    uint256 public currentBlock;
    Ledger internal ledger;
    mapping(bytes32 action => uint256) public calls;

    constructor(System memory s, address[] memory voters_, uint256[] memory voterTokens_) {
        vault = s.vault;
        musd = s.musd;
        btc = s.btc;
        ve = s.ve;
        voter = s.voter;
        allocator = s.allocator;
        pool = s.pool;
        line = s.line;
        morpho = s.morpho;
        stressed = s.stressed;
        btcMarket = s.btcMarket;
        btcMarketId = s.btcMarket.id();
        epochLength = s.voter.EPOCH_LENGTH();
        voters = voters_;
        voterTokens = voterTokens_;

        for (uint256 i; i < 3; ++i) {
            lenders.push(makeAddr(string.concat("lender", vm.toString(i))));
            borrowers.push(makeAddr(string.concat("veBorrower", vm.toString(i))));
        }
        for (uint256 i; i < 2; ++i) {
            morphoBorrowers.push(makeAddr(string.concat("morphoBorrower", vm.toString(i))));
        }
        sponsor = makeAddr("sponsor");
        keeper = makeAddr("keeper");

        currentTime = block.timestamp;
        currentBlock = block.number;
        firstEpoch = currentTime - currentTime % epochLength;
    }

    /// @dev Pins time to the handler's clock and records the pool's events into the ledger.
    modifier step(bytes32 action) {
        vm.warp(currentTime);
        vm.roll(currentBlock);
        vm.recordLogs();
        _;
        _ingest(vm.getRecordedLogs());
        ++calls[action];
    }

    /* Lenders */

    function deposit(uint256 who, uint256 assets) external step("deposit") {
        address lender = lenders[who % lenders.length];
        assets = bound(assets, 100e18, 200_000e18);
        musd.mint(lender, assets);
        vm.startPrank(lender);
        musd.approve(address(vault), assets);
        vault.deposit(assets, lender);
        vm.stopPrank();
    }

    /// @dev Withdraws up to what the vault holds idle (no liquidity adapter).
    function withdraw(uint256 who, uint256 assets) external step("withdraw") {
        address lender = lenders[who % lenders.length];
        uint256 owned = vault.previewRedeem(vault.balanceOf(lender));
        uint256 idle = musd.balanceOf(address(vault));
        uint256 max = owned < idle ? owned : idle;
        if (max == 0) return;
        assets = bound(assets, 1, max);
        vm.prank(lender);
        vault.withdraw(assets, lender, lender);
    }

    /* Voters and sponsor */

    function vote(uint256 who, uint256 seed) external step("vote") {
        uint256 i = who % voters.length;
        uint256[] memory lineIds;
        uint256[] memory weights;
        uint256 kind = seed % 3;
        if (kind < 2) {
            lineIds = new uint256[](1);
            weights = new uint256[](1);
            lineIds[0] = kind;
            weights[0] = BPS;
        } else {
            lineIds = new uint256[](2);
            weights = new uint256[](2);
            lineIds[0] = 0;
            lineIds[1] = 1;
            weights[0] = bound(seed >> 8, 1, BPS - 1);
            weights[1] = BPS - weights[0];
        }
        vm.prank(voters[i]);
        voter.vote(voterTokens[i], lineIds, weights);
    }

    function poke(uint256 who) external step("poke") {
        _poke(who % voters.length);
    }

    function postIncentive(uint256 lineSeed, uint256 assets) external step("postIncentive") {
        assets = bound(assets, 1e18, 5_000e18);
        musd.mint(sponsor, assets);
        vm.startPrank(sponsor);
        musd.approve(address(pool), assets);
        pool.postIncentive(lineSeed % LINES, assets);
        vm.stopPrank();
    }

    function refundIncentive(uint256 lineSeed, uint256 back) external step("refundIncentive") {
        uint256 lineId = lineSeed % LINES;
        uint256 epoch = _epochBack(bound(back, 1, 8));
        if (epoch < firstEpoch || voter.lineVotes(epoch, lineId) != 0) return;
        if (pool.sponsorShares(lineId, epoch, sponsor) == 0) return;
        vm.prank(sponsor);
        pool.refundIncentive(lineId, epoch);
    }

    /// @dev Claims a matured cohort for a voter, through the keeper (claims are permissionless).
    function claim(uint256 who, uint256 lineSeed, uint256 back) external step("claim") {
        uint256 tokenId = voterTokens[who % voters.length];
        uint256 lineId = lineSeed % LINES;
        uint256 elapsed = (currentEpoch() - firstEpoch) / epochLength;
        if (elapsed < 2 + pool.SEASON()) return;
        uint256 epoch = _epochBack(bound(back, 2 + pool.SEASON(), elapsed));
        if (block.timestamp < pool.maturityOf(epoch)) return;
        if (voter.tokenVotes(epoch, tokenId, lineId) == 0 || pool.isClaimed(tokenId, lineId, epoch)) return;
        vm.prank(keeper);
        pool.claim(tokenId, lineId, epoch);
    }

    /* veBTC borrowers */

    /// @dev Locks fresh BTC (timed 28 days or permanent) and borrows between 10% and 100% of what the line allows.
    function open(uint256 who, uint256 btcAmount, uint256 ltvSeed, bool permanent) external step("open") {
        address user = borrowers[who % borrowers.length];
        btcAmount = bound(btcAmount, 0.01e18, 2e18);
        btc.mint(user, btcAmount);
        vm.startPrank(user);
        btc.approve(address(ve), btcAmount);
        uint256 tokenId = ve.createLock(btcAmount, 28 days, permanent);
        vm.stopPrank();

        uint256 max = line.maxBorrow(tokenId);
        uint256 amount = max * bound(ltvSeed, 1000, BPS) / BPS;
        if (amount == 0) return;
        vm.startPrank(user);
        ve.approve(address(line), tokenId);
        line.open(tokenId, amount);
        vm.stopPrank();
    }

    function borrowMore(uint256 loanSeed, uint256 amountSeed) external step("borrowMore") {
        uint256 loanId = _findLoan(loanSeed, true, false);
        if (loanId == 0) return;
        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        IVeBTC.LockedBalance memory lock = ve.locked(l.tokenId);
        uint256 value = uint256(int256(lock.amount)) * stressed.priceWad() / 1e18;
        uint256 limit = value * (lock.isPermanent ? MAX_LTV_PERMANENT : MAX_LTV_TIMED) / BPS;
        uint256 debt = line.debtOf(loanId);
        if (limit <= debt + 1) return;
        uint256 room = limit - debt - 1;
        if (room > line.cash()) room = line.cash();
        if (room == 0) return;
        vm.prank(l.borrower);
        line.borrowMore(loanId, bound(amountSeed, 1, room));
    }

    /// @dev Repays part or all of a loan from a third party (repay is open to anyone).
    function repay(uint256 loanSeed, uint256 fraction) external step("repay") {
        uint256 loanId = _findLoan(loanSeed, true, true);
        if (loanId == 0) return;
        uint256 debt = line.debtOf(loanId);
        uint256 amount = debt * bound(fraction, 1, BPS) / BPS;
        if (amount == 0) amount = debt;
        musd.mint(keeper, amount);
        vm.startPrank(keeper);
        musd.approve(address(line), amount);
        line.repay(loanId, amount);
        vm.stopPrank();
    }

    function extend(uint256 loanSeed) external step("extend") {
        uint256 loanId = _findLoan(loanSeed, true, false);
        if (loanId == 0) return;
        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        IVeBTC.LockedBalance memory lock = ve.locked(l.tokenId);
        if (lock.isPermanent || lock.end <= block.timestamp) return;
        if ((block.timestamp + 28 days) / 1 weeks * 1 weeks <= lock.end) return;
        vm.prank(l.borrower);
        line.extend(loanId, 28 days);
    }

    function startAuction(uint256 loanSeed) external step("startAuction") {
        uint256 loanId = _findLoan(loanSeed, true, false);
        if (loanId == 0) return;
        vm.prank(keeper);
        // A keeper bot tries every loan it picks; healthy loans are rejected with NotLiquidatable.
        try line.startAuction(loanId) {} catch {}
    }

    /// @dev A bidder buys an auctioned NFT at the current price.
    function bid(uint256 loanSeed) external step("bid") {
        uint256 loanId = _findLoan(loanSeed, false, true);
        if (loanId == 0) return;
        _bid(loanId);
    }

    /// @dev A market crash: BTC drops 30-90% for two hours and liquidation bots act in the same block, liquidating
    /// unhealthy Morpho positions, auctioning every veBTC loan past its liquidation LTV and, if `buy`, buying the
    /// auctioned NFTs at the opening price.
    function crash(uint256 bps, bool buy) external step("crash") {
        stressed.shock(uint16(bound(bps, 3000, 9000)), 2 hours);
        for (uint256 i; i < morphoBorrowers.length; ++i) {
            _liquidateMorpho(morphoBorrowers[i]);
        }
        uint256 count = line.loanCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (line.loan(id).state != VeBTCCreditLine.LoanState.Active) continue;
            vm.prank(keeper);
            try line.startAuction(id) {} catch {}
            if (buy && line.loan(id).state == VeBTCCreditLine.LoanState.Auction) _bid(id);
        }
    }

    /* Morpho borrowers */

    /// @dev Supplies fresh BTC and borrows until the whole position sits at 5-80% LTV, within the market's free
    /// liquidity.
    function borrowMorpho(uint256 who, uint256 collateral, uint256 ltvSeed) external step("borrowMorpho") {
        address user = morphoBorrowers[who % morphoBorrowers.length];
        collateral = bound(collateral, 0.01e18, 2e18);
        btc.mint(user, collateral);
        vm.startPrank(user);
        btc.approve(address(morpho), collateral);
        morpho.supplyCollateral(btcMarket, collateral, user, "");
        vm.stopPrank();

        morpho.accrueInterest(btcMarket);
        Position memory p = morpho.position(btcMarketId, user);
        (uint256 supplied, uint256 borrowed) = _market();
        uint256 totalShares = morpho.market(btcMarketId).totalBorrowShares;
        uint256 debt = totalShares == 0 ? 0 : (uint256(p.borrowShares) * borrowed + totalShares - 1) / totalShares;
        uint256 limit = uint256(p.collateral) * stressed.priceWad() / 1e18 * bound(ltvSeed, 500, 8000) / BPS;
        if (limit <= debt + 1) return;
        uint256 amount = limit - debt - 1;
        uint256 free = supplied > borrowed ? supplied - borrowed : 0;
        if (amount > free) amount = free;
        if (amount == 0) return;
        vm.prank(user);
        morpho.borrow(btcMarket, amount, 0, user, user);
    }

    function repayMorpho(uint256 who) external step("repayMorpho") {
        address user = morphoBorrowers[who % morphoBorrowers.length];
        morpho.accrueInterest(btcMarket);
        uint256 shares = morpho.position(btcMarketId, user).borrowShares;
        if (shares == 0) return;
        (, uint256 borrowed) = _market();
        musd.mint(user, borrowed + 1e18);
        vm.startPrank(user);
        musd.approve(address(morpho), borrowed + 1e18);
        morpho.repay(btcMarket, 0, shares, user, "");
        vm.stopPrank();
    }

    /// @dev Liquidates an unhealthy Morpho position as fully as Morpho allows; leftover debt becomes bad debt.
    function liquidateMorpho(uint256 who) external step("liquidateMorpho") {
        _liquidateMorpho(morphoBorrowers[who % morphoBorrowers.length]);
    }

    /* Prices */

    function shock(uint256 bps, uint256 duration) external step("shock") {
        stressed.shock(uint16(bound(bps, 0, 9000)), uint32(bound(duration, 30 minutes, 2 hours)));
    }

    /* Keeper */

    function rebalance() external step("rebalance") {
        vm.prank(keeper);
        allocator.rebalance();
    }

    function checkpoint(uint256 lineSeed) external step("checkpoint") {
        vm.prank(keeper);
        pool.checkpoint(lineSeed % LINES);
    }

    function cover(uint256 lineSeed) external step("cover") {
        vm.prank(keeper);
        pool.cover(lineSeed % LINES);
    }

    /* Time */

    /// @dev Moves time forward by one minute to three hours, never onto an epoch's first second.
    function warp(uint256 secs) external step("warp") {
        _advance(bound(secs, 1 minutes, 3 hours));
    }

    /// @dev The keeper's loop at an epoch flip, one to three epochs ahead: rebalance, carry every ballot over,
    /// cover uncovered losses, auction loans past their liquidation LTV or maturity, and claim the cohorts that
    /// matured since the last flip for their voters.
    function flip(uint256 offset) external step("flip") {
        uint256 jump = 1 + offset % 3;
        uint256 next = currentTime - currentTime % epochLength + epochLength * jump;
        _advance(next + bound(offset >> 8, 1, epochLength / 4) - currentTime);

        vm.startPrank(keeper);
        allocator.rebalance();
        vm.stopPrank();
        for (uint256 i; i < voters.length; ++i) {
            _poke(i);
        }
        vm.startPrank(keeper);
        for (uint256 lineId; lineId < LINES; ++lineId) {
            if (pool.uncoveredLoss(lineId) != 0) pool.cover(lineId);
        }
        uint256 count = line.loanCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (line.loan(id).state == VeBTCCreditLine.LoanState.Active) {
                try line.startAuction(id) {} catch {}
            }
        }
        uint256 lag = 2 + pool.SEASON();
        for (uint256 back = lag; back < lag + jump; ++back) {
            uint256 epoch = _epochBack(back);
            if (epoch < firstEpoch) break;
            for (uint256 i; i < voterTokens.length; ++i) {
                for (uint256 lineId; lineId < LINES; ++lineId) {
                    if (voter.tokenVotes(epoch, voterTokens[i], lineId) == 0) continue;
                    if (pool.isClaimed(voterTokens[i], lineId, epoch)) continue;
                    pool.claim(voterTokens[i], lineId, epoch);
                }
            }
        }
        vm.stopPrank();
    }

    /* Views for the invariants */

    function ledgerOf() external view returns (Ledger memory) {
        return ledger;
    }

    function voterTokenIds() external view returns (uint256[] memory) {
        return voterTokens;
    }

    function currentEpoch() public view returns (uint256) {
        return currentTime - currentTime % epochLength;
    }

    /* Internals */

    function _advance(uint256 secs) internal {
        currentTime += secs;
        if (currentTime % epochLength == 0) ++currentTime;
        currentBlock += 1 + secs / 3;
        vm.warp(currentTime);
        vm.roll(currentBlock);
    }

    function _poke(uint256 i) internal {
        uint256 tokenId = voterTokens[i];
        (uint256[] memory lineIds,, uint256 epochCast) = voter.ballotOf(tokenId);
        if (lineIds.length == 0 || epochCast >= voter.currentEpoch()) return;
        if (ve.votingPowerOfNFTAt(tokenId, voter.currentEpoch()) == 0) return;
        vm.prank(keeper);
        voter.poke(tokenId);
    }

    function _epochBack(uint256 back) internal view returns (uint256) {
        uint256 epoch = currentEpoch();
        return epoch < back * epochLength ? 0 : epoch - back * epochLength;
    }

    /// @dev First loan from a seed-chosen start that is Active (if `active`) or in Auction (if `auction`); 0 if none.
    function _findLoan(uint256 seed, bool active, bool auction) internal view returns (uint256) {
        uint256 count = line.loanCount();
        for (uint256 k; k < count; ++k) {
            uint256 id = 1 + (seed % count + k) % count;
            VeBTCCreditLine.LoanState state = line.loan(id).state;
            if (active && state == VeBTCCreditLine.LoanState.Active) return id;
            if (auction && state == VeBTCCreditLine.LoanState.Auction) return id;
        }
        return 0;
    }

    function _bid(uint256 loanId) internal {
        address bidder = makeAddr("bidder");
        uint256 price = line.auctionPrice(loanId);
        musd.mint(bidder, price);
        vm.startPrank(bidder);
        musd.approve(address(line), price);
        line.bid(loanId, price);
        vm.stopPrank();
    }

    function _liquidateMorpho(address user) internal {
        morpho.accrueInterest(btcMarket);
        Position memory p = morpho.position(btcMarketId, user);
        if (p.borrowShares == 0) return;
        (, uint256 borrowed) = _market();
        musd.mint(address(this), borrowed + 1e18);
        musd.approve(address(morpho), borrowed + 1e18);
        try morpho.liquidate(btcMarket, user, p.collateral, 0, "") {}
        catch {
            try morpho.liquidate(btcMarket, user, 0, p.borrowShares, "") {} catch {}
        }
    }

    function _market() internal view returns (uint256 supplied, uint256 borrowed) {
        supplied = morpho.market(btcMarketId).totalSupplyAssets;
        borrowed = morpho.market(btcMarketId).totalBorrowAssets;
    }

    /// @dev Folds the SuretyPool's share-moving events into the ledger.
    function _ingest(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool)) continue;
            bytes32 sig = logs[i].topics[0];
            bytes memory data = logs[i].data;
            if (sig == SuretyPool.IncentivePosted.selector) {
                (, uint256 shares) = abi.decode(data, (uint256, uint256));
                ledger.incentives += shares;
            } else if (sig == SuretyPool.IncentiveRefunded.selector) {
                ledger.refunded += abi.decode(data, (uint256));
            } else if (sig == SuretyPool.FeesDistributed.selector) {
                (uint256 shares, uint256 toReserve) = abi.decode(data, (uint256, uint256));
                ledger.feesToCohorts += shares - toReserve;
                ledger.feesToReserve += toReserve;
            } else if (sig == SuretyPool.Claimed.selector) {
                (address to, uint256 shares) = abi.decode(data, (address, uint256));
                if (to == address(pool)) ledger.claimedToReserve += shares;
                else ledger.claimedToOwners += shares;
            } else if (sig == SuretyPool.Covered.selector) {
                (, uint256 fromCohorts, uint256 fromReserve) = abi.decode(data, (uint256, uint256, uint256));
                ledger.slashed += fromCohorts;
                ledger.fromReserve += fromReserve;
            }
        }
    }
}
