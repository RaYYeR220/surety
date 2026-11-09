// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMusdSavingsRate
/// @notice The part of Mezo's MUSD Savings Rate vault (sMUSD) Surety uses.
/// @dev sMUSD is not ERC-4626. It is an ERC-20 minted and burned 1:1 against MUSD; yield is paid separately in MUSD
/// through a global index (yield per sMUSD, 1e18) and a per-holder index, so a holder's claimable yield is
/// `claimableYield(holder) + balanceOf(holder) * (yieldIndex() - supplyYieldIndex(holder)) / 1e18`.
interface IMusdSavingsRate {
    /// @notice Pulls `amount` MUSD from the caller and mints the same amount of sMUSD to it.
    function deposit(uint256 amount) external;

    /// @notice Burns `amount` sMUSD of the caller and sends it `amount` MUSD plus all of its claimable yield.
    function withdraw(uint256 amount) external;

    /// @notice Sends the caller all of its claimable yield, in MUSD.
    /// @return The yield paid.
    function claimYield() external returns (uint256);

    /// @notice The MUSD token (deposits, withdrawals and yield).
    function yieldToken() external view returns (address);

    function balanceOf(address account) external view returns (uint256);

    function totalSupply() external view returns (uint256);

    /// @notice Accumulated yield per sMUSD, 1e18.
    function yieldIndex() external view returns (uint256);

    /// @notice `yieldIndex` as of `account`'s last yield update.
    function supplyYieldIndex(address account) external view returns (uint256);

    /// @notice Yield credited to `account` at its last yield update and not claimed yet.
    function claimableYield(address account) external view returns (uint256);
}
