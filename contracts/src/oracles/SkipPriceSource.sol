// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title SkipPriceSource
/// @notice BTC/USD from Mezo's Skip oracle precompile (Chainlink interface), normalised to 18 decimals.
/// @dev Fails closed: reverts on stale, non-positive or future-dated rounds.
contract SkipPriceSource is IPriceSource {
    IAggregatorV3 public immutable aggregator;
    /// @notice Maximum accepted age of the latest round, in seconds.
    uint256 public immutable maxAge;

    uint256 internal immutable scale;

    error ZeroAddress();
    error ZeroMaxAge();
    error UnsupportedDecimals();

    constructor(IAggregatorV3 aggregator_, uint256 maxAge_) {
        if (address(aggregator_) == address(0)) revert ZeroAddress();
        if (maxAge_ == 0) revert ZeroMaxAge();
        uint8 decimals = aggregator_.decimals();
        if (decimals > 18) revert UnsupportedDecimals();

        aggregator = aggregator_;
        maxAge = maxAge_;
        scale = 10 ** (18 - decimals);
    }

    /// @inheritdoc IPriceSource
    function priceWad() external view returns (uint256) {
        // Round ids and startedAt carry no information on the Skip precompile.
        // forge-lint: disable-next-line(unused-return)
        (, int256 answer,, uint256 updatedAt,) = aggregator.latestRoundData();
        if (answer <= 0 || updatedAt > block.timestamp) revert BadPrice();
        if (block.timestamp - updatedAt > maxAge) revert StalePrice();
        // Safe: answer is strictly positive here.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint256(answer) * scale;
    }
}
