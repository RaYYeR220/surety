// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPegSource} from "../../src/interfaces/IPegSource.sol";

/// @notice MUSD/USD source with a settable reading.
contract MockPegSource is IPegSource {
    bool public ok;
    uint256 public price;

    constructor(uint256 price_) {
        set(true, price_);
    }

    function set(bool ok_, uint256 price_) public {
        ok = ok_;
        price = price_;
    }

    function read() external view returns (bool, uint256) {
        return (ok, ok ? price : 0);
    }
}
