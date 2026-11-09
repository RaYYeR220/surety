// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracle} from "morpho-blue/interfaces/IOracle.sol";

import {IPriceSource} from "../interfaces/IPriceSource.sol";

/// @title MorphoPriceOracle
/// @notice Morpho Blue oracle for BTC-collateral / MUSD-loan markets: the source's BTC price in MUSD, rescaled.
/// @dev Production hands it BtcMusdPriceSource (BTC/USD over the MUSD peg); a bare SkipPriceSource values MUSD at
/// exactly $1. Morpho expects the price of one collateral unit in loan units scaled by
/// 1e36 * 10^loanDecimals / 10^collateralDecimals. Both tokens have 18 decimals, so price = priceWad * 1e18.
/// Reverts from the source propagate, which blocks borrows and liquidations while the feed is unusable.
contract MorphoPriceOracle is IOracle {
    uint256 internal constant WAD_TO_ORACLE_SCALE = 1e18;

    IPriceSource public immutable source;

    error ZeroAddress();

    constructor(IPriceSource source_) {
        if (address(source_) == address(0)) revert ZeroAddress();
        source = source_;
    }

    /// @inheritdoc IOracle
    function price() external view returns (uint256) {
        return source.priceWad() * WAD_TO_ORACLE_SCALE;
    }
}
