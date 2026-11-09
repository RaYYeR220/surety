// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {IEscrowRegistry} from "../interfaces/IEscrowRegistry.sol";
import {IMusdPeg} from "../interfaces/IMusdPeg.sol";
import {IPoolsVoter} from "../interfaces/IPoolsVoter.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {IRewardsDistributor} from "../interfaces/IRewardsDistributor.sol";
import {ISuretyLine} from "../interfaces/ISuretyLine.sol";
import {IVeBTC} from "../interfaces/IVeBTC.sol";
import {LineIds} from "../libraries/LineIds.sol";
import {LinearKinkIrm} from "./LinearKinkIrm.sol";
import {LoanEscrow} from "./LoanEscrow.sol";

/// @title VeBTCCreditLine
/// @notice Lends MUSD against locked veBTC NFTs without unlocking them. It is a Morpho VaultV2 adapter (the vault
/// allocates MUSD into it and deallocates idle cash back out) and an isolated lending market: each loan's NFT sits in
/// its own LoanEscrow clone, keeps voting and earning for the borrower, and is sold by Dutch auction on default.
/// @dev Accounting:
/// - `cash` is MUSD available to lend; `realAssets = cash + totalDebt`, interest included up to the current second.
///   A loan closed below its debt removes the whole debt and adds only the proceeds, so the shortfall leaves
///   `realAssets` at once and is recorded in `badDebtTotal` for the SuretyPool to cover.
/// - `interestEarnedTotal` counts what the line earns (interest through the borrow index, plus the lenders' part of
///   liquidation fees) independently of the capital moved in or out, so the VoteAllocator never reads interest from
///   changes in `realAssets`, which anyone can move with VaultV2's `forceDeallocate`.
/// - Debt is tracked in normalised units against a global `borrowIndex` (WAD). Rounding always favours lenders:
///   borrowing mints normalised debt rounded up, partial repayments burn it rounded down, debts round up.
/// - Collateral value is `locked.amount` times the oracle's BTC price in MUSD (BtcMusdPriceSource in production);
///   lock boosts are ignored.
/// - Utilisation is `debt / (cash + debt)` on the line's own cash. VaultV2's permissionless `forceDeallocate` can
///   pull that cash out (its penalty goes to lenders): utilisation then reads 100%, every borrower accrues at the
///   IRM's max APR and `open` / `borrowMore` revert with InsufficientCash until the allocator refills the line.
///   The keeper rebalances at every epoch flip and should also rebalance when the line's cash falls well below what
///   the allocator targets for it.
/// Fees, in MUSD and paid out in the transaction that earns them, so none of them sits in `cash`:
/// - origination: `originationFeeBps` of every amount borrowed goes to `treasury`; the borrower receives the rest and
///   owes the full amount;
/// - liquidation: of the fee the line keeps on a bid (proceeds above the debt, up to `liqFeeBps` of it),
///   `protocolShareBps` leaves the line, `keeperShareBps` of that to the address that started the auction and the
///   rest to `treasury`; lenders keep the remainder.
/// Fail-closed oracle: open, borrowMore, startAuction and bid revert when the price source does; repay never reads it.
/// Depeg breaker: open and borrowMore also revert while `peg` reports MUSD unhealthy; repayment, auctions and escrow
/// actions never read the peg.
/// The owner can pause new borrowing and set the SuretyPool once. It cannot move NFTs or MUSD. `treasury` is fixed at
/// deployment.
contract VeBTCCreditLine is ISuretyLine, IEscrowRegistry, Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // Every state-changing entry point is nonReentrant, and events follow effects. The calls that still precede some
    // events are views on fixed contracts (IRM, veBTC, oracle) or escrow calls whose result the event reports.
    // forge-lint: disable-start(reentrancy-events)

    /// @param maxLtvTimedBps Max LTV at open / borrowMore for timed locks.
    /// @param maxLtvPermanentBps Max LTV at open / borrowMore for permanent locks.
    /// @param liqLtvBps LTV at or above which a loan can be auctioned.
    /// @param liqFeeBps Liquidation fee on the debt, paid to the line out of auction proceeds.
    /// @param floorBps Auction floor as a share of live collateral value.
    /// @param auctionDuration Seconds over which the auction price decays from 100% to the floor.
    /// @param minTerm Minimum remaining lock time for a timed lock to open or increase a loan.
    /// @param originationFeeBps Share of every amount borrowed paid to the treasury, at most 100.
    /// @param protocolShareBps Share of the liquidation fee kept on a bid that leaves the line, at most 5000.
    /// @param keeperShareBps Share of that protocol part paid to the address that started the auction.
    struct Params {
        uint16 maxLtvTimedBps;
        uint16 maxLtvPermanentBps;
        uint16 liqLtvBps;
        uint16 liqFeeBps;
        uint16 floorBps;
        uint32 auctionDuration;
        uint32 minTerm;
        uint16 originationFeeBps;
        uint16 protocolShareBps;
        uint16 keeperShareBps;
    }

    enum LoanState {
        None,
        Active,
        Auction,
        Closed,
        Liquidated
    }

    /// @param keeper Address that started the auction; it is paid the keeper share of the liquidation fee.
    struct Loan {
        address borrower;
        address escrow;
        uint256 tokenId;
        uint256 normDebt;
        LoanState state;
        uint64 auctionStart;
        address keeper;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint8 public constant REASON_LTV = 0;
    uint8 public constant REASON_EXPIRY = 1;
    uint16 public constant MAX_ORIGINATION_FEE_BPS = 100;
    uint16 public constant MAX_PROTOCOL_SHARE_BPS = 5000;

    address public immutable vault;
    IERC20 public immutable musd;
    IVeBTC public immutable ve;
    /// @notice The ERC-20 that veBTC locks (BTC on Mezo).
    IERC20 public immutable btc;
    IPoolsVoter public immutable voter;
    IRewardsDistributor public immutable distributor;
    IPriceSource public immutable oracle;
    /// @notice MUSD/USD peg whose health gates new borrowing.
    IMusdPeg public immutable peg;
    LinearKinkIrm public immutable irm;
    /// @notice Recipient of origination fees and of the treasury part of liquidation fees.
    address public immutable treasury;
    /// @notice LoanEscrow implementation cloned once per loan.
    address public immutable escrowImplementation;

    uint16 internal immutable maxLtvTimedBps;
    uint16 internal immutable maxLtvPermanentBps;
    uint16 internal immutable liqLtvBps;
    uint16 internal immutable liqFeeBps;
    uint16 internal immutable floorBps;
    uint32 internal immutable auctionDuration;
    uint32 internal immutable minTerm;
    uint16 internal immutable originationFeeBps;
    uint16 internal immutable protocolShareBps;
    uint16 internal immutable keeperShareBps;

    /// @notice MUSD held by the line and available to lend or deallocate.
    uint256 public cash;
    /// @notice Position last reported to the vault (the vault's allocation for this adapter's ids).
    uint256 public allocation;
    /// @notice Cumulative borrow index, WAD, as of `lastAccrual`.
    uint256 public borrowIndex = WAD;
    /// @notice Sum of every open loan's normalised debt.
    uint256 public totalNormDebt;
    uint256 public lastAccrual;
    /// @notice Cumulative shortfall of auctions settled below debt. Never decreases; covers add cash instead.
    uint256 public badDebtTotal;
    /// @dev Interest booked into the borrow index plus the lenders' part of liquidation fees, as of `lastAccrual`.
    uint256 internal interestBooked;
    /// @notice Id of the most recent loan; loan ids start at 1.
    uint256 public loanCount;
    /// @notice The only address allowed to call `receiveCover`. Set once.
    address public suretyPool;
    /// @notice When true, `open` and `borrowMore` are disabled.
    bool public paused;

    mapping(uint256 loanId => Loan) internal loans;
    /// @notice Loan behind each escrow, zero for addresses that are not escrows.
    mapping(address escrow => uint256) public loanIdOfEscrow;

    event InterestAccrued(uint256 borrowIndex, uint256 interest);
    /// @param amount Debt taken on; the borrower received it less the origination fee.
    event Opened(uint256 indexed loanId, address indexed borrower, uint256 indexed tokenId, uint256 amount);
    /// @param amount Debt taken on; the borrower received it less the origination fee.
    event Borrowed(uint256 indexed loanId, uint256 amount);
    event OriginationFeePaid(uint256 indexed loanId, uint256 fee);
    event Repaid(uint256 indexed loanId, address indexed payer, uint256 amount);
    event Closed(uint256 indexed loanId);
    event Extended(uint256 indexed loanId, uint256 newEnd);
    event CollateralAdded(uint256 indexed loanId, uint256 amount);
    /// @param reason REASON_LTV or REASON_EXPIRY.
    /// @param keeper The caller, paid the keeper share of the liquidation fee.
    event AuctionStarted(uint256 indexed loanId, uint8 reason, address indexed keeper);
    event Bid(
        uint256 indexed loanId, address indexed bidder, uint256 price, uint256 debt, uint256 shortfall, uint256 surplus
    );
    /// @notice Split of the liquidation fee kept on a bid; `toLenders` stays in the line's cash.
    event LiquidationFeePaid(
        uint256 indexed loanId, address indexed keeper, uint256 toLenders, uint256 toTreasury, uint256 toKeeper
    );
    event CoverReceived(uint256 assets);
    event SuretyPoolSet(address indexed pool);
    event PauseSet(bool paused);

    error ZeroAddress();
    error BadParams();
    error AssetMismatch();
    error NotVault();
    error NotBorrower();
    error NotTokenOwner();
    error NotSuretyPool();
    error SuretyPoolAlreadySet();
    error LinePaused();
    error ZeroAmount();
    error NotNormalNFT();
    error GrantLock();
    error NoLock();
    error TermTooShort();
    error AboveMaxLtv();
    error InsufficientCash();
    error EscrowMismatch();
    /// @notice The loan is not Active.
    error LoanNotActive();
    /// @notice The loan is neither Active nor in Auction.
    error LoanClosed();
    /// @notice The loan is not in Auction.
    error NoAuction();
    error NotLiquidatable();
    error PriceAboveMax();
    /// @notice The MUSD peg is unhealthy, so no new MUSD is lent.
    error PegUnhealthy();

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert LinePaused();
        _;
    }

    /// @dev Besides the limits in Params, requires the floor to sit above debt plus fee at the trigger
    /// (`floorBps * BPS > liqLtvBps * (BPS + liqFeeBps)`): an auction started at the liquidation LTV that ends at the
    /// floor still covers the debt and the fee unless the collateral keeps falling.
    constructor(
        address vault_,
        IERC20 musd_,
        IVeBTC ve_,
        IPoolsVoter voter_,
        IRewardsDistributor distributor_,
        IPriceSource oracle_,
        IMusdPeg peg_,
        LinearKinkIrm irm_,
        Params memory p,
        address treasury_,
        address owner_
    ) Ownable(owner_) {
        if (
            vault_ == address(0) || address(musd_) == address(0) || address(ve_) == address(0)
                || address(voter_) == address(0) || address(distributor_) == address(0)
                || address(oracle_) == address(0) || address(peg_) == address(0) || address(irm_) == address(0)
                || treasury_ == address(0)
        ) revert ZeroAddress();
        if (IVaultV2(vault_).asset() != address(musd_)) revert AssetMismatch();
        _checkParams(p);

        vault = vault_;
        musd = musd_;
        ve = ve_;
        btc = IERC20(ve_.token());
        voter = voter_;
        distributor = distributor_;
        oracle = oracle_;
        peg = peg_;
        irm = irm_;
        treasury = treasury_;
        escrowImplementation = address(new LoanEscrow());

        maxLtvTimedBps = p.maxLtvTimedBps;
        maxLtvPermanentBps = p.maxLtvPermanentBps;
        liqLtvBps = p.liqLtvBps;
        liqFeeBps = p.liqFeeBps;
        floorBps = p.floorBps;
        auctionDuration = p.auctionDuration;
        minTerm = p.minTerm;
        originationFeeBps = p.originationFeeBps;
        protocolShareBps = p.protocolShareBps;
        keeperShareBps = p.keeperShareBps;

        lastAccrual = block.timestamp;
        musd_.forceApprove(vault_, type(uint256).max);
    }

    /* VaultV2 adapter */

    /// @notice Books MUSD the vault has just transferred in. Returns the change that makes the vault's allocation
    /// equal the line's current position (new assets plus interest since the last report).
    function allocate(bytes memory, uint256 assets, bytes4, address)
        external
        nonReentrant
        onlyVault
        returns (bytes32[] memory, int256)
    {
        _accrue();
        // VaultV2 emits Allocate with the assets and the returned change.
        // forge-lint: disable-next-line(missing-events-arithmetic)
        cash += assets;
        return (ids(), _syncAllocation());
    }

    /// @notice Releases `assets` of idle cash for the vault to pull. Lent-out MUSD cannot be deallocated.
    function deallocate(bytes memory, uint256 assets, bytes4, address)
        external
        nonReentrant
        onlyVault
        returns (bytes32[] memory, int256)
    {
        _accrue();
        if (assets > cash) revert InsufficientCash();
        // VaultV2 emits Deallocate with the assets and the returned change.
        // forge-lint: disable-next-line(missing-events-arithmetic)
        cash -= assets;
        return (ids(), _syncAllocation());
    }

    /// @notice VaultV2 cap ids: this adapter and the veBTC collateral.
    function ids() public view returns (bytes32[] memory ids_) {
        ids_ = new bytes32[](2);
        ids_[0] = LineIds.adapterId(address(this));
        ids_[1] = LineIds.collateralId(address(ve));
    }

    /// @inheritdoc ISuretyLine
    function receiveCover(uint256 assets) external nonReentrant {
        if (msg.sender != suretyPool) revert NotSuretyPool();
        _accrue();
        cash += assets;
        emit CoverReceived(assets);
        musd.safeTransferFrom(msg.sender, address(this), assets);
    }

    /// @notice Books interest up to now. Every state-changing entry point does this first.
    function accrueInterest() external nonReentrant {
        _accrue();
    }

    /* Borrowing */

    /// @notice Borrows `amount` MUSD against `tokenId`, which moves into a fresh escrow. The caller must own the NFT
    /// and have approved this line for it. The loan owes `amount`; the caller receives it less the origination fee.
    function open(uint256 tokenId, uint256 amount) external nonReentrant whenNotPaused returns (uint256 loanId) {
        if (amount == 0) revert ZeroAmount();
        if (ve.ownerOf(tokenId) != msg.sender) revert NotTokenOwner();
        if (ve.escrowType(tokenId) != IVeBTC.EscrowType.NORMAL) revert NotNormalNFT();
        if (ve.grantManager(tokenId) != address(0)) revert GrantLock();
        IVeBTC.LockedBalance memory lock = ve.locked(tokenId);
        if (lock.amount <= 0) revert NoLock();
        _checkTerm(lock);
        _checkPeg();

        _accrue();
        if (amount > cash) revert InsufficientCash();
        _checkMaxLtv(lock, amount);

        uint256 normDebt = _toNormUp(amount);
        address escrow = Clones.clone(escrowImplementation);
        loanId = ++loanCount;
        loans[loanId] = Loan({
            borrower: msg.sender,
            escrow: escrow,
            tokenId: tokenId,
            normDebt: normDebt,
            state: LoanState.Active,
            auctionStart: 0,
            keeper: address(0)
        });
        loanIdOfEscrow[escrow] = loanId;
        totalNormDebt += normDebt;
        cash -= amount;
        emit Opened(loanId, msg.sender, tokenId, amount);
        uint256 fee = _originationFee(loanId, amount);

        LoanEscrow(escrow).initialize(address(this), ve, voter, distributor, btc, tokenId);
        ve.transferFrom(msg.sender, escrow, tokenId);
        if (ve.ownerOf(tokenId) != escrow) revert EscrowMismatch();
        _payOut(amount, fee);
    }

    /// @notice Borrows `amount` more MUSD on an Active loan, subject to the same LTV, term and peg checks as `open`.
    /// The debt grows by `amount`; the caller receives it less the origination fee.
    function borrowMore(uint256 loanId, uint256 amount) external nonReentrant whenNotPaused {
        Loan storage record = _borrowerLoan(loanId, true);
        if (amount == 0) revert ZeroAmount();
        IVeBTC.LockedBalance memory lock = ve.locked(record.tokenId);
        _checkTerm(lock);
        _checkPeg();

        _accrue();
        if (amount > cash) revert InsufficientCash();
        _checkMaxLtv(lock, _toDebt(record.normDebt, borrowIndex) + amount);

        uint256 normDelta = _toNormUp(amount);
        record.normDebt += normDelta;
        totalNormDebt += normDelta;
        cash -= amount;
        emit Borrowed(loanId, amount);
        uint256 fee = _originationFee(loanId, amount);

        _payOut(amount, fee);
    }

    /// @notice Repays up to `amount` of the loan's debt from the caller. Anyone may repay. Repaying the full debt,
    /// also mid-auction, closes the loan and returns the NFT to the borrower. Never reads the oracle or the peg.
    /// @return repaid MUSD taken from the caller.
    function repay(uint256 loanId, uint256 amount) external nonReentrant returns (uint256 repaid) {
        Loan storage record = _openLoan(loanId);
        if (amount == 0) revert ZeroAmount();

        _accrue();
        bool full;
        (repaid, full) = _applyRepayment(record, amount);
        emit Repaid(loanId, msg.sender, repaid);
        if (full) emit Closed(loanId);

        musd.safeTransferFrom(msg.sender, address(this), repaid);
        if (full) LoanEscrow(record.escrow).release(record.borrower);
    }

    /// @notice Extends the escrowed lock to `now + duration` (rounded down to weeks), which moves the maturity.
    /// veBTC rejects this for permanent and for already expired locks.
    function extend(uint256 loanId, uint256 duration) external nonReentrant {
        Loan storage record = _borrowerLoan(loanId, true);
        uint256 newEnd = LoanEscrow(record.escrow).extend(duration);
        emit Extended(loanId, newEnd);
    }

    /// @notice Adds `btcAmount` of the caller's BTC to the escrowed lock.
    function addCollateral(uint256 loanId, uint256 btcAmount) external nonReentrant {
        Loan storage record = _borrowerLoan(loanId, true);
        if (btcAmount == 0) revert ZeroAmount();
        emit CollateralAdded(loanId, btcAmount);
        btc.safeTransferFrom(msg.sender, record.escrow, btcAmount);
        LoanEscrow(record.escrow).increaseAmount(btcAmount);
    }

    /* Escrow actions (borrower only) */

    /// @notice Votes the escrowed NFT on Mezo's PoolsVoter. Active loans only.
    /// @dev Not once the loan is in Auction: Mezo's PoolsVoter allows one vote or reset per NFT per Mezo epoch, so a
    /// vote just before a bid would hand the bidder an NFT it cannot reset, withdraw, merge or split until the next
    /// Mezo epoch, and bidders would discount for it.
    function escrowVote(uint256 loanId, address[] calldata pools, uint256[] calldata weights) external nonReentrant {
        Loan storage record = _borrowerLoan(loanId, true);
        LoanEscrow(record.escrow).vote(pools, weights);
    }

    /// @notice Clears the escrowed NFT's PoolsVoter votes. Active loans only, for the same reason as `escrowVote`
    /// (a reset uses up the NFT's one PoolsVoter action of the Mezo epoch).
    function escrowReset(uint256 loanId) external nonReentrant {
        Loan storage record = _borrowerLoan(loanId, true);
        LoanEscrow(record.escrow).reset();
    }

    /// @notice Claims PoolsVoter fees and bribes for the escrowed NFT; what the claim pays is forwarded to the
    /// borrower.
    /// @dev Also during an auction: claiming only pays out rewards the NFT earned while the borrower held it, and
    /// changes neither the lock nor its votes, so it takes nothing from what the bidder buys.
    function escrowClaim(uint256 loanId, address[] calldata rewards, address[][] calldata tokens)
        external
        nonReentrant
    {
        Loan storage record = _borrowerLoan(loanId, false);
        LoanEscrow(record.escrow).claimRewards(rewards, tokens, record.borrower);
    }

    /// @notice Claims the escrowed NFT's veBTC rebase: compounded into the lock while it is live, paid to the
    /// borrower once it has expired.
    /// @dev Also during an auction: a live lock only grows (more collateral for the bidder), and an expired one keeps
    /// its amount while the rebase it earned goes to the borrower.
    function escrowClaimRebase(uint256 loanId) external nonReentrant {
        Loan storage record = _borrowerLoan(loanId, false);
        LoanEscrow(record.escrow).claimRebase(record.borrower);
    }

    /* Liquidation */

    /// @notice Starts the Dutch auction of an Active loan whose LTV reached `liqLtvBps` or whose timed lock has
    /// reached its end. Permissionless; the caller is recorded as the loan's keeper and paid the keeper share of the
    /// liquidation fee when the NFT sells.
    function startAuction(uint256 loanId) external nonReentrant {
        Loan storage record = loans[loanId];
        if (record.state != LoanState.Active) revert LoanNotActive();

        _accrue();
        IVeBTC.LockedBalance memory lock = ve.locked(record.tokenId);
        bool ltvBreached = _toDebt(record.normDebt, borrowIndex) * BPS >= _collateralValue(lock) * liqLtvBps;
        bool expired = !lock.isPermanent && block.timestamp >= lock.end;
        if (!ltvBreached && !expired) revert NotLiquidatable();
        uint8 reason = ltvBreached ? REASON_LTV : REASON_EXPIRY;

        record.state = LoanState.Auction;
        // Safe: block timestamps fit in 64 bits for billions of years.
        // forge-lint: disable-next-line(unsafe-typecast)
        record.auctionStart = uint64(block.timestamp);
        record.keeper = msg.sender;
        emit AuctionStarted(loanId, reason, msg.sender);
    }

    /// @notice Current auction price in MUSD: live collateral value, decaying linearly from 100% to `floorBps`
    /// over `auctionDuration`, then flat at the floor.
    function auctionPrice(uint256 loanId) public view returns (uint256) {
        Loan storage record = loans[loanId];
        if (record.state != LoanState.Auction) revert NoAuction();
        uint256 value = _collateralValue(ve.locked(record.tokenId));
        uint256 elapsed = block.timestamp - record.auctionStart;
        if (elapsed >= auctionDuration) return value * floorBps / BPS;
        uint256 span = BPS * auctionDuration;
        return Math.mulDiv(value, span - (BPS - floorBps) * elapsed, span);
    }

    /// @notice Buys the auctioned NFT at the current price, if it is at most `maxPrice`. The proceeds cover the debt
    /// and then the liquidation fee, which is split between lenders, treasury and keeper; any surplus goes to the
    /// borrower, and a price below the debt records the difference as bad debt.
    function bid(uint256 loanId, uint256 maxPrice) external nonReentrant {
        Loan storage record = loans[loanId];
        if (record.state != LoanState.Auction) revert NoAuction();

        _accrue();
        uint256 price = auctionPrice(loanId);
        if (price > maxPrice) revert PriceAboveMax();
        uint256 debt = _toDebt(record.normDebt, borrowIndex);
        uint256 owed = debt + debt * liqFeeBps / BPS;
        uint256 toLine = price < owed ? price : owed;
        uint256 surplus = price - toLine;
        uint256 shortfall = price < debt ? debt - price : 0;

        totalNormDebt -= record.normDebt;
        record.normDebt = 0;
        record.state = LoanState.Liquidated;
        badDebtTotal += shortfall;
        emit Bid(loanId, msg.sender, price, debt, shortfall, surplus);
        (uint256 toTreasury, uint256 toKeeper) =
            _splitLiquidationFee(loanId, record.keeper, toLine > debt ? toLine - debt : 0);
        cash += toLine - toTreasury - toKeeper;

        musd.safeTransferFrom(msg.sender, address(this), price);
        if (surplus > 0) musd.safeTransfer(record.borrower, surplus);
        if (toTreasury > 0) musd.safeTransfer(treasury, toTreasury);
        if (toKeeper > 0) musd.safeTransfer(record.keeper, toKeeper);
        LoanEscrow(record.escrow).release(msg.sender);
    }

    /* Owner */

    /// @notice Sets the SuretyPool allowed to call `receiveCover`. One-shot.
    function setSuretyPool(address pool) external onlyOwner {
        if (pool == address(0)) revert ZeroAddress();
        if (suretyPool != address(0)) revert SuretyPoolAlreadySet();
        suretyPool = pool;
        emit SuretyPoolSet(pool);
    }

    /// @notice Disables or re-enables `open` and `borrowMore`. Repayment, escrow actions and liquidation stay on.
    function pause(bool paused_) external onlyOwner {
        paused = paused_;
        emit PauseSet(paused_);
    }

    /* Views */

    /// @inheritdoc IEscrowRegistry
    function isEscrow(address account) external view returns (bool) {
        return loanIdOfEscrow[account] != 0;
    }

    /// @inheritdoc IEscrowRegistry
    function borrowerOfEscrow(address escrow) external view returns (address) {
        uint256 loanId = loanIdOfEscrow[escrow];
        return loanId == 0 ? address(0) : loans[loanId].borrower;
    }

    function params() external view returns (Params memory) {
        return Params({
            maxLtvTimedBps: maxLtvTimedBps,
            maxLtvPermanentBps: maxLtvPermanentBps,
            liqLtvBps: liqLtvBps,
            liqFeeBps: liqFeeBps,
            floorBps: floorBps,
            auctionDuration: auctionDuration,
            minTerm: minTerm,
            originationFeeBps: originationFeeBps,
            protocolShareBps: protocolShareBps,
            keeperShareBps: keeperShareBps
        });
    }

    function loan(uint256 loanId) external view returns (Loan memory) {
        return loans[loanId];
    }

    /// @notice Current debt of `loanId`, interest included.
    function debtOf(uint256 loanId) external view returns (uint256) {
        return _toDebt(loans[loanId].normDebt, _currentIndex());
    }

    /// @notice Current debt of all open loans, interest included.
    function totalDebt() public view returns (uint256) {
        return _toDebt(totalNormDebt, _currentIndex());
    }

    /// @notice Cash plus debt: the line's position as VaultV2 values it.
    /// @dev Interest pending since the last accrual is included, so VaultV2 sees it without a transaction here.
    function realAssets() external view returns (uint256) {
        return cash + totalDebt();
    }

    /// @inheritdoc ISuretyLine
    /// @dev Interest pending since the last accrual is included, as in `realAssets`.
    function interestEarnedTotal() external view returns (uint256) {
        return interestBooked + _toDebt(totalNormDebt, _currentIndex()) - _toDebt(totalNormDebt, borrowIndex);
    }

    /// @notice Debt / (cash + debt), WAD.
    function utilizationWad() external view returns (uint256) {
        return _utilization(cash, totalDebt());
    }

    /// @notice LTV (rounded down) and MUSD collateral value of a loan, at the live oracle price.
    function healthOf(uint256 loanId) external view returns (uint256 ltvBps, uint256 collateralValue) {
        Loan storage record = loans[loanId];
        collateralValue = _collateralValue(ve.locked(record.tokenId));
        uint256 debt = _toDebt(record.normDebt, _currentIndex());
        if (debt == 0) return (0, collateralValue);
        ltvBps = collateralValue == 0 ? type(uint256).max : debt * BPS / collateralValue;
    }

    /// @notice Largest amount `open` would lend against `tokenId` now, capped by cash. Zero if the NFT is not
    /// eligible (not NORMAL, a grant lock, no lock, or a timed lock ending within `minTerm`). The borrower would
    /// receive it less the origination fee. Ignores the pause and the peg.
    function maxBorrow(uint256 tokenId) external view returns (uint256) {
        if (ve.escrowType(tokenId) != IVeBTC.EscrowType.NORMAL || ve.grantManager(tokenId) != address(0)) return 0;
        IVeBTC.LockedBalance memory lock = ve.locked(tokenId);
        if (lock.amount <= 0) return 0;
        if (!lock.isPermanent && lock.end < block.timestamp + minTerm) return 0;
        uint256 limit = _collateralValue(lock) * _maxLtv(lock) / BPS;
        return limit < cash ? limit : cash;
    }

    /* Internals */

    /// @dev Emits InterestAccrued whenever the index moves.
    function _accrue() internal {
        if (block.timestamp == lastAccrual) return;
        uint256 oldIndex = borrowIndex;
        uint256 newIndex = _currentIndex();
        // forge-lint: disable-next-line(missing-events-arithmetic)
        borrowIndex = newIndex;
        // forge-lint: disable-next-line(missing-events-arithmetic)
        lastAccrual = block.timestamp;
        if (newIndex != oldIndex) {
            uint256 interest = _toDebt(totalNormDebt, newIndex) - _toDebt(totalNormDebt, oldIndex);
            interestBooked += interest;
            emit InterestAccrued(newIndex, interest);
        }
    }

    /// @dev Borrow index at the current timestamp: simple interest since `lastAccrual` at the rate implied by the
    /// utilisation as of `lastAccrual`. Exactly what `_accrue` would store.
    function _currentIndex() internal view returns (uint256) {
        uint256 index = borrowIndex;
        uint256 elapsed = block.timestamp - lastAccrual;
        if (elapsed == 0 || totalNormDebt == 0) return index;
        uint256 rate = irm.ratePerSecond(_utilization(cash, _toDebt(totalNormDebt, index)));
        return index + Math.mulDiv(index, rate * elapsed, WAD);
    }

    function _syncAllocation() internal returns (int256 change) {
        uint256 position = cash + _toDebt(totalNormDebt, borrowIndex);
        // Both values are bounded by MUSD supply, far below 2**255.
        // forge-lint: disable-next-line(unsafe-typecast)
        change = int256(position) - int256(allocation);
        allocation = position;
    }

    function _checkParams(Params memory p) internal pure {
        if (
            p.maxLtvTimedBps == 0 || p.maxLtvPermanentBps == 0 || p.maxLtvTimedBps >= p.liqLtvBps
                || p.maxLtvPermanentBps >= p.liqLtvBps || p.liqLtvBps > BPS || p.liqFeeBps > BPS || p.floorBps > BPS
                || uint256(p.floorBps) * BPS <= uint256(p.liqLtvBps) * (BPS + p.liqFeeBps) || p.auctionDuration == 0
                || p.originationFeeBps > MAX_ORIGINATION_FEE_BPS || p.protocolShareBps > MAX_PROTOCOL_SHARE_BPS
                || p.keeperShareBps > BPS
        ) revert BadParams();
    }

    /// @dev Reverts with PegUnhealthy unless the peg reports MUSD healthy.
    function _checkPeg() internal view {
        if (!peg.pegHealthy()) revert PegUnhealthy();
    }

    /// @dev Origination fee on `amount`, rounded down; emits OriginationFeePaid when non-zero.
    function _originationFee(uint256 loanId, uint256 amount) internal returns (uint256 fee) {
        fee = amount * originationFeeBps / BPS;
        if (fee > 0) emit OriginationFeePaid(loanId, fee);
    }

    /// @dev Pays a borrowing of `amount` out of the line: `amount - fee` to the caller, `fee` to the treasury.
    function _payOut(uint256 amount, uint256 fee) internal {
        musd.safeTransfer(msg.sender, amount - fee);
        if (fee > 0) musd.safeTransfer(treasury, fee);
    }

    /// @dev Books a repayment of up to `amount` on `record`, interest accrued: the whole debt when `amount` covers
    /// it (closing the loan), else `amount` with the normalised debt burned rounded down. Adds the repayment to cash.
    function _applyRepayment(Loan storage record, uint256 amount) internal returns (uint256 repaid, bool full) {
        uint256 debt = _toDebt(record.normDebt, borrowIndex);
        full = amount >= debt;
        if (full) {
            repaid = debt;
            totalNormDebt -= record.normDebt;
            record.normDebt = 0;
            record.state = LoanState.Closed;
        } else {
            repaid = amount;
            // Rounded down, and strictly below the loan's normalised debt because amount < debt.
            uint256 normDelta = Math.mulDiv(amount, WAD, borrowIndex);
            record.normDebt -= normDelta;
            totalNormDebt -= normDelta;
        }
        cash += repaid;
    }

    /// @dev Splits the liquidation fee a bid leaves in the line: the lenders' part is booked as income, the protocol
    /// part is returned split between treasury and keeper for the caller to pay out. Nothing to split, no event.
    function _splitLiquidationFee(uint256 loanId, address keeper, uint256 fee)
        internal
        returns (uint256 toTreasury, uint256 toKeeper)
    {
        if (fee == 0) return (0, 0);
        uint256 protocolPart = fee * protocolShareBps / BPS;
        // The keeper's share is of the rounded protocol part, so the three parts add up to the fee exactly.
        // forge-lint: disable-next-line(divide-before-multiply)
        toKeeper = protocolPart * keeperShareBps / BPS;
        toTreasury = protocolPart - toKeeper;
        uint256 toLenders = fee - protocolPart;
        interestBooked += toLenders;
        emit LiquidationFeePaid(loanId, keeper, toLenders, toTreasury, toKeeper);
    }

    function _openLoan(uint256 loanId) internal view returns (Loan storage record) {
        record = loans[loanId];
        if (record.state != LoanState.Active && record.state != LoanState.Auction) revert LoanClosed();
    }

    /// @dev Loan of the caller; Active only, or Active / Auction when `activeOnly` is false.
    function _borrowerLoan(uint256 loanId, bool activeOnly) internal view returns (Loan storage record) {
        record = activeOnly ? loans[loanId] : _openLoan(loanId);
        if (activeOnly && record.state != LoanState.Active) revert LoanNotActive();
        if (msg.sender != record.borrower) revert NotBorrower();
    }

    function _checkTerm(IVeBTC.LockedBalance memory lock) internal view {
        if (!lock.isPermanent && lock.end < block.timestamp + minTerm) revert TermTooShort();
    }

    /// @dev Checks the principal against the max LTV; the debt recorded for it may exceed it by rounding dust.
    function _checkMaxLtv(IVeBTC.LockedBalance memory lock, uint256 debt) internal view {
        if (debt * BPS > _collateralValue(lock) * _maxLtv(lock)) revert AboveMaxLtv();
    }

    function _maxLtv(IVeBTC.LockedBalance memory lock) internal view returns (uint256) {
        return lock.isPermanent ? maxLtvPermanentBps : maxLtvTimedBps;
    }

    /// @dev MUSD value of the locked BTC. Reverts if the oracle does (stale or non-positive price).
    function _collateralValue(IVeBTC.LockedBalance memory lock) internal view returns (uint256) {
        uint256 price = oracle.priceWad();
        if (lock.amount <= 0) return 0;
        // Safe: amount is strictly positive here.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(int256(lock.amount)) * price / WAD;
    }

    function _utilization(uint256 cash_, uint256 debt) internal pure returns (uint256) {
        uint256 total = cash_ + debt;
        return total == 0 ? 0 : Math.mulDiv(debt, WAD, total);
    }

    function _toDebt(uint256 normDebt, uint256 index) internal pure returns (uint256) {
        return Math.mulDiv(normDebt, index, WAD, Math.Rounding.Ceil);
    }

    function _toNormUp(uint256 amount) internal view returns (uint256) {
        return Math.mulDiv(amount, WAD, borrowIndex, Math.Rounding.Ceil);
    }
    // forge-lint: disable-end(reentrancy-events)
}
