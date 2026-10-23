// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {DepositGate} from "../../src/DepositGate.sol";
import {ISuretyPool} from "../../src/interfaces/ISuretyPool.sol";

/// @notice Stand-in for the SuretyPool's `depositsPaused` view.
contract PausablePool {
    bool public depositsPaused;

    function setPaused(bool paused) external {
        depositsPaused = paused;
    }
}

/// @notice DepositGate in isolation: the pool always receives, everyone else follows the pool's pause and waits if
/// the pool's view reverts. The integrated behaviour is in test/audit (M-03).
contract DepositGateTest is Test {
    PausablePool internal pausable;
    DepositGate internal gate;
    address internal user = makeAddr("user");

    function setUp() public {
        pausable = new PausablePool();
        gate = new DepositGate(ISuretyPool(address(pausable)));
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(DepositGate.ZeroAddress.selector);
        new DepositGate(ISuretyPool(address(0)));
        assertEq(address(gate.pool()), address(pausable));
    }

    function test_canReceiveShares_followsThePool() public {
        assertTrue(gate.canReceiveShares(user));
        pausable.setPaused(true);
        assertFalse(gate.canReceiveShares(user));
        assertTrue(gate.canReceiveShares(address(pausable)), "the pool always receives");
        pausable.setPaused(false);
        assertTrue(gate.canReceiveShares(user));

        // A reverting view never makes the gate revert: everyone but the pool waits.
        vm.mockCallRevert(address(pausable), abi.encodeCall(ISuretyPool.depositsPaused, ()), "boom");
        assertFalse(gate.canReceiveShares(user));
        assertTrue(gate.canReceiveShares(address(pausable)));
    }
}
