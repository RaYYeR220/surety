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
import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE, WAD} from "vault-v2/libraries/ConstantsLib.sol";

import {ICreditVoter} from "./interfaces/ICreditVoter.sol";
import {IPriceSource} from "./interfaces/IPriceSource.sol";
import {ISuretyLine} from "./interfaces/ISuretyLine.sol";
import {ISuretyPool} from "./interfaces/ISuretyPool.sol";
import {IVoteAllocator} from "./interfaces/IVoteAllocator.sol";
import {LineIds} from "./libraries/LineIds.sol";

/// @notice VaultV2 cap ids a Surety-native line reports on allocate/deallocate (VeBTCCreditLine.ids()).
interface ILineCapIds {
    function ids() external view returns (bytes32[] memory);
}

/// @title VoteAllocator
/// @notice Holds the Surety vault's allocator role and sizes each credit line from CreditVoter tallies, then
/// measures what each line earned so the SuretyPool can split the voters' fee shares by line.
/// @dev
/// Timeline: votes cast in epoch t drive the allocation from the first rebalance of t+1, and the interest the lines
/// earn while that allocation is live is attributed to cohort t at the first rebalance of t+2.
/// - Tally: the first rebalance of an epoch fixes it for the epoch: the previous epoch if any eligible line got votes
///   in it, else the current epoch (bootstrap; its tally can still change, so re-runs follow it).
/// - Targets: `deployable = totalAssets * (1 - idleBuffer)` split by the tally over eligible lines (active, live
///   oracle, veBTC line not paused), each capped by the room the VaultV2 absolute and relative caps of its ids leave
///   once the other lines have shrunk to their shares. Ineligible or unvoted lines target zero. When several lines
///   grow into one shared cap, targets are upper bounds: caps are re-checked before each allocation, in line order.
/// - Moves: overweight lines are deallocated first, bounded by what they can pay out now (Morpho market liquidity,
///   veBTC line cash), then underweight lines are allocated from idle assets above the buffer. Nothing reverts on an
///   illiquid line; a re-run inside the epoch continues the move. A move the vault rejects is skipped and reported.
/// - Interest: each rebalance measures `assets - baseline` per line, where the baseline is the line's assets after
///   the previous rebalance moved by the adjustments the pool noted since (losses down, covers up). Drops are not
///   negative interest; they are kept as unexplained loss that a later noted loss is netted against first.
///   Interest accumulates until the first rebalance of the next epoch hands it to `SuretyPool.distributeFees`.
///   This assumes the allocator is the vault's only allocator and no liquidity adapter is set: capital moved by
///   anyone else reads as interest (in) or as an unexplained drop (out).
/// Trust: the only capital moves are VaultV2 `allocate` / `deallocate` with the adapter and data the CreditVoter lists
/// for a line. VaultV2 rejects addresses that are not its adapters and enforces the caps; tokens never pass through
/// this contract. The owner can only set the pool once and set the vault's max rate within VaultV2's bound.
contract VoteAllocator is IVoteAllocator, Ownable2Step, ReentrancyGuardTransient {
    using MarketParamsLib for MarketParams;

    // Looping over lines with external calls is the job: the list is short and curated, and every call goes to the
    // vault, the voter, the pool or a listed line's adapter, market or oracle. rebalance is nonReentrant and re-bases
    // the ledger after its moves on purpose. noteAdjustment, the only other ledger writer, is reserved to the pool and
    // deliberately outside the lock, so the pool can record losses from inside rebalance before interest is measured.
    // Events after those calls report what the calls did.
    // forge-lint: disable-start(calls-loop, reentrancy-events, reentrancy-no-eth)

    /// @param baseline Assets the line would hold had it earned nothing since the last rebalance.
    /// @param pendingInterest Interest measured since the last attribution.
    /// @param unexplainedLoss Asset drops measured but not yet matched by a loss noted by the pool.
    struct Ledger {
        int256 baseline;
        uint256 pendingInterest;
        uint256 unexplainedLoss;
    }

    /// @dev A line as one rebalance sees it.
    /// @param marketId Morpho market id (Morpho lines only).
    /// @param ownId Cap id no other line uses: the market id for Morpho lines, the adapter id for veBTC lines.
    /// @param ids Every cap id an allocation to the line counts against.
    /// @param share Vote-weighted slice of the deployable assets (zero when ineligible or unvoted).
    /// @param release Allocation the line is expected to give back this run: its recorded allocation above `share`.
    /// @param target `share` capped by the room the vault's caps leave.
    struct LineState {
        address adapter;
        bytes data;
        ICreditVoter.LineKind kind;
        bytes32 marketId;
        bytes32 ownId;
        bytes32[] ids;
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

    /// @notice Receives fee attributions and notes loss/cover adjustments. Set once.
    address public suretyPool;
    /// @inheritdoc IVoteAllocator
    uint256 public activeTallyEpoch;
    /// @notice Epoch of the last rebalance; zero before the first one.
    uint256 public lastRebalanceEpoch;
    /// @notice Lines with a baseline (ids below this). Lines listed later join at their next rebalance.
    uint256 public trackedLines;

    mapping(uint256 lineId => Ledger) internal ledgers;

    /// @param interest Interest each line earned since the previous rebalance.
    event Rebalanced(
        uint256 indexed epoch, uint256 indexed tallyEpoch, uint256[] lineIds, uint256[] targets, uint256[] interest
    );
    /// @notice Interest handed to the pool for the fee shares of `cohortEpoch`.
    event InterestAttributed(uint256 indexed cohortEpoch, uint256[] lineIds, uint256[] interest);
    /// @notice The vault rejected a move; capital stays where it is until a later rebalance.
    event MoveFailed(uint256 indexed lineId, bool allocation, uint256 assets, bytes reason);
    event AdjustmentNoted(uint256 indexed lineId, int256 delta);
    event SuretyPoolSet(address indexed pool);
    event MaxRateSet(uint256 maxRate);

    error ZeroAddress();
    error BadIdleBuffer();
    error SuretyPoolAlreadySet();
    error NotSuretyPool();
    error MaxRateTooHigh();

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

    /* Pool */

    /// @inheritdoc IVoteAllocator
    /// @dev Only the SuretyPool: negative after it records a loss, positive after it pays a cover into the line.
    /// Applied to the baseline at once, so a note made inside `rebalance` before interest is measured (a loss
    /// checkpoint) counts in that same call; not guarded by the rebalance lock for that reason. A loss is first
    /// netted against drops already measured as unexplained. Notes for lines not tracked yet are ignored: their
    /// first rebalance takes their assets as they are.
    function noteAdjustment(uint256 lineId, int256 delta) external {
        if (msg.sender != suretyPool) revert NotSuretyPool();
        emit AdjustmentNoted(lineId, delta);
        if (lineId >= trackedLines) return;

        Ledger storage book = ledgers[lineId];
        if (delta >= 0) {
            book.baseline += delta;
            return;
        }
        uint256 loss = SafeCast.toUint256(-delta);
        uint256 absorbed = Math.min(loss, book.unexplainedLoss);
        book.unexplainedLoss -= absorbed;
        book.baseline -= SafeCast.toInt256(loss - absorbed);
    }

    /* Rebalance */

    /// @notice Moves vault capital toward the vote-weighted targets and, on the first call of an epoch, hands the
    /// interest earned since the last attribution to the pool. Permissionless and safe to re-run.
    function rebalance() external nonReentrant {
        vault.accrueInterest();
        uint256 epoch = voter.currentEpoch();
        LineState[] memory lines = _loadLines();
        uint256[] memory interest = _measure(lines);

        bool newEpoch = epoch > lastRebalanceEpoch;
        uint256 tallyEpoch = newEpoch ? _tallyEpoch(epoch, lines) : activeTallyEpoch;
        uint256 total = vault.totalAssets();
        uint256 firstTotal = vault.firstTotalAssets();
        _setTargets(lines, tallyEpoch, total, firstTotal);
        _deallocateOverweight(lines);
        _allocateUnderweight(lines, total, firstTotal);

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

    /// @notice Interest ledger of `lineId`.
    function ledger(uint256 lineId)
        external
        view
        returns (int256 baseline, uint256 pendingInterest, uint256 unexplainedLoss)
    {
        Ledger storage l = ledgers[lineId];
        return (l.baseline, l.pendingInterest, l.unexplainedLoss);
    }

    /* Internals: lines */

    function _loadLines() internal view returns (LineState[] memory lines) {
        uint256 n = voter.lineCount();
        lines = new LineState[](n);
        for (uint256 i; i < n; ++i) {
            ICreditVoter.Line memory info = voter.line(i);
            LineState memory l = _describe(info);
            if (info.kind == ICreditVoter.LineKind.Morpho) {
                MarketParams memory params = abi.decode(info.data, (MarketParams));
                l.ids = new bytes32[](3);
                l.ids[0] = LineIds.adapterId(info.adapter);
                l.ids[1] = LineIds.collateralId(params.collateralToken);
                l.ids[2] = l.ownId;
                l.eligible = info.active && _quotes(params.oracle, IOracle.price.selector);
            } else {
                ISuretyLine suretyLine = ISuretyLine(info.adapter);
                l.ids = ILineCapIds(info.adapter).ids();
                l.eligible = info.active && !suretyLine.paused()
                    && _quotes(address(suretyLine.oracle()), IPriceSource.priceWad.selector);
            }
            lines[i] = l;
        }
    }

    /// @dev Adapter, data, kind and the ids that identify the line's position.
    function _describe(ICreditVoter.Line memory info) internal pure returns (LineState memory l) {
        l.adapter = info.adapter;
        l.data = info.data;
        l.kind = info.kind;
        if (info.kind == ICreditVoter.LineKind.Morpho) {
            MarketParams memory params = abi.decode(info.data, (MarketParams));
            l.marketId = Id.unwrap(params.id());
            l.ownId = LineIds.marketParamsId(info.adapter, params);
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
        if (l.kind == ICreditVoter.LineKind.VeBTC) return Math.min(assets, ISuretyLine(l.adapter).cash());
        // Accruing raises supply and borrow by the same interest, so the stored difference is the live liquidity.
        Market memory m = IMorpho(IMorphoMarketV1AdapterV2(l.adapter).morpho()).market(Id.wrap(l.marketId));
        uint256 free = m.totalSupplyAssets > m.totalBorrowAssets ? m.totalSupplyAssets - m.totalBorrowAssets : 0;
        return Math.min(assets, free);
    }

    /* Internals: targets */

    /// @dev Previous epoch if an eligible line got votes in it, else the current epoch (bootstrap).
    function _tallyEpoch(uint256 epoch, LineState[] memory lines) internal view returns (uint256) {
        if (epoch < EPOCH_LENGTH) return epoch;
        uint256 previous = epoch - EPOCH_LENGTH;
        for (uint256 i; i < lines.length; ++i) {
            if (lines[i].eligible && voter.lineVotes(previous, i) != 0) return previous;
        }
        return epoch;
    }

    /// @dev Splits the deployable assets over eligible lines by their votes in `tallyEpoch`, then caps each share by
    /// the room its ids leave once the other lines have given back what they hold above their own shares.
    /// Votes of ineligible lines are left out of the denominator (the tally's total includes them).
    function _setTargets(LineState[] memory lines, uint256 tallyEpoch, uint256 total, uint256 firstTotal)
        internal
        view
    {
        uint256 n = lines.length;
        uint256 votesSum = 0;
        for (uint256 i; i < n; ++i) {
            if (!lines[i].eligible) continue;
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
            if (lines[i].share != 0) lines[i].target = Math.min(lines[i].share, _maxPosition(lines, i, firstTotal));
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

    /// @dev Funds underweight lines in id order from idle assets above the buffer. Caps are re-read before each move
    /// against the allocations the deallocations actually left, so lines contending for a shared cap are served in
    /// id order and a line that could not release does not let another overshoot.
    function _allocateUnderweight(LineState[] memory lines, uint256 total, uint256 firstTotal) internal {
        for (uint256 j; j < lines.length; ++j) {
            lines[j].release = 0;
        }
        uint256 available = _floorSub(asset.balanceOf(address(vault)), Math.mulDiv(total, idleBufferBps, BPS));
        for (uint256 i = 0; i < lines.length && available != 0; ++i) {
            LineState memory l = lines[i];
            if (l.target == 0) continue;
            uint256 goal = Math.min(l.target, _maxPosition(lines, i, firstTotal));
            uint256 assets = _assetsOf(l);
            if (assets + goal / MOVE_TOLERANCE >= goal) continue;
            uint256 amount = Math.min(goal - assets, available);
            if (_move(i, l, amount, true)) available -= amount;
        }
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

    /// @dev Interest of each tracked line since the previous rebalance, added to its pending interest. Drops are
    /// recorded as unexplained loss instead. Untracked (newly listed) lines report zero.
    function _measure(LineState[] memory lines) internal returns (uint256[] memory interest) {
        uint256 n = lines.length;
        uint256 tracked = trackedLines;
        interest = new uint256[](n);
        for (uint256 i = 0; i < n && i < tracked; ++i) {
            Ledger storage book = ledgers[i];
            int256 delta = SafeCast.toInt256(_assetsOf(lines[i])) - book.baseline;
            if (delta >= 0) {
                interest[i] = SafeCast.toUint256(delta);
                book.pendingInterest += interest[i];
            } else {
                book.unexplainedLoss += SafeCast.toUint256(-delta);
            }
        }
    }

    /// @dev Re-bases every line on its assets after the moves.
    function _snapshot(LineState[] memory lines)
        internal
        returns (uint256[] memory lineIds, uint256[] memory targetAssets)
    {
        uint256 n = lines.length;
        lineIds = new uint256[](n);
        targetAssets = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            lineIds[i] = i;
            targetAssets[i] = lines[i].target;
            ledgers[i].baseline = SafeCast.toInt256(_assetsOf(lines[i]));
        }
        trackedLines = n;
    }

    /// @dev First rebalance of `epoch`: hands the pending interest to the pool for the cohort whose tally drove the
    /// allocation until now, then switches to `tallyEpoch`. Skipped (interest dropped) on the very first rebalance
    /// and while no pool is set.
    function _closeEpoch(uint256 epoch, uint256 tallyEpoch, uint256[] memory lineIds) internal {
        uint256 cohortEpoch = activeTallyEpoch;
        address pool = suretyPool;
        bool attribute = lastRebalanceEpoch != 0 && pool != address(0);

        uint256[] memory earned = new uint256[](lineIds.length);
        for (uint256 i; i < lineIds.length; ++i) {
            earned[i] = ledgers[i].pendingInterest;
            ledgers[i].pendingInterest = 0;
        }
        activeTallyEpoch = tallyEpoch;
        lastRebalanceEpoch = epoch;

        if (!attribute) return;
        emit InterestAttributed(cohortEpoch, lineIds, earned);
        ISuretyPool(pool).distributeFees(cohortEpoch, lineIds, earned);
    }

    function _floorSub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }
    // forge-lint: disable-end(calls-loop, reentrancy-events, reentrancy-no-eth)
}
