// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stand-in for the SuretyPool's `depositsPaused` view, the only thing the DepositGate reads from it.
contract MockPausablePool {
    bool public depositsPaused;

    function setPaused(bool paused) external {
        depositsPaused = paused;
    }
}
