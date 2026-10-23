// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {EpochLib} from "../../src/libraries/EpochLib.sol";

contract EpochLibTest is Test {
    function test_start_weekAlignsToThursday() public pure {
        uint256 start = EpochLib.start(1792771353, 1 weeks);

        // Thu 2026-10-22 00:00 UTC: the epoch Mezo's own voters report as current.
        assertEq(start, 1792627200);
        assertEq(start % 1 days, 0);
        // Day 0 of unix time is a Thursday; with Sunday = 0 a Thursday is weekday 4.
        assertEq((start / 1 days + 4) % 7, 4);
    }

    function test_start_hourlyEpochs() public pure {
        assertEq(EpochLib.start(1792771353, 1 hours), 1792771200);
    }

    function test_start_isIdempotentAtBoundary() public pure {
        assertEq(EpochLib.start(1792627200, 1 weeks), 1792627200);
        assertEq(EpochLib.start(1792627199, 1 weeks), 1792627200 - 1 weeks);
    }

    function testFuzz_start_isFloor(uint256 t, uint256 len) public pure {
        len = bound(len, 1, 365 days);
        uint256 start = EpochLib.start(t, len);
        assertLe(start, t);
        assertLt(t - start, len);
        assertEq(start % len, 0);
    }
}
