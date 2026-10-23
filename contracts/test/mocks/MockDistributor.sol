// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IRewardsDistributor} from "../../src/interfaces/IRewardsDistributor.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {MockVeBTC} from "./MockVeBTC.sol";

/// @notice veBTC RewardsDistributor model (BTC chain fees), following Velodrome v2's distributor:
/// `claim` is permissionless; while the lock is live (or permanent) the BTC is compounded into it through
/// `depositFor`, and once a timed lock has expired it is paid to the NFT owner instead.
/// Amounts are set per NFT with `setClaimable`; the distributor must hold the BTC.
contract MockDistributor is IRewardsDistributor {
    using SafeERC20 for IERC20;

    MockVeBTC public immutable ve;
    IERC20 public immutable token;

    mapping(uint256 tokenId => uint256) public claimable;

    event Claimed(uint256 indexed tokenId, uint256 amount, bool compounded);

    error NotManagedOrNormalNFT();

    constructor(MockVeBTC ve_) {
        ve = ve_;
        token = IERC20(ve_.token());
    }

    function claim(uint256 tokenId) external returns (uint256 amount) {
        if (ve.escrowType(tokenId) == IVeBTC.EscrowType.LOCKED) revert NotManagedOrNormalNFT();
        amount = claimable[tokenId];
        if (amount == 0) return 0;
        claimable[tokenId] = 0;

        IVeBTC.LockedBalance memory l = ve.locked(tokenId);
        bool compound = l.isPermanent || l.end > block.timestamp;
        if (compound) {
            token.forceApprove(address(ve), amount);
            ve.depositFor(tokenId, amount);
        } else {
            token.safeTransfer(ve.ownerOf(tokenId), amount);
        }
        emit Claimed(tokenId, amount, compound);
    }

    /* Test helpers */

    function setClaimable(uint256 tokenId, uint256 amount) external {
        claimable[tokenId] = amount;
    }
}
