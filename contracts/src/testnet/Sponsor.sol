// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @notice The veBTC (Mezo VotingEscrow) calls the Sponsor makes.
interface IVeBTCLocks {
    /// @notice The locked ERC-20: Mezo's BTC precompile.
    function token() external view returns (address);

    /// @notice Pulls `value` of `token()` from the caller with `transferFrom` and mints `to` a lock ending at
    /// `now + lockDuration` rounded down to whole weeks (at most veBTC's maximum, 28 days). The mint makes no
    /// ERC-721 receiver callback.
    function createLockFor(uint256 value, uint256 lockDuration, address to) external returns (uint256 tokenId);
}

/// @title Sponsor
/// @notice TESTNET ONLY: never deploy it on mainnet, where every wallet a relayer serves would get real BTC and MUSD.
/// Starter kits that let a brand-new wallet try Surety with no setup: a little BTC for gas, a small veBTC lock owned
/// by the wallet to borrow against on the veBTC credit line, and some test MUSD. The owner funds the contract and
/// sets the amounts; relayers the owner names hand out at most one kit per wallet. The `StarterKit` events are the
/// public ledger of the outside wallets that tried the product.
/// @dev
/// - BTC on Mezo is one balance seen two ways: the native coin that pays gas, and the ERC-20 precompile at
///   0x7b7C…0000 (`balanceOf(a) == a.balance`). The Sponsor moves BTC only through the precompile. The gas money is
///   a precompile `transfer`: it arrives as native BTC and runs no code at the recipient. veBTC's `createLockFor`
///   pulls the lock from the Sponsor with `transferFrom`, so the Sponsor approves veBTC for exactly the lock first.
///   `receive` takes native BTC so the owner can fund it with a plain transfer; on Mezo that is the same balance.
/// - Lock length: veBTC rounds the end down to whole weeks, so `lockDuration` is at least `minTerm + 1 week`. The
///   lock then always ends more than `minTerm` from now, as the credit line requires to open a loan. It is at most
///   28 days, veBTC's maximum.
/// - Limits: one kit per wallet, ever; at most `dailyLimit` kits per UTC day, so a leaked relayer key costs at most a
///   day of kits before the owner removes it; amounts capped by the MAX_ constants. A daily limit of 0 stops kits.
/// - The owner can withdraw everything at any time. Nothing here belongs to users. `withdraw` moves ERC-20s only, so
///   a kit never goes to the Sponsor itself (its veBTC NFT would be stuck); relayers serve wallets, and a contract
///   that cannot use a veBTC NFT keeps it stuck just the same.
/// - Refuses to deploy on Mezo mainnet (chain 31612).
contract Sponsor is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // Every state-changing entry point is nonReentrant or owner-only, and `starterKit` records the claim before any
    // transfer. veBTC, BTC and MUSD are fixed at deployment.
    // forge-lint: disable-start(reentrancy-events)

    uint256 public constant MAX_BTC_GAS = 0.01e18;
    uint256 public constant MAX_LOCK_AMOUNT = 0.1e18;
    uint256 public constant MAX_MUSD = 10_000e18;
    /// @notice veBTC's maximum lock time (its `maxLockTime`, which veBTC does not expose).
    uint256 public constant MAX_LOCK_DURATION = 28 days;
    uint256 public constant MAX_DAILY_LIMIT = 10_000;
    uint256 internal constant WEEK = 1 weeks;
    uint256 internal constant MEZO_MAINNET = 31_612;

    IVeBTCLocks public immutable veBTC;
    /// @notice BTC as veBTC locks it: the precompile on Mezo.
    IERC20 public immutable btc;
    IERC20 public immutable musd;
    /// @notice The veBTC credit line's minimum lock time left to borrow, in seconds.
    uint256 public immutable minTerm;

    /// @notice BTC sent to each new wallet for gas.
    uint256 public btcGas;
    /// @notice BTC locked in veBTC for each new wallet; zero until the owner sets a kit.
    uint256 public lockAmount;
    /// @notice Test MUSD sent to each new wallet.
    uint256 public musdAmount;
    /// @notice Lock duration asked of veBTC (the end is rounded down to whole weeks).
    uint256 public lockDuration;
    /// @notice Kits per UTC day.
    uint256 public dailyLimit;
    uint256 public kitsIssued;

    mapping(address relayer => bool) public isRelayer;
    mapping(address user => bool) public claimed;
    /// @notice Kits handed out per UTC day (`block.timestamp / 1 days`).
    mapping(uint256 day => uint256) public kitsOnDay;

    event StarterKit(address indexed user, uint256 indexed tokenId, uint256 btcGas, uint256 lockAmount, uint256 musd);
    event RelayerSet(address indexed relayer, bool allowed);
    event KitSet(uint256 btcGas, uint256 lockAmount, uint256 musd, uint256 lockDuration);
    event DailyLimitSet(uint256 dailyLimit);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroLock();
    error AmountTooHigh();
    error BadLockDuration();
    error BadDailyLimit();
    error NotRelayer();
    error AlreadyClaimed(address user);
    error KitNotSet();
    error DailyLimitReached();
    error OutOfFunds();
    error MainnetNotAllowed();
    error SelfKit();

    /// @param veBTC_ Mezo's veBTC; BTC is its `token()`.
    /// @param musd_ The MUSD the vault lends (test MUSD).
    /// @param minTerm_ The veBTC credit line's `minTerm`, in seconds.
    /// @param owner_ Funds the Sponsor, sets kits and relayers, withdraws.
    constructor(IVeBTCLocks veBTC_, IERC20 musd_, uint256 minTerm_, address owner_) Ownable(owner_) {
        if (block.chainid == MEZO_MAINNET) revert MainnetNotAllowed();
        if (address(veBTC_) == address(0) || address(musd_) == address(0)) revert ZeroAddress();
        if (minTerm_ + WEEK > MAX_LOCK_DURATION) revert BadLockDuration();
        veBTC = veBTC_;
        btc = IERC20(veBTC_.token());
        musd = musd_;
        minTerm = minTerm_;
        lockDuration = MAX_LOCK_DURATION;
        dailyLimit = 100;
    }

    /// @notice Native BTC funding; on Mezo it is the same balance as `btc.balanceOf(this)`.
    receive() external payable {}

    /* Kits */

    /// @notice Hands `user` their starter kit: `btcGas` BTC for gas, a `lockAmount` veBTC lock owned by `user`, and
    /// `musdAmount` MUSD. Relayers only; once per wallet.
    /// @return tokenId The veBTC NFT minted to `user`.
    function starterKit(address user) external nonReentrant returns (uint256 tokenId) {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        if (user == address(0)) revert ZeroAddress();
        if (user == address(this)) revert SelfKit();
        if (claimed[user]) revert AlreadyClaimed(user);
        uint256 lock = lockAmount;
        if (lock == 0) revert KitNotSet();
        uint256 day = block.timestamp / 1 days;
        if (kitsOnDay[day] >= dailyLimit) revert DailyLimitReached();
        uint256 gas = btcGas;
        uint256 musdOut = musdAmount;
        if (btc.balanceOf(address(this)) < gas + lock || musd.balanceOf(address(this)) < musdOut) revert OutOfFunds();

        claimed[user] = true;
        ++kitsOnDay[day];
        ++kitsIssued;

        btc.forceApprove(address(veBTC), lock);
        tokenId = veBTC.createLockFor(lock, lockDuration, user);
        if (gas != 0) btc.safeTransfer(user, gas);
        if (musdOut != 0) musd.safeTransfer(user, musdOut);
        emit StarterKit(user, tokenId, gas, lock, musdOut);
    }

    /// @notice How many full kits the current balances pay for.
    function kitsLeft() external view returns (uint256 kits) {
        uint256 btcPerKit = btcGas + lockAmount;
        if (btcPerKit == 0) return 0;
        kits = btc.balanceOf(address(this)) / btcPerKit;
        uint256 m = musdAmount;
        if (m != 0) {
            uint256 byMusd = musd.balanceOf(address(this)) / m;
            if (byMusd < kits) kits = byMusd;
        }
    }

    /* Owner */

    /// @notice Sets what each kit holds. `lockDuration_` is between `minTerm + 1 week` and 28 days.
    function setKit(uint256 btcGas_, uint256 lockAmount_, uint256 musdAmount_, uint256 lockDuration_)
        external
        onlyOwner
    {
        if (lockAmount_ == 0) revert ZeroLock();
        if (btcGas_ > MAX_BTC_GAS || lockAmount_ > MAX_LOCK_AMOUNT || musdAmount_ > MAX_MUSD) revert AmountTooHigh();
        if (lockDuration_ < minTerm + WEEK || lockDuration_ > MAX_LOCK_DURATION) revert BadLockDuration();
        btcGas = btcGas_;
        lockAmount = lockAmount_;
        musdAmount = musdAmount_;
        lockDuration = lockDuration_;
        emit KitSet(btcGas_, lockAmount_, musdAmount_, lockDuration_);
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        // Emitted just below as RelayerSet.
        // forge-lint: disable-next-line(missing-events-access-control)
        isRelayer[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    /// @notice Kits per UTC day, at most MAX_DAILY_LIMIT; 0 stops kits.
    function setDailyLimit(uint256 dailyLimit_) external onlyOwner {
        if (dailyLimit_ > MAX_DAILY_LIMIT) revert BadDailyLimit();
        dailyLimit = dailyLimit_;
        emit DailyLimitSet(dailyLimit_);
    }

    /// @notice Sends `amount` of `token` to `to`. For BTC pass the precompile; on Mezo that moves the native balance.
    function withdraw(IERC20 token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Withdrawn(address(token), to, amount);
    }
}
