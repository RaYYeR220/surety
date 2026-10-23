// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title EpochLib
/// @notice Epochs are fixed windows of `len` seconds anchored at unix time 0; an epoch's id is its start timestamp.
/// @dev Unix time 0 is a Thursday 00:00 UTC, so weekly epochs flip on Thursdays like Mezo's.
library EpochLib {
    /// @notice Start of the epoch that contains `t`. `len` must be non-zero.
    function start(uint256 t, uint256 len) internal pure returns (uint256) {
        return t - (t % len);
    }
}
