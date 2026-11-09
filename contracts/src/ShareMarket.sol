// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

/// @title ShareMarket
/// @notice Secondary market for Surety vault shares (srMUSD). A lender lists shares at a discount to the vault's live
/// share price and buyers fill the listing, in part or in full, for MUSD. It lets a lender leave while the vault's
/// cash is lent out and `redeem` would fail.
/// @dev
/// - Price: a fill of `shares` costs `convertToAssets(shares) * (BPS - discountBps) / BPS` MUSD, read when the fill
///   happens and rounded up, in the seller's favour. The treasury's fee is `feeBps` of that price, rounded down and
///   taken from the seller's side: the buyer pays exactly the price, the seller gets the price minus the fee.
/// - Receive-shares gate: VaultV2 asks its gate on every share transfer, and Surety's DepositGate refuses every
///   receiver but the SuretyPool while the pool reports `depositsPaused` (a loss pending, uncovered or being
///   re-recognised). The market checks first and reverts `ShareReceiptPaused`: `list` waits (the market cannot take
///   the shares), `fill` waits (the buyer cannot), and so does `cancel` (the seller cannot). `cancelAndRedeem` stays
///   open: it redeems the listed shares for the seller, as VaultV2 keeps withdrawals open, so listing never leaves a
///   seller with fewer ways out than holding.
/// - Dust: listings and fills are at least MIN_SHARES. A fill that would leave less than MIN_SHARES returns the
///   remainder to the seller and closes the listing, so no listing is left too small to fill.
/// - No owner and no admin. MUSD goes from the buyer to the seller and the treasury directly; the market holds only
///   the shares of open listings, and only their seller can take them back. Shares sent to the market outside `list`
///   are not recoverable.
contract ShareMarket is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // Every state-changing entry point is nonReentrant and updates the listing before any transfer. The vault, its
    // asset and the treasury are fixed at deployment.
    // forge-lint: disable-start(reentrancy-events)

    /// @param seller Who listed the shares and receives the MUSD of every fill.
    /// @param discountBps Discount to the vault's share price, in basis points.
    /// @param shares Shares still for sale, escrowed in the market; zero once the listing is closed.
    struct Listing {
        address seller;
        uint16 discountBps;
        uint256 shares;
    }

    uint16 public constant MAX_DISCOUNT_BPS = 2_000;
    uint16 public constant MAX_FEE_BPS = 100;
    /// @notice Smallest listing, fill and remainder, in share units: 1e-6 srMUSD (about 1e-6 MUSD; srMUSD has 18
    /// decimals). Keeps every open listing worth a nonzero price.
    uint256 public constant MIN_SHARES = 1e12;
    uint256 internal constant BPS = 10_000;

    IVaultV2 public immutable vault;
    /// @notice The vault's asset (MUSD), which buyers pay in.
    IERC20 public immutable asset;
    /// @notice Receives `feeBps` of every fill.
    address public immutable treasury;
    uint16 public immutable feeBps;
    /// @notice One whole share in share units, for per-share prices.
    uint256 internal immutable oneShare;

    /// @notice Listings ever made; ids run from 1 to `listingCount`.
    uint256 public listingCount;
    mapping(uint256 id => Listing) internal listings;
    /// @dev Open listing ids, unordered; `openIndex` is the 1-based position of an open id.
    uint256[] internal openIds;
    mapping(uint256 id => uint256) internal openIndex;
    mapping(address seller => uint256[]) internal sellerIds;

    event Listed(uint256 indexed id, address indexed seller, uint256 shares, uint16 discountBps);
    event Filled(
        uint256 indexed id, address indexed buyer, address indexed seller, uint256 shares, uint256 assets, uint256 fee
    );
    /// @param assets MUSD redeemed for the seller by `cancelAndRedeem`; zero when the shares went back.
    event Cancelled(uint256 indexed id, address indexed seller, uint256 shares, uint256 assets);
    /// @notice A fill left less than MIN_SHARES; it went back to the seller and the listing closed.
    event DustReturned(uint256 indexed id, address indexed seller, uint256 shares);

    error ZeroAddress();
    error FeeTooHigh();
    error DiscountTooHigh();
    error TooFewShares();
    error ListingClosed(uint256 id);
    error NotSeller();
    /// @notice The vault's receive-shares gate refuses `account` now (Surety's DepositGate while deposits are paused).
    error ShareReceiptPaused(address account);
    error ZeroPrice();
    error PriceAboveMax(uint256 assets, uint256 maxAssets);
    error RedeemedBelowMin(uint256 assets, uint256 minAssets);

    /// @param vault_ The Surety vault (VaultV2) whose shares trade here.
    /// @param treasury_ Fee recipient.
    /// @param feeBps_ Fee on every fill, at most MAX_FEE_BPS.
    constructor(IVaultV2 vault_, address treasury_, uint16 feeBps_) {
        if (address(vault_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        vault = vault_;
        asset = IERC20(vault_.asset());
        treasury = treasury_;
        feeBps = feeBps_;
        oneShare = 10 ** vault_.decimals();
    }

    /* Trading */

    /// @notice Lists `shares` of the caller's vault shares at `discountBps` below the share price. The shares move
    /// into the market (approve it on the vault first).
    /// @dev Reverts `ShareReceiptPaused` while the vault's gate refuses the market.
    function list(uint256 shares, uint16 discountBps) external nonReentrant returns (uint256 id) {
        if (shares < MIN_SHARES) revert TooFewShares();
        if (discountBps > MAX_DISCOUNT_BPS) revert DiscountTooHigh();
        _requireReceivable(address(this));

        id = ++listingCount;
        listings[id] = Listing({seller: msg.sender, discountBps: discountBps, shares: shares});
        openIds.push(id);
        openIndex[id] = openIds.length;
        sellerIds[msg.sender].push(id);

        IERC20(address(vault)).safeTransferFrom(msg.sender, address(this), shares);
        emit Listed(id, msg.sender, shares, discountBps);
    }

    /// @notice Buys up to `shares` from listing `id`, paying at most `maxAssets` MUSD (approve the market for MUSD).
    /// Fills `min(shares, remaining)`, priced now. If less than MIN_SHARES would remain, it goes back to the seller.
    /// @dev Reverts `ShareReceiptPaused` while the vault's gate refuses the caller.
    /// @return filled Shares bought.
    /// @return assets MUSD paid: the seller got `assets - fee`, the treasury `fee`.
    function fill(uint256 id, uint256 shares, uint256 maxAssets)
        external
        nonReentrant
        returns (uint256 filled, uint256 assets)
    {
        Listing storage l = listings[id];
        uint256 remaining = l.shares;
        if (remaining == 0) revert ListingClosed(id);
        filled = Math.min(shares, remaining);
        if (filled < MIN_SHARES) revert TooFewShares();
        _requireReceivable(msg.sender);

        uint256 fee;
        (assets, fee) = _price(filled, l.discountBps);
        if (assets == 0) revert ZeroPrice();
        if (assets > maxAssets) revert PriceAboveMax(assets, maxAssets);

        uint256 left = remaining - filled;
        uint256 dust = left < MIN_SHARES ? left : 0;
        l.shares = left - dust;
        if (l.shares == 0) _close(id);
        address seller = l.seller;

        asset.safeTransferFrom(msg.sender, seller, assets - fee);
        if (fee != 0) asset.safeTransferFrom(msg.sender, treasury, fee);
        IERC20(address(vault)).safeTransfer(msg.sender, filled);
        emit Filled(id, msg.sender, seller, filled, assets, fee);
        if (dust != 0) {
            IERC20(address(vault)).safeTransfer(seller, dust);
            emit DustReturned(id, seller, dust);
        }
    }

    /// @notice Closes the caller's listing `id` and returns its unsold shares.
    /// @dev Reverts `ShareReceiptPaused` while the vault's gate refuses the seller; `cancelAndRedeem` works then.
    function cancel(uint256 id) external nonReentrant returns (uint256 shares) {
        shares = _takeBack(id);
        _requireReceivable(msg.sender);
        IERC20(address(vault)).safeTransfer(msg.sender, shares);
        emit Cancelled(id, msg.sender, shares, 0);
    }

    /// @notice Closes the caller's listing `id` and redeems its unsold shares from the vault for the caller, for at
    /// least `minAssets` MUSD. Open while share receipt is paused; needs enough idle MUSD in the vault.
    function cancelAndRedeem(uint256 id, uint256 minAssets) external nonReentrant returns (uint256 assets) {
        uint256 shares = _takeBack(id);
        assets = vault.redeem(shares, msg.sender, address(this));
        if (assets < minAssets) revert RedeemedBelowMin(assets, minAssets);
        emit Cancelled(id, msg.sender, shares, assets);
    }

    /* Views */

    function listing(uint256 id) external view returns (Listing memory) {
        return listings[id];
    }

    function openListingCount() external view returns (uint256) {
        return openIds.length;
    }

    /// @notice Open listings from position `start`, at most `count` of them (positions are unordered and change as
    /// listings close).
    function openListings(uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, Listing[] memory items)
    {
        uint256 n = openIds.length;
        uint256 len = start >= n ? 0 : Math.min(count, n - start);
        ids = new uint256[](len);
        items = new Listing[](len);
        for (uint256 i; i < len; ++i) {
            ids[i] = openIds[start + i];
            items[i] = listings[ids[i]];
        }
    }

    /// @notice `seller`'s open listings.
    function listingsOf(address seller) external view returns (uint256[] memory ids) {
        uint256[] storage all = sellerIds[seller];
        ids = new uint256[](all.length);
        uint256 n = 0;
        for (uint256 i; i < all.length; ++i) {
            if (listings[all[i]].shares != 0) ids[n++] = all[i];
        }
        assembly ("memory-safe") {
            mstore(ids, n)
        }
    }

    /// @notice The cheapest open listing: every listing prices off the same share price, so it is the one with the
    /// largest discount (the earliest on a tie). All zero when nothing is listed.
    /// @dev Scans every open listing, for off-chain reads; with very many listings, page through `openListings`.
    /// @return id The listing.
    /// @return discountBps Its discount.
    /// @return shares Shares it still sells.
    /// @return pricePerShare MUSD for one whole share from it now (18 decimals), before the seller's fee.
    function bestListing()
        external
        view
        returns (uint256 id, uint16 discountBps, uint256 shares, uint256 pricePerShare)
    {
        uint256 n = openIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 candidate = openIds[i];
            uint16 d = listings[candidate].discountBps;
            if (id == 0 || d > discountBps || (d == discountBps && candidate < id)) {
                id = candidate;
                discountBps = d;
            }
        }
        if (id == 0) return (0, 0, 0, 0);
        shares = listings[id].shares;
        (pricePerShare,) = _price(oneShare, discountBps);
    }

    /// @notice What `fill(id, shares, ...)` would buy and cost now. All zero when the listing is closed or the fill
    /// is below MIN_SHARES. Does not check the gate (see `isOpen`).
    /// @return filled Shares the fill would buy.
    /// @return assets MUSD the buyer would pay.
    /// @return fee Part of `assets` that would go to the treasury.
    function quote(uint256 id, uint256 shares) external view returns (uint256 filled, uint256 assets, uint256 fee) {
        Listing storage l = listings[id];
        filled = Math.min(shares, l.shares);
        if (filled < MIN_SHARES) return (0, 0, 0);
        (assets, fee) = _price(filled, l.discountBps);
    }

    /// @notice Whether listing and filling are open now: false while the vault's gate holds new shares back (Surety's
    /// DepositGate does so for everyone but the SuretyPool, so the market's own answer is everyone's).
    function isOpen() external view returns (bool) {
        return vault.canReceiveShares(address(this));
    }

    /* Internals */

    /// @dev Price of `shares` at `discountBps`, rounded up, and the treasury's fee in it, rounded down.
    function _price(uint256 shares, uint16 discountBps) internal view returns (uint256 assets, uint256 fee) {
        uint256 value = vault.convertToAssets(shares);
        assets = Math.mulDiv(value, BPS - discountBps, BPS, Math.Rounding.Ceil);
        fee = assets * feeBps / BPS;
    }

    function _takeBack(uint256 id) internal returns (uint256 shares) {
        Listing storage l = listings[id];
        if (l.seller != msg.sender) revert NotSeller();
        shares = l.shares;
        if (shares == 0) revert ListingClosed(id);
        l.shares = 0;
        _close(id);
    }

    function _close(uint256 id) internal {
        uint256 index = openIndex[id];
        uint256 last = openIds[openIds.length - 1];
        openIds[index - 1] = last;
        openIndex[last] = index;
        openIds.pop();
        delete openIndex[id];
    }

    function _requireReceivable(address account) internal view {
        if (!vault.canReceiveShares(account)) revert ShareReceiptPaused(account);
    }
}
