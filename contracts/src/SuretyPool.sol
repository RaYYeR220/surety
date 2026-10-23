// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Id, IMorpho, Market, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {SharesMathLib} from "morpho-blue/libraries/SharesMathLib.sol";
import {MorphoBalancesLib} from "morpho-blue/libraries/periphery/MorphoBalancesLib.sol";
import {IMorphoMarketV1AdapterV2} from "vault-v2/adapters/interfaces/IMorphoMarketV1AdapterV2.sol";
import {IAdapter} from "vault-v2/interfaces/IAdapter.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {ICreditVoter} from "./interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "./interfaces/IEscrowRegistry.sol";
import {ISuretyLine} from "./interfaces/ISuretyLine.sol";
import {ISuretyPool} from "./interfaces/ISuretyPool.sol";
import {IVeBTC} from "./interfaces/IVeBTC.sol";
import {EpochLib} from "./libraries/EpochLib.sol";
import {LineIds} from "./libraries/LineIds.sol";

/// @title SuretyPool
/// @notice Voter rewards as first loss. Rewards for backing a credit line (sponsor incentives and the vault's
/// performance fee) are held as vault shares in cohorts keyed by (line, tally epoch). A cohort seasons until
/// `maturityOf(epoch)`; until then it is slashed first when its line records a loss, then the shared reserve, and
/// lenders bear whatever is left. Matured cohorts are never slashed and are claimed pro rata to each NFT's votes.
/// @dev
/// - Cohort `(L, t)` collects incentives posted during epoch `t` and the fee shares the allocator attributes to the
///   votes of tally epoch `t`. Its shares stay in the vault and keep compounding.
/// - A cohort is slashable while unmatured and backed (`lineVotes(t, L) > 0`); at most SEASON + 2 epochs per line
///   are unmatured. Matured cohorts take no inflows (late fees go to the reserve), so the share count a cohort holds
///   at maturity is final; it is frozen into `finalShares` at the first claim.
/// - Claims go to the NFT's current owner, or to the borrower when the owner is a Surety loan escrow. Claims for a
///   burned NFT (merged or withdrawn; `ownerOf == 0`) are credited to the reserve.
/// - Losses: Morpho lines are measured from the market's supply share price against the mark of the line's last
///   checkpoint (price and the adapter's shares then); the veBTC line reports its cumulative bad debt. `cover`
///   covers at most the recorded loss and sizes the MUSD it moves so that, once VaultV2 has re-recognised it, lenders
///   are back at the pre-loss share price and the pool bears exactly the loss (see `cover`). The fee shares VaultV2 mints on the re-recognised MUSD go
///   back to whoever the cover slashed, so the slashed cohorts themselves net exactly the loss.
/// - Covering a Morpho line returns the redeemed MUSD to the vault as idle assets, because
///   MorphoMarketV1AdapterV2 values its position from its own supply-share ledger and a Morpho supply made on its
///   behalf would be stranded. Covering the veBTC line pays it through `receiveCover`.
/// - The owner can only set the allocator, once. No function moves pool shares or MUSD except to a claimant, a
///   refunded sponsor, or a covered line.
contract SuretyPool is ISuretyPool, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using MarketParamsLib for MarketParams;
    using SharesMathLib for uint256;
    using MorphoBalancesLib for IMorpho;

    // Every state-changing entry point is nonReentrant, and state is final before shares or MUSD leave the pool.
    // Events that follow an external call follow reads of fixed contracts (vault, voter, Morpho, a line).
    // forge-lint: disable-start(reentrancy-events)

    /// @param shares Vault shares currently held for the cohort.
    /// @param finalShares Shares at maturity, set at the first claim; claims are pro rata to it.
    /// @param frozen Whether `finalShares` is set.
    struct Cohort {
        uint256 shares;
        uint256 finalShares;
        bool frozen;
    }

    /// @notice A Morpho line's state at its last checkpoint: the market's supply totals (its supply share price) and
    /// the adapter's supply shares in the market. Every checkpoint moves it to the current state after measuring.
    /// @param set Whether a checkpoint has run; losses before the first one are not measured.
    /// @param adapterShares The adapter's supply shares at the checkpoint (the VoteAllocator checkpoints again after
    /// its own moves, so this is current except for moves made by others, such as VaultV2's `forceDeallocate`).
    struct HighWaterMark {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        bool set;
        uint256 adapterShares;
    }

    /// @notice The fee shares VaultV2 owes back on one cover: it mints its performance fee on the cover's MUSD as it
    /// re-recognises it, and those shares go to the cohorts the cover slashed, pro rata to what each paid.
    /// @param lineId The covered line.
    /// @param unrecognised MUSD of the cover not re-recognised yet, as far as the pool can tell.
    /// @param burned Vault shares the cover burned (cohorts and reserve).
    /// @param epochs Slashed cohorts' epochs, with `cuts` the shares each lost; the reserve paid the rest of `burned`.
    struct CoverFee {
        uint256 lineId;
        uint256 unrecognised;
        uint256 burned;
        uint256[] epochs;
        uint256[] cuts;
    }

    /// @notice Covers whose fee shares one `distributeFees` credits at most (the rest wait for the next one).
    uint256 public constant MAX_COVER_FEES_PER_DISTRIBUTION = 8;
    /// @notice Morpho losses at or below this many MUSD wei are not recorded (Morpho's supply share price never falls
    /// through rounding, so a drop is always bad debt; a dust-sized one is ignored).
    uint256 public constant LOSS_DUST = 1e12;
    uint256 public constant MAX_SEASON = 52;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    /// @notice Cover MUSD still awaiting re-recognition, as a share of total assets, below which deposits reopen.
    uint256 public constant RECOGNITION_TOLERANCE_BPS = 5;

    IVaultV2 public immutable vault;
    ICreditVoter public immutable voter;
    IVeBTC public immutable veBTC;
    IERC20 public immutable musd;
    IMorpho public immutable morpho;
    /// @notice The MorphoMarketV1AdapterV2 every Morpho line allocates through.
    address public immutable morphoAdapter;
    /// @notice Loan escrow registry (the veBTC credit line); zero disables the escrow lookup.
    IEscrowRegistry public immutable escrows;
    /// @notice Epochs a cohort seasons after the two-epoch lag between a tally and its fee attribution.
    uint256 public immutable SEASON;
    uint256 public immutable EPOCH_LENGTH;

    /// @notice The VoteAllocator: the only caller of `distributeFees`.
    address public allocator;
    /// @notice Shares backing every line's losses after its cohorts; never claimable.
    uint256 public reserveShares;
    /// @notice Shares attributed to cohorts or the reserve. Vault shares above this are fees not yet distributed.
    uint256 public accountedShares;

    mapping(uint256 lineId => mapping(uint256 epoch => Cohort)) internal cohorts;
    /// @notice Incentive shares posted into a cohort and not yet refunded.
    mapping(uint256 lineId => mapping(uint256 epoch => uint256)) public incentiveShares;
    mapping(uint256 lineId => mapping(uint256 epoch => mapping(address sponsor => uint256))) public sponsorShares;
    mapping(uint256 epoch => mapping(uint256 lineId => mapping(uint256 tokenId => bool))) internal claimed;
    /// @notice Cumulative loss recorded per line, in MUSD.
    mapping(uint256 lineId => uint256) public lossRecorded;
    /// @notice Cumulative loss covered per line, in the MUSD units of `lossRecorded` (see `cover` for how much MUSD
    /// a unit moves). Never exceeds `lossRecorded`.
    mapping(uint256 lineId => uint256) public lossCovered;
    mapping(uint256 lineId => HighWaterMark) public highWaterMark;
    /// @notice The vault's allocation through the line's adapter at the line's last checkpoint (see `checkpoint`).
    mapping(uint256 lineId => uint256) public allocationAtCheckpoint;
    /// @dev Covers in order; those before `coverFeeHead` are fully credited.
    CoverFee[] internal coverFees;
    /// @notice First cover whose fee shares are not fully credited yet.
    uint256 public coverFeeHead;
    /// @notice MUSD of all covers not re-recognised by VaultV2 yet (the sum of their `unrecognised`).
    uint256 public coverUnrecognised;

    event AllocatorSet(address indexed allocator);
    event IncentivePosted(
        uint256 indexed lineId, uint256 indexed epoch, address indexed sponsor, uint256 assets, uint256 shares
    );
    event IncentiveRefunded(uint256 indexed lineId, uint256 indexed epoch, address indexed sponsor, uint256 shares);
    /// @param shares Fee shares distributed in this call.
    /// @param toReserve Part of `shares` credited to the reserve.
    event FeesDistributed(uint256 indexed cohortEpoch, uint256 shares, uint256 toReserve);
    /// @param to Recipient of the shares; the pool itself when a burned NFT's claim is credited to the reserve.
    event Claimed(uint256 indexed tokenId, uint256 indexed lineId, uint256 indexed epoch, address to, uint256 shares);
    event LossRecorded(uint256 indexed lineId, uint256 assets);
    event CohortSlashed(uint256 indexed lineId, uint256 indexed epoch, uint256 shares);
    /// @param lossUnitsCovered Recorded loss this call covers, added to `lossCovered`.
    /// @param assetsMoved MUSD withdrawn from the pool's shares and returned to the vault or paid into the line; see
    /// `cover` for how it relates to the loss units.
    /// @param fromCohorts Vault shares taken from the line's unmatured cohorts.
    /// @param fromReserve Vault shares taken from the reserve.
    event Covered(
        uint256 indexed lineId, uint256 lossUnitsCovered, uint256 assetsMoved, uint256 fromCohorts, uint256 fromReserve
    );
    /// @notice Fee shares VaultV2 minted on a cover's re-recognised MUSD, credited back to whoever the cover slashed
    /// (part of the `FeesDistributed` totals of the same call).
    /// @param toCohorts Shares credited to the slashed cohorts.
    /// @param toReserve Shares credited to the reserve: its own part, and the part of cohorts that matured since.
    event CoverFeeCredited(uint256 indexed lineId, uint256 toCohorts, uint256 toReserve);

    error ZeroAddress();
    error AssetMismatch();
    error BadSeason();
    error AllocatorAlreadySet();
    error NotAllocator();
    error ZeroAmount();
    error InactiveLine();
    error LengthMismatch();
    error EpochNotEnded();
    error LineHasVotes();
    error NothingToRefund();
    error NotMatured();
    error AlreadyClaimed();
    error NothingToClaim();
    error UnsupportedAdapter();
    error WithdrawMismatch();

    /// @param vault_ Surety VaultV2 (asset MUSD). The pool must be its performance-fee recipient.
    /// @param voter_ CreditVoter whose tallies define cohorts and claims.
    /// @param musd_ MUSD, the vault asset.
    /// @param morpho_ Morpho Blue.
    /// @param morphoAdapter_ The vault's MorphoMarketV1AdapterV2.
    /// @param escrows_ Loan escrow registry (the veBTC credit line), or zero.
    /// @param owner_ May set the allocator once.
    /// @param seasonEpochs Seasoning length in epochs, 1 to MAX_SEASON.
    constructor(
        address vault_,
        ICreditVoter voter_,
        IERC20 musd_,
        IMorpho morpho_,
        address morphoAdapter_,
        IEscrowRegistry escrows_,
        address owner_,
        uint256 seasonEpochs
    ) Ownable(owner_) {
        if (
            vault_ == address(0) || address(voter_) == address(0) || address(musd_) == address(0)
                || address(morpho_) == address(0) || morphoAdapter_ == address(0)
        ) revert ZeroAddress();
        if (IVaultV2(vault_).asset() != address(musd_)) revert AssetMismatch();
        if (seasonEpochs == 0 || seasonEpochs > MAX_SEASON) revert BadSeason();

        vault = IVaultV2(vault_);
        voter = voter_;
        veBTC = voter_.veBTC();
        musd = musd_;
        morpho = morpho_;
        morphoAdapter = morphoAdapter_;
        escrows = escrows_;
        SEASON = seasonEpochs;
        EPOCH_LENGTH = voter_.EPOCH_LENGTH();
    }

    /* Admin */

    /// @notice Sets the VoteAllocator. One-shot.
    function setAllocator(address allocator_) external onlyOwner {
        if (allocator_ == address(0)) revert ZeroAddress();
        if (allocator != address(0)) revert AllocatorAlreadySet();
        allocator = allocator_;
        emit AllocatorSet(allocator_);
    }

    /* Inflows */

    /// @notice Posts `assets` MUSD as an incentive for voters of `lineId` in the current epoch. The MUSD is
    /// deposited into the vault and joins cohort (lineId, current epoch) as first loss for that line.
    /// @return shares Vault shares added to the cohort.
    function postIncentive(uint256 lineId, uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (!voter.line(lineId).active) revert InactiveLine();
        uint256 epoch = _currentEpoch();

        musd.safeTransferFrom(msg.sender, address(this), assets);
        musd.forceApprove(address(vault), assets);
        shares = vault.deposit(assets, address(this));

        cohorts[lineId][epoch].shares += shares;
        incentiveShares[lineId][epoch] += shares;
        sponsorShares[lineId][epoch][msg.sender] += shares;
        accountedShares += shares;
        emit IncentivePosted(lineId, epoch, msg.sender, assets, shares);
    }

    /// @notice Returns the caller's incentive for a line that drew no votes in `epoch`, once the epoch has ended.
    /// @dev Pays the sponsor's pro-rata part of what is left in the cohort, in vault shares.
    /// @return shares Vault shares sent to the caller.
    function refundIncentive(uint256 lineId, uint256 epoch) external nonReentrant returns (uint256 shares) {
        if (block.timestamp < epoch + EPOCH_LENGTH) revert EpochNotEnded();
        if (voter.lineVotes(epoch, lineId) != 0) revert LineHasVotes();
        uint256 posted = sponsorShares[lineId][epoch][msg.sender];
        if (posted == 0) revert NothingToRefund();

        Cohort storage c = cohorts[lineId][epoch];
        uint256 total = incentiveShares[lineId][epoch];
        // An unbacked cohort receives no fees, so it holds incentives minus any slash taken while votes were open.
        shares = Math.mulDiv(posted, c.shares, total);
        c.shares -= shares;
        incentiveShares[lineId][epoch] = total - posted;
        sponsorShares[lineId][epoch][msg.sender] = 0;
        accountedShares -= shares;
        emit IncentiveRefunded(lineId, epoch, msg.sender, shares);

        if (shares != 0) IERC20(address(vault)).safeTransfer(msg.sender, shares);
    }

    /// @inheritdoc ISuretyPool
    /// @dev Distributes the vault shares received since the last call (performance fees, plus anything sent to the
    /// pool directly). First, the fee shares VaultV2 minted on covers' re-recognised MUSD go back to whoever each
    /// cover slashed (see `_creditCoverFees`). Each line's part of the rest is pro rata to `interest`; it goes to the
    /// reserve when the line had no votes in `cohortEpoch`, as do rounding dust, a zero total, and every part when
    /// `cohortEpoch` is not an ended, unmatured epoch.
    function distributeFees(uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest)
        external
        nonReentrant
    {
        if (msg.sender != allocator) revert NotAllocator();
        if (lineIds.length != interest.length) revert LengthMismatch();

        vault.accrueInterest();
        uint256 shares = vault.balanceOf(address(this)) - accountedShares;
        accountedShares += shares;
        (uint256 coverToCohorts, uint256 coverToReserve) = _creditCoverFees(shares);
        uint256 left = shares - coverToCohorts - coverToReserve;

        uint256 toCohorts = 0;
        if (left != 0 && _feeEpoch(cohortEpoch)) toCohorts = _splitByInterest(left, cohortEpoch, lineIds, interest);
        uint256 toReserve = left - toCohorts + coverToReserve;
        reserveShares += toReserve;
        emit FeesDistributed(cohortEpoch, shares, toReserve);
    }

    /* Claims */

    /// @notice Pays `tokenId`'s share of the matured cohort (lineId, epoch): `finalShares * tokenVotes / lineVotes`.
    /// Permissionless; the shares go to the NFT's owner, the borrower if the owner is a loan escrow, or the reserve
    /// if the NFT was burned.
    /// @return shares Vault shares paid.
    function claim(uint256 tokenId, uint256 lineId, uint256 epoch) external nonReentrant returns (uint256 shares) {
        if (block.timestamp < maturityOf(epoch)) revert NotMatured();
        if (claimed[epoch][lineId][tokenId]) revert AlreadyClaimed();
        uint256 votes = voter.tokenVotes(epoch, tokenId, lineId);
        if (votes == 0) revert NothingToClaim();

        Cohort storage c = cohorts[lineId][epoch];
        if (!c.frozen) {
            c.frozen = true;
            c.finalShares = c.shares;
        }
        shares = Math.mulDiv(c.finalShares, votes, voter.lineVotes(epoch, lineId));
        claimed[epoch][lineId][tokenId] = true;
        c.shares -= shares;

        address to = _recipient(tokenId);
        if (to == address(0)) {
            reserveShares += shares;
            emit Claimed(tokenId, lineId, epoch, address(this), shares);
        } else {
            accountedShares -= shares;
            emit Claimed(tokenId, lineId, epoch, to, shares);
            if (shares != 0) IERC20(address(vault)).safeTransfer(to, shares);
        }
    }

    /* Losses */

    /// @inheritdoc ISuretyPool
    /// @dev Permissionless; the VoteAllocator also calls it for every line at each rebalance.
    /// Morpho lines: accrues the market and compares its supply share price with the line's mark (set by the first
    /// checkpoint). A drop is valued with Morpho's rounding on `max(sharesAtMark, sharesNow)` of the adapter: shares
    /// that left after the mark (a permissionless `forceDeallocate`, possibly bundled with the liquidation that made
    /// the bad debt) left at the impaired price, so their part of the loss is real for the vault and is recorded too.
    /// If a forced exit came before the bad debt within the same window this over-records, which is the lender-safe
    /// direction. Drops worth at most LOSS_DUST are not recorded. The mark then moves to the current price and
    /// shares, so a line whose adapter holds no shares never carries a stale price into its next position.
    /// veBTC line: the increase in the line's cumulative `badDebtTotal` since the last checkpoint.
    /// Either way a checkpoint never records more than the vault's allocation through the line's adapter (VaultV2
    /// `allocation` of its adapter id), which bounds what a misbehaving line could make the pool cover. The bound is
    /// the larger of that allocation now and at the line's previous checkpoint, so a forced exit between a loss and
    /// its checkpoint (which lowers the allocation) cannot shrink it either. A veBTC shortfall cut by the bound is
    /// recorded by a later checkpoint; for a Morpho line, whose loss is measured from Morpho itself, the bound only
    /// binds if interest has grown the position past its last allocation.
    function checkpoint(uint256 lineId) external nonReentrant returns (uint256 newLoss) {
        return _checkpoint(lineId, voter.line(lineId));
    }

    /// @notice Checkpoints `lineId`, then covers as much of its uncovered loss as the pool and the vault's idle MUSD
    /// allow. Permissionless and repeatable; `lossCovered` never exceeds `lossRecorded`.
    /// @dev Shares come pro rata from the line's backed, unmatured cohorts, then from the reserve, and are
    /// withdrawn from the vault as MUSD. Morpho line: the MUSD goes back to the vault as idle assets. veBTC line:
    /// paid in through `receiveCover`.
    ///
    /// Sizing. A loss U leaves A assets for T shares, down from (A+U)/T a share. Withdrawing W burns W*T/A shares at
    /// the post-loss price, and VaultV2 later recognises the returned W as interest and mints its performance fee f
    /// on it to the pool: returning U itself would over-slash voters by about U^2/(A+U) and leave lenders about f*W
    /// short. The cover moves `W = A*U / (A + U - f*A)` instead: once VaultV2 has recognised W, every share is back at
    /// (A+U)/T and the pool is down exactly U from its pre-loss value, net of the fee shares it got back. Those fee
    /// shares are credited back to the cohorts (and reserve) the cover slashed, pro rata to what each paid, by the
    /// `distributeFees` calls that follow the re-recognition, so the slashed cohorts net exactly U. A cover cut
    /// short (by the pool or by idle MUSD) moves less and covers `W*(1-f)*(A+U) / (A - f*W)` loss units: the shares
    /// it takes, net of their fee shares, priced at (A+U)/T, so covering the rest later ends at the same price as
    /// one full cover. Returned MUSD that VaultV2 has not recognised yet (R = realAssets - A) enters through
    /// X = A + (1-f)*R and the gap G = U*X/(A+R): W = A*G/(X + G - f*A), and a partial W closes W*(X + G - f*A)/A
    /// of G. With R = 0 these reduce to the expressions above.
    ///
    /// Lenders get the restoration only as VaultV2 re-recognises the returned MUSD, no faster than `maxRate` (at
    /// MAX_MAX_RATE, 200% APR, MUSD worth 10% of totalAssets takes about 18 days). The allocator should keep
    /// `maxRate` at MAX_MAX_RATE: below it recognition is slower, and a loss can land on interest the cap still holds
    /// back, which the sizing reads as a full loss. The sizing is exact when the recognition happens in one accrual,
    /// the share supply moves only through covers in between, and only this line's loss is outstanding. Otherwise,
    /// to second order: recognition over several accruals lets early fee shares share in later recognition (lenders
    /// end up to about f*(1-f)*W^2/(2*A) short); losses on several lines, each sized against the same depressed
    /// price, overshoot by about U1*U2/A when covered one after the other; deposits and withdrawals after the loss
    /// spread the cover over the shares outstanding when it lands.
    /// @return covered Loss units covered by this call, added to `lossCovered`; zero if nothing moved.
    // The checkpoint and the vault accrual precede the ledger update; nonReentrant closes that window.
    // forge-lint: disable-next-item(reentrancy-no-eth)
    function cover(uint256 lineId) external nonReentrant returns (uint256 covered) {
        ICreditVoter.Line memory l = voter.line(lineId);
        _checkpoint(lineId, l);
        uint256 uncovered = lossRecorded[lineId] - lossCovered[lineId];
        if (uncovered == 0) return 0;

        vault.accrueInterest();
        (uint256[] memory epochs, uint256[] memory held, uint256 cohortShares) = _slashable(lineId);
        uint256 available = cohortShares + reserveShares;
        if (available == 0) return 0;
        uint256 assets;
        (covered, assets) =
            _sizeCover(uncovered, Math.min(vault.previewRedeem(available), musd.balanceOf(address(vault))));
        if (covered == 0) return 0;

        // At most `available`, since `assets` is at most what `available` redeems for.
        uint256 burn = vault.previewWithdraw(assets);
        uint256 fromCohorts = Math.min(burn, cohortShares);
        uint256 fromReserve = burn - fromCohorts;
        uint256[] memory cuts;
        if (fromCohorts != 0) cuts = _slash(lineId, epochs, held, fromCohorts, cohortShares);
        reserveShares -= fromReserve;
        accountedShares -= burn;
        lossCovered[lineId] += covered;
        _recordCoverFee(lineId, assets, burn, epochs, cuts);
        emit Covered(lineId, covered, assets, fromCohorts, fromReserve);

        if (vault.withdraw(assets, address(this), address(this)) != burn) revert WithdrawMismatch();
        if (l.kind == ICreditVoter.LineKind.Morpho) {
            musd.safeTransfer(address(vault), assets);
        } else {
            musd.forceApprove(l.adapter, assets);
            ISuretyLine(l.adapter).receiveCover(assets);
        }
    }

    /* Views */

    /// @notice Cohort (lineId, epoch): shares held, shares frozen at maturity, and whether they are frozen.
    function cohort(uint256 lineId, uint256 epoch)
        external
        view
        returns (uint256 shares, uint256 finalShares, bool frozen)
    {
        Cohort storage c = cohorts[lineId][epoch];
        return (c.shares, c.finalShares, c.frozen);
    }

    /// @notice Time from which cohorts of tally epoch `epoch` can be claimed and are no longer slashed.
    function maturityOf(uint256 epoch) public view returns (uint256) {
        return epoch + (2 + SEASON) * EPOCH_LENGTH;
    }

    /// @notice Shares `claim(tokenId, lineId, epoch)` would pay now (zero before maturity or once claimed).
    function claimable(uint256 tokenId, uint256 lineId, uint256 epoch) external view returns (uint256) {
        if (block.timestamp < maturityOf(epoch) || claimed[epoch][lineId][tokenId]) return 0;
        uint256 votes = voter.tokenVotes(epoch, tokenId, lineId);
        if (votes == 0) return 0;
        Cohort storage c = cohorts[lineId][epoch];
        return Math.mulDiv(c.frozen ? c.finalShares : c.shares, votes, voter.lineVotes(epoch, lineId));
    }

    function isClaimed(uint256 tokenId, uint256 lineId, uint256 epoch) external view returns (bool) {
        return claimed[epoch][lineId][tokenId];
    }

    /// @notice Recorded loss of `lineId` not covered yet; lenders bear it until covered.
    function uncoveredLoss(uint256 lineId) external view returns (uint256) {
        return lossRecorded[lineId] - lossCovered[lineId];
    }

    /// @notice Whether new vault shares should wait (read by the vault's DepositGate). While a loss is unrecorded or
    /// uncovered, or the vault is still re-recognising MUSD a cover returned, a new depositor would buy in at the
    /// depressed price and capture part of the voter-funded cover meant for the lenders who took the loss.
    /// @dev True if, for any line, a checkpoint now would record a loss above LOSS_DUST (Morpho: `max(sharesAtMark,
    /// sharesNow) * drop` on Morpho's expected balances; veBTC: bad debt above what is recorded; both within the
    /// allocation bound of `checkpoint`), or a recorded loss above LOSS_DUST is uncovered while the pool still holds
    /// shares that can cover it (the line's backed, unmatured cohorts or the reserve). Also true while cover MUSD that
    /// VaultV2 has not re-recognised yet (the smaller of `coverUnrecognised` and what the vault's real assets exceed
    /// its total assets by) is above RECOGNITION_TOLERANCE_BPS of total assets.
    /// Two judgement calls keep this from pausing deposits indefinitely: an uncovered loss nothing can cover pauses
    /// nothing (lenders bear it either way), and only MUSD returned by covers counts as awaiting recognition, so a
    /// donation or a forced-exit penalty, which VaultV2 also recognises at no more than its max rate, cannot pause
    /// deposits on its own. Withdrawals are never paused. Never reverts on a line whose calls revert.
    function depositsPaused() external view returns (bool) {
        uint256 n = voter.lineCount();
        for (uint256 i; i < n; ++i) {
            // Bounded by the voter's line list.
            // forge-lint: disable-next-line(calls-loop)
            if (_lossPending(i, voter.line(i))) return true;
        }
        uint256 unrecognised = coverUnrecognised;
        if (unrecognised == 0) return false;
        uint256 total = vault.totalAssets();
        return Math.min(unrecognised, _pendingRecognition()) > Math.mulDiv(total, RECOGNITION_TOLERANCE_BPS, BPS);
    }

    /// @notice MUSD value of the shares that can cover `lineId` now: its backed unmatured cohorts plus the reserve.
    /// @dev Not limited by the vault's idle MUSD, which also bounds a single `cover`. This is MUSD that can move, not
    /// loss units: `cover` grosses the MUSD up for the performance fee, so it covers about (1 - f) of it in loss
    /// units (somewhat more for a large loss).
    function coverCapacity(uint256 lineId) external view returns (uint256 assets) {
        (,, uint256 cohortShares) = _slashable(lineId);
        uint256 available = cohortShares + reserveShares;
        return available == 0 ? 0 : vault.previewRedeem(available);
    }

    /* Internals */

    function _currentEpoch() internal view returns (uint256) {
        return EpochLib.start(block.timestamp, EPOCH_LENGTH);
    }

    /// @dev Fees can join cohorts of an epoch whose tallies are final (ended) and that has not matured.
    function _feeEpoch(uint256 epoch) internal view returns (bool) {
        return epoch % EPOCH_LENGTH == 0 && epoch < _currentEpoch() && block.timestamp < maturityOf(epoch);
    }

    function _recipient(uint256 tokenId) internal view returns (address owner) {
        owner = veBTC.ownerOf(tokenId);
        if (owner != address(0) && address(escrows) != address(0) && escrows.isEscrow(owner)) {
            owner = escrows.borrowerOfEscrow(owner);
        }
    }

    /// @dev The line's backed, unmatured cohorts: epochs current, current - 1, ..., current - (SEASON + 1).
    /// `held[k]` is zero for epochs that cannot be slashed.
    function _slashable(uint256 lineId)
        internal
        view
        returns (uint256[] memory epochs, uint256[] memory held, uint256 total)
    {
        uint256 n = SEASON + 2;
        epochs = new uint256[](n);
        held = new uint256[](n);
        uint256 epoch = _currentEpoch();
        for (uint256 k; k < n; ++k) {
            uint256 shares = cohorts[lineId][epoch].shares;
            // Bounded: SEASON + 2 iterations.
            // forge-lint: disable-next-line(calls-loop)
            if (shares != 0 && block.timestamp < maturityOf(epoch) && voter.lineVotes(epoch, lineId) != 0) {
                epochs[k] = epoch;
                held[k] = shares;
                total += shares;
            }
            if (epoch < EPOCH_LENGTH) break;
            epoch -= EPOCH_LENGTH;
        }
    }

    /// @dev Takes `amount` shares from the cohorts in `held`, pro rata to their holdings. Each cut is rounded down
    /// against what is still owed and still held, so the cuts sum to `amount` and none exceeds its cohort.
    /// @return cuts Shares taken from each cohort, indexed like `held`.
    function _slash(uint256 lineId, uint256[] memory epochs, uint256[] memory held, uint256 amount, uint256 total)
        internal
        returns (uint256[] memory cuts)
    {
        cuts = new uint256[](held.length);
        for (uint256 k; k < held.length; ++k) {
            if (held[k] == 0) continue;
            uint256 cut = Math.mulDiv(amount, held[k], total);
            amount -= cut;
            total -= held[k];
            cuts[k] = cut;
            cohorts[lineId][epochs[k]].shares -= cut;
            emit CohortSlashed(lineId, epochs[k], cut);
        }
    }

    /// @dev Credits `shares` to the cohorts of `cohortEpoch` pro rata to each line's interest, skipping lines without
    /// votes in it. Returns what it credited; the rest is left for the reserve.
    function _splitByInterest(
        uint256 shares,
        uint256 cohortEpoch,
        uint256[] calldata lineIds,
        uint256[] calldata interest
    ) internal returns (uint256 toCohorts) {
        uint256 n = lineIds.length;
        uint256 totalInterest = 0;
        for (uint256 i; i < n; ++i) {
            totalInterest += interest[i];
        }
        if (totalInterest == 0) return 0;
        // Bounded by the allocator's line list.
        for (uint256 i; i < n; ++i) {
            // forge-lint: disable-next-line(calls-loop)
            if (interest[i] == 0 || voter.lineVotes(cohortEpoch, lineIds[i]) == 0) continue;
            uint256 part = Math.mulDiv(shares, interest[i], totalInterest);
            cohorts[lineIds[i]][cohortEpoch].shares += part;
            toCohorts += part;
        }
    }

    /// @dev Remembers who a cover slashed, so the fee shares VaultV2 will mint on its MUSD can be credited back.
    /// Nothing to remember without a performance fee.
    function _recordCoverFee(
        uint256 lineId,
        uint256 assets,
        uint256 burned,
        uint256[] memory epochs,
        uint256[] memory cuts
    ) internal {
        if (_performanceFee() == 0) return;
        CoverFee storage c = coverFees.push();
        c.lineId = lineId;
        c.unrecognised = assets;
        c.burned = burned;
        for (uint256 k; k < cuts.length; ++k) {
            if (cuts[k] == 0) continue;
            c.epochs.push(epochs[k]);
            c.cuts.push(cuts[k]);
        }
        coverUnrecognised += assets;
    }

    /// @dev Credits, out of `available` newly received shares, the fee shares VaultV2 minted on covers' MUSD since the
    /// last call. Covers' MUSD counts as re-recognised to the extent the vault's real assets no longer exceed its
    /// total assets, oldest cover first (exact when the covers' MUSD is the only amount awaiting recognition, as after
    /// a loss; anything else awaiting recognition, such as a donation, delays the credit). Each recognised MUSD earns
    /// VaultV2's performance fee, converted to shares at the price after this transaction's accrual (as
    /// `convertToShares` would); at most MAX_COVER_FEES_PER_DISTRIBUTION covers are credited per call.
    function _creditCoverFees(uint256 available) internal returns (uint256 toCohorts, uint256 toReserve) {
        uint256 head = coverFeeHead;
        uint256 end = coverFees.length;
        if (head == end || available == 0) return (0, 0);
        uint256 unrecognised = coverUnrecognised;
        uint256 recognised = _floorSub(unrecognised, _pendingRecognition());
        if (recognised == 0) return (0, 0);

        // Fee shares per recognised MUSD: fee * (totalSupply + virtualShares) / (WAD * (totalAssets + 1)).
        uint256 num = _performanceFee() * (vault.totalSupply() + vault.virtualShares());
        uint256 den = WAD * (vault.totalAssets() + 1);
        end = Math.min(end, head + MAX_COVER_FEES_PER_DISTRIBUTION);
        for (uint256 k = head; k < end && recognised != 0; ++k) {
            CoverFee storage c = coverFees[k];
            uint256 r = Math.min(c.unrecognised, recognised);
            recognised -= r;
            unrecognised -= r;
            c.unrecognised -= r;
            uint256 owed = Math.min(available, Math.mulDiv(r, num, den));
            available -= owed;
            uint256 cohortPart = _creditCover(c, owed);
            toCohorts += cohortPart;
            toReserve += owed - cohortPart;
            if (c.unrecognised == 0) {
                delete coverFees[k];
                head = k + 1;
            }
        }
        coverFeeHead = head;
        coverUnrecognised = unrecognised;
    }

    /// @dev Splits `shares` over a cover's slashed cohorts pro rata to their cuts and returns what they got; the rest
    /// is the reserve's: the part of the burn it paid, the part of cohorts that have matured since (closed to
    /// inflows) and the rounding dust.
    function _creditCover(CoverFee storage c, uint256 shares) internal returns (uint256 toCohorts) {
        if (shares == 0) return 0;
        uint256 lineId = c.lineId;
        uint256 n = c.epochs.length;
        for (uint256 i; i < n; ++i) {
            uint256 epoch = c.epochs[i];
            if (block.timestamp >= maturityOf(epoch)) continue;
            uint256 part = Math.mulDiv(shares, c.cuts[i], c.burned);
            cohorts[lineId][epoch].shares += part;
            toCohorts += part;
        }
        emit CoverFeeCredited(lineId, toCohorts, shares - toCohorts);
    }

    function _floorSub(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    /// @dev Sizes a cover of `uncovered` loss units with at most `maxAssets` MUSD, after the vault's accrual (see
    /// `cover` for the formulas). Returns the loss units covered and the MUSD to move; (0, 0) when nothing can be
    /// covered. Rounding favours lenders: the MUSD of a full cover rounds up, the units of a partial one down.
    function _sizeCover(uint256 uncovered, uint256 maxAssets) internal view returns (uint256 units, uint256 assets) {
        uint256 a = vault.totalAssets();
        if (a == 0 || maxAssets == 0) return (0, 0);
        uint256 fee = _performanceFee();
        uint256 real = _vaultRealAssets();
        uint256 pending = real > a ? real - a : 0;
        // Assets once the pending MUSD is recognised, and what non-fee holders keep of them.
        uint256 recognised = a + pending;
        uint256 projected = recognised - Math.mulDiv(pending, fee, WAD);
        uint256 gap = Math.mulDiv(uncovered, projected, recognised, Math.Rounding.Ceil);
        uint256 denominator = projected + gap - Math.mulDiv(a, fee, WAD, Math.Rounding.Ceil);
        uint256 full = Math.mulDiv(a, gap, denominator, Math.Rounding.Ceil);

        assets = Math.min(full, maxAssets);
        if (assets >= a) return (0, 0);
        if (assets == full) return (uncovered, assets);
        uint256 closed = Math.mulDiv(assets, denominator, a);
        if (closed >= gap) return (uncovered, assets);
        uint256 left = Math.mulDiv(
            gap - closed, recognised, projected - Math.mulDiv(assets, fee, WAD, Math.Rounding.Ceil), Math.Rounding.Ceil
        );
        if (left >= uncovered) return (0, 0);
        units = uncovered - left;
    }

    /// @dev The fee VaultV2 takes on recognised interest: zero if the recipient cannot receive shares.
    function _performanceFee() internal view returns (uint256 fee) {
        fee = vault.performanceFee();
        if (fee != 0 && !vault.canReceiveShares(vault.performanceFeeRecipient())) fee = 0;
    }

    /// @dev MUSD VaultV2 holds but has not recognised in its total assets yet (held back by its max rate).
    function _pendingRecognition() internal view returns (uint256) {
        uint256 real = _vaultRealAssets();
        uint256 total = vault.totalAssets();
        return real > total ? real - total : 0;
    }

    /// @dev What VaultV2 values its assets at before the max rate: idle MUSD plus every adapter's real assets.
    function _vaultRealAssets() internal view returns (uint256 real) {
        real = musd.balanceOf(address(vault));
        uint256 n = vault.adaptersLength();
        for (uint256 i; i < n; ++i) {
            // Bounded by the curator's adapter list (VaultV2 runs the same loop on every accrual).
            // forge-lint: disable-next-line(calls-loop)
            real += IAdapter(vault.adapters(i)).realAssets();
        }
    }

    /// @dev Whether `lineId` has a loss a checkpoint would record now, or a recorded one the pool can still cover.
    function _lossPending(uint256 lineId, ICreditVoter.Line memory l) internal view returns (bool) {
        if (lossRecorded[lineId] - lossCovered[lineId] > LOSS_DUST) {
            (,, uint256 cohortShares) = _slashable(lineId);
            if (cohortShares + reserveShares != 0) return true;
        }
        return _unrecordedLoss(lineId, l) > LOSS_DUST;
    }

    /// @dev What `_checkpoint` would record for the line now, as a view: Morpho lines on Morpho's expected balances
    /// (accrued as `accrueInterest` would), veBTC lines from their bad debt; zero if the line's calls revert.
    /// Called once per line from `depositsPaused`.
    // forge-lint: disable-next-item(calls-loop)
    function _unrecordedLoss(uint256 lineId, ICreditVoter.Line memory l) internal view returns (uint256 loss) {
        if (l.kind == ICreditVoter.LineKind.Morpho) {
            if (l.adapter != morphoAdapter) return 0;
            MarketParams memory params = abi.decode(l.data, (MarketParams));
            (uint256 supplyAssets, uint256 supplyShares,,) = morpho.expectedMarketBalances(params);
            uint256 sharesNow = IMorphoMarketV1AdapterV2(morphoAdapter).supplyShares(Id.unwrap(params.id()));
            loss = _lossBelowMark(highWaterMark[lineId], supplyAssets, supplyShares, sharesNow);
        } else {
            try ISuretyLine(l.adapter).badDebtTotal() returns (uint256 badDebt) {
                loss = _floorSub(badDebt, lossRecorded[lineId]);
            } catch {
                return 0;
            }
        }
        uint256 allocated = vault.allocation(LineIds.adapterId(l.adapter));
        loss = Math.min(loss, Math.max(allocated, allocationAtCheckpoint[lineId]));
    }

    function _checkpoint(uint256 lineId, ICreditVoter.Line memory l) internal returns (uint256 newLoss) {
        if (l.kind == ICreditVoter.LineKind.Morpho) {
            if (l.adapter != morphoAdapter) revert UnsupportedAdapter();
            newLoss = _morphoLoss(lineId, abi.decode(l.data, (MarketParams)));
        } else {
            uint256 badDebt = ISuretyLine(l.adapter).badDebtTotal();
            uint256 seen = lossRecorded[lineId];
            newLoss = badDebt > seen ? badDebt - seen : 0;
        }
        uint256 allocated = vault.allocation(LineIds.adapterId(l.adapter));
        newLoss = Math.min(newLoss, Math.max(allocated, allocationAtCheckpoint[lineId]));
        allocationAtCheckpoint[lineId] = allocated;
        if (newLoss == 0) return 0;

        lossRecorded[lineId] += newLoss;
        emit LossRecorded(lineId, newLoss);
    }

    /// @dev Measures the line's Morpho loss since its mark on the accrued market, then moves the mark.
    function _morphoLoss(uint256 lineId, MarketParams memory params) internal returns (uint256 loss) {
        Id id = params.id();
        morpho.accrueInterest(params);
        Market memory m = morpho.market(id);
        uint256 sharesNow = IMorphoMarketV1AdapterV2(morphoAdapter).supplyShares(Id.unwrap(id));
        HighWaterMark storage mark = highWaterMark[lineId];
        loss = _lossBelowMark(mark, m.totalSupplyAssets, m.totalSupplyShares, sharesNow);

        mark.totalSupplyAssets = m.totalSupplyAssets;
        mark.totalSupplyShares = m.totalSupplyShares;
        mark.adapterShares = sharesNow;
        mark.set = true;
    }

    /// @dev Loss of `max(sharesAtMark, sharesNow)` adapter shares from the mark's supply share price down to the
    /// price of the supply totals (a, s); zero if no mark is set, the price did not fall, or the loss is dust.
    function _lossBelowMark(HighWaterMark storage mark, uint256 a, uint256 s, uint256 sharesNow)
        internal
        view
        returns (uint256 loss)
    {
        uint256 markAssets = mark.totalSupplyAssets;
        uint256 markShares = mark.totalSupplyShares;
        if (!mark.set || !_priceBelow(a, s, markAssets, markShares)) return 0;
        uint256 shares = Math.max(mark.adapterShares, sharesNow);
        loss = shares.toAssetsDown(markAssets, markShares) - shares.toAssetsDown(a, s);
        if (loss <= LOSS_DUST) return 0;
    }

    /// @dev Whether Morpho's supply share price, (assets + VIRTUAL_ASSETS) / (shares + VIRTUAL_SHARES), is lower
    /// for totals (a, s) than for totals (markA, markS). Compared by cross-multiplication, without rounding.
    function _priceBelow(uint256 a, uint256 s, uint256 markA, uint256 markS) internal pure returns (bool) {
        return (a + SharesMathLib.VIRTUAL_ASSETS) * (markS + SharesMathLib.VIRTUAL_SHARES)
            < (markA + SharesMathLib.VIRTUAL_ASSETS) * (s + SharesMathLib.VIRTUAL_SHARES);
    }

    // forge-lint: disable-end(reentrancy-events)
}
