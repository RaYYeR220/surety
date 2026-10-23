// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolsVoter} from "../interfaces/IPoolsVoter.sol";
import {IRewardsDistributor} from "../interfaces/IRewardsDistributor.sol";
import {IVeBTC} from "../interfaces/IVeBTC.sol";

/// @title LoanEscrow
/// @notice Custodies the veBTC NFT of exactly one VeBTCCreditLine loan. Deployed as an OpenZeppelin `Clones` proxy
/// per loan, so no NFT ever shares custody with another.
/// @dev Hardening against the veBTC custody attack surface:
/// - every target (veBTC, PoolsVoter, RewardsDistributor, BTC) is fixed at initialisation; there is no generic
///   call or execute, no meta-transaction support and no ether entry point;
/// - only the line can act, and the line only acts for the loan's borrower or its own settlement logic;
/// - no `onERC721Received`: NFTs arrive by plain `transferFrom` and leave only through `release`;
/// - claims forward balance deltas only, never pre-existing balances, and never touch the veBTC contract as a token.
contract LoanEscrow {
    using SafeERC20 for IERC20;

    /// @notice The credit line that controls this escrow.
    address public line;
    IVeBTC public ve;
    IPoolsVoter public voter;
    IRewardsDistributor public distributor;
    /// @notice The ERC-20 locked by veBTC.
    IERC20 public btc;
    /// @notice The veBTC NFT this escrow holds.
    uint256 public tokenId;

    error AlreadyInitialized();
    error NotLine();
    error ZeroAddress();

    modifier onlyLine() {
        if (msg.sender != line) revert NotLine();
        _;
    }

    /// @dev Locks the implementation; only clones are initialised.
    constructor() {
        line = address(this);
    }

    /// @notice Sets the fixed targets. Called once by the line in the transaction that creates the clone.
    function initialize(
        address line_,
        IVeBTC ve_,
        IPoolsVoter voter_,
        IRewardsDistributor distributor_,
        IERC20 btc_,
        uint256 tokenId_
    ) external {
        if (line != address(0)) revert AlreadyInitialized();
        if (
            line_ == address(0) || address(ve_) == address(0) || address(voter_) == address(0)
                || address(distributor_) == address(0) || address(btc_) == address(0)
        ) revert ZeroAddress();
        line = line_;
        ve = ve_;
        voter = voter_;
        distributor = distributor_;
        btc = btc_;
        tokenId = tokenId_;
    }

    /// @notice Sends the NFT to `to`: the borrower on repayment or the winning bidder on liquidation.
    function release(address to) external onlyLine {
        ve.transferFrom(address(this), to, tokenId);
    }

    /// @notice Votes the NFT on Mezo's PoolsVoter.
    function vote(address[] calldata pools, uint256[] calldata weights) external onlyLine {
        voter.vote(tokenId, pools, weights);
    }

    /// @notice Clears the NFT's PoolsVoter votes.
    function reset() external onlyLine {
        voter.reset(tokenId);
    }

    /// @notice Claims fees and bribes for the NFT and forwards what this claim added to `to`.
    /// @dev Balances are read before and after the claim; only the increase is forwarded, computed against the live
    /// balance so a token listed twice is forwarded once. The veBTC address is never treated as a token.
    function claimRewards(address[] calldata rewards, address[][] calldata tokens, address to) external onlyLine {
        uint256 count = 0;
        for (uint256 i; i < tokens.length; i++) {
            count += tokens[i].length;
        }

        uint256[] memory before = new uint256[](count);
        uint256 k = 0;
        for (uint256 i; i < tokens.length; i++) {
            for (uint256 j; j < tokens[i].length; j++) {
                address token = tokens[i][j];
                // The borrower picks the list; a failing token only fails the borrower's own claim.
                // forge-lint: disable-next-line(calls-loop)
                if (token != address(ve)) before[k] = IERC20(token).balanceOf(address(this));
                k++;
            }
        }

        voter.claimFeesAndBribes(rewards, tokens, tokenId);

        k = 0;
        for (uint256 i; i < tokens.length; i++) {
            for (uint256 j; j < tokens[i].length; j++) {
                address token = tokens[i][j];
                if (token != address(ve)) {
                    // forge-lint: disable-next-line(calls-loop)
                    uint256 balance = IERC20(token).balanceOf(address(this));
                    if (balance > before[k]) IERC20(token).safeTransfer(to, balance - before[k]);
                }
                k++;
            }
        }
    }

    /// @notice Claims the NFT's veBTC rebase and forwards any BTC the escrow holds to `to`.
    /// @dev While the lock is live the distributor compounds into it and nothing is paid out. Once a timed lock has
    /// expired the distributor pays the NFT owner, i.e. this escrow. The escrow holds no BTC between calls (top-ups
    /// pass straight into the lock), and the distributor's `claim` is permissionless, so the whole balance is
    /// forwarded: it can only be rebase paid to this escrow, by this call or by a third party's.
    function claimRebase(address to) external onlyLine {
        // The reported amount includes what was compounded into the lock; the balance is what was paid out.
        // forge-lint: disable-next-line(unused-return)
        distributor.claim(tokenId);
        uint256 balance = btc.balanceOf(address(this));
        if (balance > 0) btc.safeTransfer(to, balance);
    }

    /// @notice Extends the lock to `now + duration`, rounded down to whole weeks by veBTC.
    /// @return newEnd The lock's new end.
    function extend(uint256 duration) external onlyLine returns (uint256 newEnd) {
        ve.increaseUnlockTime(tokenId, duration);
        newEnd = ve.locked(tokenId).end;
    }

    /// @notice Adds `amount` BTC, already transferred to this escrow by the line, to the lock.
    /// @dev Approves veBTC for exactly `amount`, which `increaseAmount` consumes in full.
    function increaseAmount(uint256 amount) external onlyLine {
        btc.forceApprove(address(ve), amount);
        ve.increaseAmount(tokenId, amount);
    }
}
