// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ICreditVoter
/// @notice veBTC-weighted gauges that decide how the Surety vault's capital is split across credit lines.
interface ICreditVoter {
    enum LineKind {
        Morpho,
        VeBTC
    }

    /// @param adapter VaultV2 adapter that holds the line's allocation.
    /// @param data Adapter data for VaultV2 allocate/deallocate (abi-encoded MarketParams for Morpho lines).
    struct Line {
        address adapter;
        bytes data;
        LineKind kind;
        bool active;
        string name;
    }

    function EPOCH_LENGTH() external view returns (uint256);

    /// @notice Start timestamp of the current epoch, which is also its id.
    function currentEpoch() external view returns (uint256);

    function lineCount() external view returns (uint256);

    function line(uint256 lineId) external view returns (Line memory);

    /// @notice veBTC power tallied for `lineId` in `epoch`.
    function lineVotes(uint256 epoch, uint256 lineId) external view returns (uint256);

    /// @notice veBTC power tallied across all lines in `epoch`.
    function totalVotes(uint256 epoch) external view returns (uint256);

    /// @notice Power `tokenId` contributed to `lineId` in `epoch`.
    function tokenVotes(uint256 epoch, uint256 tokenId, uint256 lineId) external view returns (uint256);
}
