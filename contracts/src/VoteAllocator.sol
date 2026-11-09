// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IMorpho, Id, Market, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {IOracle} from "morpho-blue/interfaces/IOracle.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/libraries/SharesMathLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE, WAD} from "vault-v2/libraries/ConstantsLib.sol";

import {ICreditVoter} from "./interfaces/ICreditVoter.sol";
import {IMusdPeg} from "./interfaces/IMusdPeg.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";
import {ISavingsAdapter} from "./interfaces/ISavingsAdapter.sol";
import {ISuretyLine} from "./interfaces/ISuretyLine.sol";
import {ISuretyPool, SAVINGS_LINE_ID} from "./interfaces/ISuretyPool.sol";
import {IVoteAllocator} from "./interfaces/IVoteAllocator.sol";
import {LineIds} from "./libraries/LineIds.sol";

/// @title VoteAllocator
/// @notice Holds the Surety vault's allocator role and sizes each credit line from CreditVoter tallies, then
/// measures what each line earned so the SuretyPool can split the voters' fee shares by line.
/// @dev
/// Timeline: votes cast in epoch t drive the allocation from the first rebalance of t+1, and the interest the lines
/// earn while that allocation is live is attributed to cohort t at the first rebalance of t+2.
/// - Tally: the first rebalance of an epoch fixes it for the epoch: the previous epoch if any active line got votes
///   in it, else the current epoch (bootstrap; its tally can still change, so re-runs follow it). Oracle liveness
///   plays no part, so a stale feed at the flip cannot throw away the closed epoch's tally.
/// - Targets: `deployable = totalAssets * (1 - idleBuffer)` split by the tally over active lines, each capped by the
///   room the VaultV2 absolute and relative caps of its ids leave once the other lines have shrunk to their shares.
///   An active line that cannot take new money (stale oracle, paused veBTC line, or a veBTC line whose calls revert)
///   holds what it has up to that target, `min(current, target)`: no new money and no forced pull. Inactive or
///   unvoted lines target zero. When several lines grow into one shared cap, targets are upper bounds: caps are
///   re-checked before each allocation, in line order.
/// - Moves: overweight lines are deallocated first, bounded by what they can pay out now (Morpho market liquidity,
///   veBTC line cash), then underweight lines are allocated from the vault's cash above the buffer. Nothing reverts
///   on an illiquid line; a re-run inside the epoch continues the move. A move the vault rejects is skipped and
///   reported.
/// - Savings (once `setSavings` is called): the vault's cash is its idle MUSD plus what the SavingsAdapter holds in
///   sMUSD, which is also the vault's liquidity adapter while parking is on (deposits land there, withdrawals pull
///   from it). A line is funded from idle MUSD first, then from savings, withdrawn just before the line's
///   allocation; every run ends by parking all idle MUSD (what deallocations, forced exits and covers left there)
///   back in savings. Savings is not a line: no votes, no target, no cap room; the buffer stays in it. With parking
///   off, the run brings everything in savings back to idle and funds lines from idle only. If savings cannot pay
///   (sMUSD withdrawals revert), the move is reported, lines are funded from idle above the buffer only, and the
///   run parks nothing.
/// - Peg gate (once `setPeg` is called): while `pegHealthy()` is false (or the call fails), a run funds no line and
///   emits PegUnhealthy; overweight lines are still deallocated and idle MUSD is still parked.
/// - Losses: each rebalance has the pool checkpoint every line before it measures, and again after its moves so the
///   pool values a later Morpho loss on the adapter's shares as this run left them. A checkpoint that fails is
///   reported and skipped; it never blocks the run.
/// - Interest is never read from changes in a line's assets, which anyone can move through VaultV2's permissionless
///   `forceDeallocate` (and covers and losses move too). Each rebalance snapshots, after its own moves:
///   - Morpho lines: the adapter's supply shares in the market and the market's supply share price. The next
///     rebalance measures `sharesAtSnapshot * (sharePriceNow - sharePriceAtSnapshot)` with Morpho's share math
///     (virtual shares and assets) on the accrued market. Only interest raises Morpho's supply share price and only
///     bad debt lowers it, so nobody else's moves change the result; a drop measures zero (the pool handles it as a
///     loss).
///   - veBTC lines: the line's cumulative `interestEarnedTotal()`, and measures its increase.
///   - Savings: the SavingsAdapter's cumulative `interestEarnedTotal()` (sMUSD yield paid plus claimable), measured
///     against the highest value seen, at the start of each run.
///   Interest accumulates until the first rebalance of the next epoch hands it to `SuretyPool.distributeFees`; the
///   savings yield is reported under SAVINGS_LINE_ID, so the fee VaultV2 took on it goes to the reserve, not to the
///   line cohorts.
/// Trust: the only capital moves are VaultV2 `allocate` / `deallocate` with the adapter and data the CreditVoter lists
/// for a line (validated and, after its bootstrap, timelocked there). VaultV2 rejects addresses that are not its
/// adapters and enforces the caps; tokens never pass through this contract. A veBTC line's own calls (ids, paused,
/// oracle, cash, interest counter) are guarded, so a line whose calls revert only makes itself ineligible. The owner
/// can only set the pool, the savings adapter and the peg once each, switch parking in savings on or off, and set
/// the vault's max rate within VaultV2's bound.
contract VoteAllocator is IVoteAllocator, Ownable2Step, ReentrancyGuardTransient {
    using MarketParamsLib for MarketParams;
    using MorphoBalancesLib for IMorpho;
    using SharesMathLib for uint256;

    // Looping over lines with external calls is the job: the list is short and curated, and every call goes to the
    // vault, the voter, the pool or a listed line's adapter, market or oracle. rebalance is nonReentrant and
    // snapshots the ledger after its moves on purpose. Events after those calls report what the calls did.
    // forge-lint: disable-start(calls-loop, reentrancy-events, reentrancy-no-eth)

    /// @notice What the last rebalance left a line at, and the interest measured since the last attribution.
    /// @param pendingInterest Interest measured since the last attribution.
    /// @param shares Morpho lines: the adapter's supply shares in the line's market.
    /// @param totalSupplyAssets Morpho lines: the market's total supply assets (with `totalSupplyShares`, its supply
    /// share price).
    /// @param totalSupplyShares Morpho lines: the market's total supply shares.
    /// @param earned veBTC lines: the line's `interestEarnedTotal()`.
    struct Ledger {
        uint256 pendingInterest;
        uint256 shares;
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint256 earned;
    }

    /// @dev A line as one rebalance sees it.
    /// @param params Morpho market parameters (Morpho lines only).
    /// @param marketId Morpho market id (Morpho lines only).
    /// @param ownId Cap id no other line uses: the market id for Morpho lines, the adapter id for veBTC lines.
    /// @param ids Every cap id an allocation to the line counts against.
    /// @param active Whether the CreditVoter has the line active (its votes count).
    /// @param eligible Active and able to take new money (live oracle; veBTC line not paused, calls not reverting).
    /// @param share Vote-weighted slice of the deployable assets (zero when inactive or unvoted).
    /// @param release Allocation the line is expected to give back this run: its recorded allocation above `share`.
    /// @param target `share` capped by the room the vault's caps leave, and by the line's assets when not eligible.
    struct LineState {
        address adapter;
        bytes data;
        ICreditVoter.LineKind kind;
        MarketParams params;
        bytes32 marketId;
        bytes32 ownId;
        bytes32[] ids;
        bool active;
        bool eligible;
        uint256 votes;
        uint256 share;
        uint256 release;
        uint256 target;
    }

    uint256 public constant BPS = 10_000;
    /// @dev A gap of at most target / MOVE_TOLERANCE is left alone, so re-runs do not churn on rounding dust.
    uint256 internal constant MOVE_TOLERANCE = 1e9;

    IVaultV2 public immutable vault;
    /// @notice The vault's asset (MUSD).
    IERC20 public immutable asset;
    ICreditVoter public immutable voter;
    /// @notice Epoch length of the CreditVoter.
    uint256 public immutable EPOCH_LENGTH;
    /// @notice Share of total assets kept idle in the vault, in basis points.
    uint256 public immutable idleBufferBps;

    /// @notice Receives fee attributions and records losses at each rebalance. Set once.
    address public suretyPool;
    /// @inheritdoc IVoteAllocator
    uint256 public activeTallyEpoch;
    /// @notice Epoch of the last rebalance; zero before the first one.
    uint256 public lastRebalanceEpoch;
    /// @notice Lines with a baseline (ids below this). Lines listed later join at their next rebalance.
    uint256 public trackedLines;
    /// @notice The vault's SavingsAdapter, where idle MUSD is parked; zero until set. Set once.
    address public savings;
    /// @notice Whether idle MUSD is parked in `savings`, which is then the vault's liquidity adapter.
    bool public parking;
    /// @notice MUSD peg monitor: while it reports unhealthy no line is funded. Zero (no gate) until set. Set once.
    IMusdPeg public peg;

    mapping(uint256 lineId => Ledger) internal ledgers;
    /// @dev Savings yield measured since the last attribution, and the adapter's counter at its highest so far.
    Ledger internal savingsBook;

    /// @param interest Interest each line earned since the previous rebalance.
    event Rebalanced(
        uint256 indexed epoch, uint256 indexed tallyEpoch, uint256[] lineIds, uint256[] targets, uint256[] interest
    );
    /// @notice Interest handed to the pool for the fee shares of `cohortEpoch`.
    event InterestAttributed(uint256 indexed cohortEpoch, uint256[] lineIds, uint256[] interest);
    /// @notice The vault rejected a move; capital stays where it is until a later rebalance.
    event MoveFailed(uint256 indexed lineId, bool allocation, uint256 assets, bytes reason);
    /// @notice The pool's loss checkpoint of `lineId` reverted; the line's losses wait for a later checkpoint.
    event CheckpointFailed(uint256 indexed lineId, bytes reason);
    event SuretyPoolSet(address indexed pool);
    event MaxRateSet(uint256 maxRate);
    event SavingsSet(address indexed adapter);
    /// @param parking Whether idle MUSD is now parked in savings (and savings is the vault's liquidity adapter).
    event ParkingSet(bool parking);
    event PegSet(address indexed peg);
    /// @notice This run funded no line because the MUSD peg is unhealthy (or its monitor could not be read).
    /// Overweight lines were still deallocated and idle MUSD still parked.
    event PegUnhealthy(uint256 indexed epoch);
    /// @notice The vault rejected a move into (`allocation`) or out of savings; the cash stays where it is.
    event SavingsMoveFailed(bool allocation, uint256 assets, bytes reason);
    /// @notice Savings yield handed to the pool with the fees of `cohortEpoch`; its fee part goes to the reserve.
    event SavingsInterestAttributed(uint256 indexed cohortEpoch, uint256 interest);

    error ZeroAddress();
    error BadIdleBuffer();
    error SuretyPoolAlreadySet();
    error MaxRateTooHigh();
    error SavingsAlreadySet();
    error NoSavings();
    error UnsupportedSavings();
    error SavingsCapsUnset();
    error PegAlreadySet();

    /// @param vault_ The Surety VaultV2; this contract must be granted its allocator role.
    /// @param voter_ CreditVoter listing the lines and their tallies.
    /// @param owner_ Account allowed to set the pool and the vault's max rate.
    /// @param idleBufferBps_ Share of total assets kept idle, at most 10_000.
    constructor(address vault_, ICreditVoter voter_, address owner_, uint256 idleBufferBps_) Ownable(owner_) {
        if (vault_ == address(0) || address(voter_) == address(0)) revert ZeroAddress();
        if (idleBufferBps_ > BPS) revert BadIdleBuffer();
        vault = IVaultV2(vault_);
        asset = IERC20(IVaultV2(vault_).asset());
        voter = voter_;
        EPOCH_LENGTH = voter_.EPOCH_LENGTH();
        idleBufferBps = idleBufferBps_;
    }

    /* Owner */

    /// @notice Sets the SuretyPool. Callable once.
    function setSuretyPool(address pool) external onlyOwner {
        if (pool == address(0)) revert ZeroAddress();
        if (suretyPool != address(0)) revert SuretyPoolAlreadySet();
        suretyPool = pool;
        emit SuretyPoolSet(pool);
    }

    /// @notice Sets the vault's max rate (the fastest its share price may rise), at most VaultV2's MAX_MAX_RATE.
    function setMaxRate(uint256 newMaxRate) external onlyOwner {
        if (newMaxRate > MAX_MAX_RATE) revert MaxRateTooHigh();
        emit MaxRateSet(newMaxRate);
        vault.setMaxRate(newMaxRate);
    }

    /// @notice Sets the SavingsAdapter once and turns parking on, which makes it the vault's liquidity adapter.
    /// @dev The adapter must belong to the vault and already be one of its adapters, with a non-zero absolute cap and
    /// a 100% relative cap on its id: as the liquidity adapter it takes every deposit, and a cap it hits would make
    /// deposits revert. Its interest counter is read now as the baseline.
    function setSavings(address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (savings != address(0)) revert SavingsAlreadySet();
        if (ISavingsAdapter(adapter).parentVault() != address(vault) || !vault.isAdapter(adapter)) {
            revert UnsupportedSavings();
        }
        bytes32 id = ISavingsAdapter(adapter).adapterId();
        if (vault.absoluteCap(id) == 0 || vault.relativeCap(id) != WAD) revert SavingsCapsUnset();
        savings = adapter;
        (bool ok, uint256 earned) = _earnedOf(adapter);
        if (ok) savingsBook.earned = earned;
        emit SavingsSet(adapter);
        _setParking(true);
    }

    /// @notice Turns parking in savings on or off. Off unsets the vault's liquidity adapter, so deposits stay idle
    /// and withdrawals use idle MUSD only; the next rebalance brings what savings holds back to idle. For when sMUSD
    /// misbehaves (deposits or withdrawals revert), or before the curator removes the adapter.
    function setParking(bool on) external onlyOwner {
        if (savings == address(0)) revert NoSavings();
        _setParking(on);
    }

    /// @notice Sets the MUSD peg monitor once. From then on a rebalance funds no line while it reports unhealthy.
    function setPeg(IMusdPeg peg_) external onlyOwner {
        if (address(peg_) == address(0)) revert ZeroAddress();
        if (address(peg) != address(0)) revert PegAlreadySet();
        peg = peg_;
        emit PegSet(address(peg_));
    }

    /* Rebalance */

    /// @notice Moves vault capital toward the vote-weighted targets and, on the first call of an epoch, hands the
    /// interest earned since the last attribution to the pool. Permissionless and safe to re-run.
    function rebalance() external nonReentrant {
        vault.accrueInterest();
        uint256 epoch = voter.currentEpoch();
        LineState[] memory lines = _loadLines();
        _checkpointLosses(lines.length);
        uint256[] memory interest = _measure(lines);
        _measureSavings();

        bool newEpoch = epoch > lastRebalanceEpoch;
        uint256 tallyEpoch = newEpoch ? _tallyEpoch(epoch, lines) : activeTallyEpoch;
        uint256 total = vault.totalAssets();
        uint256 firstTotal = vault.firstTotalAssets();
        _setTargets(lines, tallyEpoch, total, firstTotal);
        _deallocateOverweight(lines);
        bool savingsPaid = true;
        if (_pegHealthy()) savingsPaid = _allocateUnderweight(lines, total, firstTotal);
        else emit PegUnhealthy(epoch);
        _settleSavings(savingsPaid);
        // Again after the moves, so the pool's Morpho marks hold the adapter's shares as this run left them.
        _checkpointLosses(lines.length);

        (uint256[] memory lineIds, uint256[] memory targetAssets) = _snapshot(lines);
        emit Rebalanced(epoch, tallyEpoch, lineIds, targetAssets, interest);
        if (newEpoch) _closeEpoch(epoch, tallyEpoch, lineIds);
    }

    /* Views */

    /// @notice Targets the next rebalance would aim for, per line id (upper bounds where lines contend for a shared
    /// cap). Uses the current tally epoch, or the one the next rebalance would select if it opens a new epoch.
    function targets() external view returns (uint256[] memory lineIds, uint256[] memory targetAssets) {
        LineState[] memory lines = _loadLines();
        uint256 epoch = voter.currentEpoch();
        uint256 tallyEpoch = epoch > lastRebalanceEpoch ? _tallyEpoch(epoch, lines) : activeTallyEpoch;
        uint256 total = vault.totalAssets();
        uint256 firstTotal = vault.firstTotalAssets();
        _setTargets(lines, tallyEpoch, total, firstTotal == 0 ? total : firstTotal);

        uint256 n = lines.length;
        lineIds = new uint256[](n);
        targetAssets = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            lineIds[i] = i;
            targetAssets[i] = lines[i].target;
        }
    }

    /// @inheritdoc IVoteAllocator
    /// @dev Morpho lines: the adapter's expected supply assets in the line's market; veBTC lines: `realAssets()`.
    function lineAssets(uint256 lineId) external view returns (uint256) {
        return _assetsOf(_describe(voter.line(lineId)));
    }

    /// @notice Interest ledger of `lineId`: see `Ledger`.
    function ledger(uint256 lineId) external view returns (Ledger memory) {
        return ledgers[lineId];
    }

    /// @notice Savings yield ledger: `pendingInterest` since the last attribution and `earned`, the adapter's
    /// counter at its highest so far (the other fields are unused).
    function savingsLedger() external view returns (Ledger memory) {
        return savingsBook;
    }

    /// @notice Whether a rebalance now would fund lines: no peg is set, or it reports healthy.
    function pegGateOpen() external view returns (bool) {
        return _pegHealthy();
    }

    /* Internals: lines */

    function _loadLines() internal view returns (LineState[] memory lines) {
        uint256 n = voter.lineCount();
        lines = new LineState[](n);
        for (uint256 i; i < n; ++i) {
            ICreditVoter.Line memory info = voter.line(i);
            LineState memory l = _describe(info);
            l.active = info.active;
            if (info.kind == ICreditVoter.LineKind.Morpho) {
                l.ids = new bytes32[](3);
                l.ids[0] = LineIds.adapterId(info.adapter);
                l.ids[1] = LineIds.collateralId(l.params.collateralToken);
                l.ids[2] = l.ownId;
                l.eligible = info.active && _quotes(l.params.oracle, IOracle.price.selector);
            } else {
                bool live;
                (l.ids, live) = _suretyLineState(ISuretyLine(info.adapter));
                l.eligible = info.active && live;
            }
            lines[i] = l;
        }
    }

    /// @dev A veBTC line's cap ids and whether it can take new money (not paused, live oracle). Each call is guarded,
    /// so a line whose calls revert reports no ids and is not live: it only makes itself ineligible.
    function _suretyLineState(ISuretyLine suretyLine) internal view returns (bytes32[] memory ids, bool live) {
        try suretyLine.ids() returns (bytes32[] memory lineIds) {
            ids = lineIds;
        } catch {
            return (ids, live);
        }
        try suretyLine.paused() returns (bool paused) {
            if (paused) return (ids, live);
        } catch {
            return (ids, live);
        }
        try suretyLine.oracle() returns (IPriceSource source) {
            live = _quotes(address(source), IPriceSource.priceWad.selector);
        } catch {}
    }

    /// @dev Adapter, data, kind and the ids that identify the line's position.
    function _describe(ICreditVoter.Line memory info) internal pure returns (LineState memory l) {
        l.adapter = info.adapter;
        l.data = info.data;
        l.kind = info.kind;
        if (info.kind == ICreditVoter.LineKind.Morpho) {
            l.params = abi.decode(info.data, (MarketParams));
            l.marketId = Id.unwrap(l.params.id());
            l.ownId = LineIds.marketParamsId(info.adapter, l.params);
        } else {
            l.ownId = LineIds.adapterId(info.adapter);
        }
    }

    /// @dev Whether `source` answers `selector` with a non-zero price. Reverts and malformed or empty answers
    /// (including from addresses without code) count as no price.
    function _quotes(address source, bytes4 selector) internal view returns (bool) {
        (bool ok, bytes memory ret) = source.staticcall(abi.encodeWithSelector(selector));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) != 0;
    }

    function _assetsOf(LineState memory l) internal view returns (uint256) {
        if (l.kind == ICreditVoter.LineKind.VeBTC) return ISuretyLine(l.adapter).realAssets();
        return IMorphoMarketV1AdapterV2(l.adapter).expectedSupplyAssets(l.marketId);
    }

    /// @dev What the line can pay back to the vault right now, out of `assets`.
    function _withdrawable(LineState memory l, uint256 assets) internal view returns (uint256) {
        if (l.kind == ICreditVoter.LineKind.VeBTC) {
            try ISuretyLine(l.adapter).cash() returns (uint256 cash) {
                return Math.min(assets, cash);
            } catch {
                return 0;
            }
        }
        // Accruing raises supply and borrow by the same interest, so the stored difference is the live liquidity.
        Market memory m = IMorpho(IMorphoMarketV1AdapterV2(l.adapter).morpho()).market(Id.wrap(l.marketId));
        uint256 free = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
        return Math.min(assets, free);
    }

    /* Internals: targets */

    /// @dev Previous epoch if an active line got votes in it, else the current epoch (bootstrap).
    function _tallyEpoch(uint256 epoch, LineState[] memory lines) internal view returns (uint256) {
        if (epoch < EPOCH_LENGTH) return epoch;
        uint256 previous = epoch - EPOCH_LENGTH;
        for (uint256 i; i < lines.length; ++i) {
            if (lines[i].active && voter.lineVotes(previous, i) != 0) return previous;
        }
        return epoch;
    }

    /// @dev Splits the deployable assets over active lines by their votes in `tallyEpoch`, then caps each share by
    /// the room its ids leave once the other lines have given back what they hold above their own shares, and holds
    /// lines that cannot take new money at what they have. Votes of inactive lines are left out of the denominator
    /// (the tally's total includes them).
    function _setTargets(LineState[] memory lines, uint256 tallyEpoch, uint256 total, uint256 firstTotal)
        internal
        view
    {
        uint256 n = lines.length;
        uint256 votesSum = 0;
        for (uint256 i; i < n; ++i) {
            if (!lines[i].active) continue;
            lines[i].votes = voter.lineVotes(tallyEpoch, i);
            votesSum += lines[i].votes;
        }
        uint256 deployable = Math.mulDiv(total, BPS - idleBufferBps, BPS);
        for (uint256 i; i < n; ++i) {
            LineState memory l = lines[i];
            if (l.votes != 0) l.share = Math.mulDiv(deployable, l.votes, votesSum);
            l.release = _floorSub(vault.allocation(l.ownId), l.share);
        }
        for (uint256 i; i < n; ++i) {
            LineState memory l = lines[i];
            if (l.share == 0) continue;
            l.target = Math.min(l.share, _maxPosition(lines, i, firstTotal));
            if (!l.eligible) l.target = Math.min(l.target, _assetsOf(l));
        }
    }

    /// @dev Largest position the vault's caps allow for line `i`. Mirrors VaultV2's allocate checks: per id,
    /// `allocation <= absoluteCap` and, unless the relative cap is 100%, `allocation <= firstTotalAssets *
    /// relativeCap`. On an id shared with other lines (the Morpho adapter id, a collateral id), their part is the id's
    /// recorded allocation minus this line's own, less what they are expected to release.
    function _maxPosition(LineState[] memory lines, uint256 i, uint256 firstTotal)
        internal
        view
        returns (uint256 maxPosition)
    {
        LineState memory l = lines[i];
        maxPosition = type(uint256).max;
        uint256 own = vault.allocation(l.ownId);
        for (uint256 k; k < l.ids.length; ++k) {
            bytes32 id = l.ids[k];
            uint256 cap = vault.absoluteCap(id);
            uint256 relativeCap = vault.relativeCap(id);
            if (relativeCap < WAD) cap = Math.min(cap, Math.mulDiv(firstTotal, relativeCap, WAD));
            uint256 others = id == l.ownId ? 0 : _floorSub(vault.allocation(id), own + _releasedOn(lines, i, id));
            maxPosition = Math.min(maxPosition, _floorSub(cap, others));
        }
    }

    /// @dev What lines other than `i` that count against `id` are expected to release.
    function _releasedOn(LineState[] memory lines, uint256 i, bytes32 id) internal pure returns (uint256 released) {
        for (uint256 j; j < lines.length; ++j) {
            if (j == i || lines[j].release == 0) continue;
            bytes32[] memory ids = lines[j].ids;
            for (uint256 k; k < ids.length; ++k) {
                if (ids[k] == id) {
                    released += lines[j].release;
                    break;
                }
            }
        }
    }

    /* Internals: moves */

    function _deallocateOverweight(LineState[] memory lines) internal {
        for (uint256 i; i < lines.length; ++i) {
            LineState memory l = lines[i];
            uint256 assets = _assetsOf(l);
            if (assets <= l.target + l.target / MOVE_TOLERANCE) continue;
            uint256 amount = Math.min(assets - l.target, _withdrawable(l, assets));
            if (amount != 0) _move(i, l, amount, false);
        }
    }

    /// @dev Funds underweight lines in id order from the vault's cash above the buffer: idle MUSD plus what is
    /// parked in savings, withdrawn from savings just before the allocation that needs it. Caps are re-read before
    /// each move against the allocations the deallocations actually left, so lines contending for a shared cap are
    /// served in id order and a line that could not release does not let another overshoot. If savings cannot pay,
    /// lines are funded from idle MUSD above the buffer only.
    /// @return savingsPaid False if a withdrawal from savings failed.
    function _allocateUnderweight(LineState[] memory lines, uint256 total, uint256 firstTotal)
        internal
        returns (bool savingsPaid)
    {
        savingsPaid = true;
        for (uint256 j; j < lines.length; ++j) {
            lines[j].release = 0;
        }
        uint256 buffer = Math.mulDiv(total, idleBufferBps, BPS);
        uint256 parked = parking ? ISavingsAdapter(savings).realAssets() : 0;
        uint256 available = _floorSub(asset.balanceOf(address(vault)) + parked, buffer);
        for (uint256 i = 0; i < lines.length && available != 0; ++i) {
            LineState memory l = lines[i];
            if (l.target == 0) continue;
            uint256 goal = Math.min(l.target, _maxPosition(lines, i, firstTotal));
            uint256 assets = _assetsOf(l);
            if (assets + goal / MOVE_TOLERANCE >= goal) continue;
            uint256 amount = Math.min(goal - assets, available);
            uint256 idle = asset.balanceOf(address(vault));
            if (amount > idle && parked != 0) {
                uint256 pull = Math.min(amount - idle, parked);
                if (_moveSavings(pull, false)) {
                    parked -= pull;
                    idle += pull;
                } else {
                    savingsPaid = false;
                    parked = 0;
                    available = Math.min(available, _floorSub(idle, buffer));
                }
            }
            amount = Math.min(amount, Math.min(available, idle));
            if (amount != 0 && _move(i, l, amount, true)) available -= amount;
        }
    }

    /// @dev With parking on, parks all idle MUSD in savings, unless savings failed to pay in this run (idle MUSD then
    /// stays liquid); with it off, brings everything in savings back to idle.
    function _settleSavings(bool savingsPaid) internal {
        address adapter = savings;
        if (adapter == address(0)) return;
        if (parking) {
            if (!savingsPaid) return;
            uint256 idle = asset.balanceOf(address(vault));
            if (idle != 0) _moveSavings(idle, true);
        } else {
            uint256 parked = ISavingsAdapter(adapter).realAssets();
            if (parked != 0) _moveSavings(parked, false);
        }
    }

    /// @dev One VaultV2 allocate/deallocate on savings; a rejection is reported, not propagated.
    function _moveSavings(uint256 assets, bool allocation) internal returns (bool) {
        address adapter = savings;
        if (allocation) {
            try vault.allocate(adapter, "", assets) {
                return true;
            } catch (bytes memory reason) {
                emit SavingsMoveFailed(true, assets, reason);
            }
        } else {
            try vault.deallocate(adapter, "", assets) {
                return true;
            } catch (bytes memory reason) {
                emit SavingsMoveFailed(false, assets, reason);
            }
        }
        return false;
    }

    function _setParking(bool on) internal {
        parking = on;
        emit ParkingSet(on);
        vault.setLiquidityAdapterAndData(on ? savings : address(0), "");
    }

    /// @dev True without a peg; otherwise the monitor's `pegHealthy()`, with a failed or malformed answer read as
    /// unhealthy.
    function _pegHealthy() internal view returns (bool) {
        address monitor = address(peg);
        if (monitor == address(0)) return true;
        (bool ok, bytes memory ret) = monitor.staticcall(abi.encodeCall(IMusdPeg.pegHealthy, ()));
        return ok && ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }

    /// @dev One VaultV2 allocate/deallocate. A rejection is reported, not propagated, so one broken line cannot
    /// block the others or fee attribution.
    function _move(uint256 lineId, LineState memory l, uint256 assets, bool allocation) internal returns (bool) {
        if (allocation) {
            try vault.allocate(l.adapter, l.data, assets) {
                return true;
            } catch (bytes memory reason) {
                emit MoveFailed(lineId, true, assets, reason);
            }
        } else {
            try vault.deallocate(l.adapter, l.data, assets) {
                return true;
            } catch (bytes memory reason) {
                emit MoveFailed(lineId, false, assets, reason);
            }
        }
        return false;
    }

    /* Internals: interest */

    /// @dev Has the pool record each line's new losses. Covers every listed line, so a line's loss mark is set from
    /// its first rebalance on. Skipped while no pool is set.
    function _checkpointLosses(uint256 n) internal {
        address pool = suretyPool;
        if (pool == address(0)) return;
        for (uint256 i; i < n; ++i) {
            try ISuretyPool(pool).checkpoint(i) {}
            catch (bytes memory reason) {
                emit CheckpointFailed(i, reason);
            }
        }
    }

    /// @dev Interest of each tracked line since the previous rebalance's snapshot, added to its pending interest.
    /// Untracked (newly listed) lines report zero.
    function _measure(LineState[] memory lines) internal returns (uint256[] memory interest) {
        uint256 n = lines.length;
        uint256 tracked = trackedLines;
        interest = new uint256[](n);
        for (uint256 i = 0; i < n && i < tracked; ++i) {
            interest[i] = _interestSince(lines[i], ledgers[i]);
            ledgers[i].pendingInterest += interest[i];
        }
    }

    /// @dev Morpho: the snapshot's shares valued at the market's accrued supply share price minus their value at the
    /// snapshot's price, floored at zero. veBTC: the increase of the line's interest counter.
    function _interestSince(LineState memory l, Ledger storage book) internal view returns (uint256) {
        if (l.kind == ICreditVoter.LineKind.Morpho) {
            uint256 shares = book.shares;
            if (shares == 0) return 0;
            (uint256 supplyAssets, uint256 supplyShares) = _supplyTotals(l);
            uint256 valueNow = shares.toAssetsDown(supplyAssets, supplyShares);
            uint256 valueThen = shares.toAssetsDown(book.totalSupplyAssets, book.totalSupplyShares);
            return _floorSub(valueNow, valueThen);
        }
        (bool ok, uint256 earned) = _earnedOf(l.adapter);
        return ok ? _floorSub(earned, book.earned) : 0;
    }

    /// @dev Adds the savings yield since the counter's highest value to the pending interest. The counter is
    /// measured before the moves and not again after them: moves do not change it, and yield sMUSD distributes
    /// during them is then measured by the next run. A counter that cannot be read waits for a later run.
    function _measureSavings() internal {
        address adapter = savings;
        if (adapter == address(0)) return;
        (bool ok, uint256 earned) = _earnedOf(adapter);
        Ledger storage book = savingsBook;
        if (!ok || earned <= book.earned) return;
        book.pendingInterest += earned - book.earned;
        book.earned = earned;
    }

    /// @dev Snapshots every line after the moves: Morpho shares and share price, veBTC interest counter.
    function _snapshot(LineState[] memory lines)
        internal
        returns (uint256[] memory lineIds, uint256[] memory targetAssets)
    {
        uint256 n = lines.length;
        lineIds = new uint256[](n);
        targetAssets = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            LineState memory l = lines[i];
            lineIds[i] = i;
            targetAssets[i] = l.target;
            Ledger storage book = ledgers[i];
            if (l.kind == ICreditVoter.LineKind.Morpho) {
                (uint256 supplyAssets, uint256 supplyShares) = _supplyTotals(l);
                book.shares = IMorphoMarketV1AdapterV2(l.adapter).supplyShares(l.marketId);
                book.totalSupplyAssets = SafeCast.toUint128(supplyAssets);
                book.totalSupplyShares = SafeCast.toUint128(supplyShares);
            } else {
                // A line whose counter cannot be read keeps its old snapshot; it is measured from there once it can.
                (bool ok, uint256 earned) = _earnedOf(l.adapter);
                if (ok) book.earned = earned;
            }
        }
        trackedLines = n;
    }

    /// @dev The market's supply totals after interest accrual, as Morpho would compute them now.
    function _supplyTotals(LineState memory l) internal view returns (uint256 supplyAssets, uint256 supplyShares) {
        IMorpho morpho = IMorpho(IMorphoMarketV1AdapterV2(l.adapter).morpho());
        (supplyAssets, supplyShares,,) = morpho.expectedMarketBalances(l.params);
    }

    /// @dev A veBTC line's or the savings adapter's interest counter; `ok` is false if the call reverts or returns
    /// something malformed.
    function _earnedOf(address adapter) internal view returns (bool ok, uint256 earned) {
        bytes memory ret;
        (ok, ret) = adapter.staticcall(abi.encodeCall(ISuretyLine.interestEarnedTotal, ()));
        ok = ok && ret.length == 32;
        if (ok) earned = abi.decode(ret, (uint256));
    }

    /// @dev First rebalance of `epoch`: hands the pending interest to the pool for the cohort whose tally drove the
    /// allocation until now, then switches to `tallyEpoch`. With savings set, its yield follows the lines' interest
    /// under SAVINGS_LINE_ID. Skipped (interest dropped) on the very first rebalance and while no pool is set.
    function _closeEpoch(uint256 epoch, uint256 tallyEpoch, uint256[] memory lineIds) internal {
        uint256 cohortEpoch = activeTallyEpoch;
        address pool = suretyPool;
        bool attribute = lastRebalanceEpoch != 0 && pool != address(0);
        bool withSavings = savings != address(0);

        uint256 n = lineIds.length;
        uint256[] memory earned = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            earned[i] = ledgers[i].pendingInterest;
            ledgers[i].pendingInterest = 0;
        }
        uint256 savingsInterest = savingsBook.pendingInterest;
        savingsBook.pendingInterest = 0;
        activeTallyEpoch = tallyEpoch;
        lastRebalanceEpoch = epoch;

        if (!attribute) return;
        emit InterestAttributed(cohortEpoch, lineIds, earned);
        if (!withSavings) {
            ISuretyPool(pool).distributeFees(cohortEpoch, lineIds, earned);
            return;
        }
        emit SavingsInterestAttributed(cohortEpoch, savingsInterest);
        uint256[] memory ids = new uint256[](n + 1);
        uint256[] memory amounts = new uint256[](n + 1);
        for (uint256 i; i < n; ++i) {
            ids[i] = lineIds[i];
            amounts[i] = earned[i];
        }
        ids[n] = SAVINGS_LINE_ID;
        amounts[n] = savingsInterest;
        ISuretyPool(pool).distributeFees(cohortEpoch, ids, amounts);
    }

    function _floorSub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
    // forge-lint: disable-end(calls-loop, reentrancy-events, reentrancy-no-eth)
}
