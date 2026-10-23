// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Chainlink-style feed with 18 decimals. Like the Skip precompile, which is refreshed every block, it
/// reports `updatedAt = block.timestamp` unless a test pins the timestamp with `setUpdatedAt`.
/// @dev Storage starts zeroed, so the code can be etched over the Skip precompile address in fork tests.
contract MockAggregator is IAggregatorV3 {
    int256 public answer;
    uint80 public roundId;
    bool public pinned;
    uint256 internal pinnedUpdatedAt;

    constructor(int256 initialAnswer) {
        setAnswer(initialAnswer);
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 t = updatedAt();
        return (roundId, answer, t, t, roundId);
    }

    function updatedAt() public view returns (uint256) {
        return pinned ? pinnedUpdatedAt : block.timestamp;
    }

    function setAnswer(int256 newAnswer) public {
        answer = newAnswer;
        roundId++;
    }

    /// @notice Freezes the reported update time, e.g. to make the feed stale.
    function setUpdatedAt(uint256 timestamp) external {
        pinned = true;
        pinnedUpdatedAt = timestamp;
    }

    /// @notice Goes back to reporting the current block timestamp.
    function setLive() external {
        pinned = false;
    }
}
