// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LinearKinkIrm} from "../../src/lines/LinearKinkIrm.sol";

contract LinearKinkIrmTest is Test {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant BASE_APR = 0.02e18;
    uint256 internal constant KINK_APR = 0.08e18;
    uint256 internal constant MAX_APR = 0.6e18;
    uint256 internal constant KINK_UTIL = 0.8e18;

    LinearKinkIrm internal irm;

    function setUp() public {
        irm = new LinearKinkIrm(BASE_APR, KINK_APR, MAX_APR, KINK_UTIL);
    }

    function test_rate_atZero_isBase() public view {
        assertApproxEqAbs(irm.ratePerSecond(0), BASE_APR / YEAR, 1);
    }

    function test_rate_atKink_isKinkApr() public view {
        assertApproxEqAbs(irm.ratePerSecond(KINK_UTIL), KINK_APR / YEAR, 1);
    }

    function test_rate_atFull_isMax() public view {
        assertApproxEqAbs(irm.ratePerSecond(1e18), MAX_APR / YEAR, 1);
        // Utilisation above 100% cannot happen on the line; the curve saturates instead of extrapolating.
        assertEq(irm.ratePerSecond(2e18), irm.ratePerSecond(1e18));
    }

    function test_rate_interpolatesLinearlyOnBothSegments() public view {
        // Half-way to the kink: 5% APR. Half-way from the kink to full: 34% APR.
        assertApproxEqAbs(irm.ratePerSecond(0.4e18), 0.05e18 / YEAR, 1);
        assertApproxEqAbs(irm.ratePerSecond(0.9e18), 0.34e18 / YEAR, 1);
    }

    function test_constructor_rejectsBadCurves() public {
        vm.expectRevert(LinearKinkIrm.BadCurve.selector);
        this.deployIrm(KINK_APR, BASE_APR, MAX_APR, KINK_UTIL);
        vm.expectRevert(LinearKinkIrm.BadCurve.selector);
        this.deployIrm(BASE_APR, MAX_APR, KINK_APR, KINK_UTIL);
        vm.expectRevert(LinearKinkIrm.BadCurve.selector);
        this.deployIrm(BASE_APR, KINK_APR, MAX_APR, 0);
        vm.expectRevert(LinearKinkIrm.BadCurve.selector);
        this.deployIrm(BASE_APR, KINK_APR, MAX_APR, 1e18);
        vm.expectRevert(LinearKinkIrm.BadCurve.selector);
        this.deployIrm(BASE_APR, KINK_APR, 10e18 + 1, KINK_UTIL);
        // A flat curve is valid.
        LinearKinkIrm flat = this.deployIrm(0.05e18, 0.05e18, 0.05e18, KINK_UTIL);
        assertEq(flat.ratePerSecond(0), flat.ratePerSecond(1e18));
    }

    /// @dev External so `expectRevert` sees the constructor revert at a lower call depth.
    function deployIrm(uint256 base, uint256 kink, uint256 max, uint256 kinkUtil) external returns (LinearKinkIrm) {
        return new LinearKinkIrm(base, kink, max, kinkUtil);
    }

    function testFuzz_rate_monotonic(uint256 a, uint256 b) public view {
        a = bound(a, 0, 1e18);
        b = bound(b, a, 1e18);
        assertLe(irm.ratePerSecond(a), irm.ratePerSecond(b));
    }
}
