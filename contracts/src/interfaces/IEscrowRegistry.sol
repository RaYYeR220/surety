// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IEscrowRegistry
/// @notice Lookup of loan escrows that custody veBTC NFTs on behalf of borrowers.
interface IEscrowRegistry {
    function isEscrow(address account) external view returns (bool);

    /// @notice Borrower behind `escrow`, zero if it is not an escrow.
    function borrowerOfEscrow(address escrow) external view returns (address);
}
