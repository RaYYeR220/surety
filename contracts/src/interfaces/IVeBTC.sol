// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVeBTC
/// @notice The subset of Mezo's veBTC VotingEscrow (ERC-721) that Surety calls.
interface IVeBTC {
    /// @dev `end` is 0 for permanent locks. `boost` has 1e18 precision; 0 means 1x.
    struct LockedBalance {
        int128 amount;
        uint256 end;
        bool isPermanent;
        uint256 boost;
    }

    /// @dev LOCKED NFTs sit inside a managed NFT and cannot be transferred.
    enum EscrowType {
        NORMAL,
        LOCKED,
        MANAGED
    }

    /// @notice The locked ERC-20 (the BTC precompile on Mezo).
    function token() external view returns (address);

    function ownerOf(uint256 tokenId) external view returns (address);

    function isApprovedOrOwner(address spender, uint256 tokenId) external view returns (bool);

    function transferFrom(address from, address to, uint256 tokenId) external;

    function locked(uint256 tokenId) external view returns (LockedBalance memory);

    function escrowType(uint256 tokenId) external view returns (EscrowType);

    /// @notice Grant manager of a vesting lock, zero for ordinary locks.
    function grantManager(uint256 tokenId) external view returns (address);

    /// @notice Boosted voting power of `tokenId` at `timestamp`, read from the lock's point history.
    function votingPowerOfNFTAt(uint256 tokenId, uint256 timestamp) external view returns (uint256);

    /// @notice Whether the NFT currently has an active vote on a Mezo voter.
    function voted(uint256 tokenId) external view returns (bool);

    /// @notice Sets the unlock time to `now + lockDuration`, rounded down to whole weeks.
    function increaseUnlockTime(uint256 tokenId, uint256 lockDuration) external;

    /// @notice Pulls `value` of `token()` from the caller into the lock.
    function increaseAmount(uint256 tokenId, uint256 value) external;
}
