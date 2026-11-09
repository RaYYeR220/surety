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

/// @notice DepositGate in isolation: the pool and the treasury always receive, everyone else follows the pool's pause
/// and waits if the pool's view reverts. The integrated behaviour is in test/audit (M-03 of the first review, M-02 of
/// the v2 review).
contract DepositGateTest is Test {
    PausablePool internal pausable;
    DepositGate internal gate;
    address internal user = makeAddr("user");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        pausable = new PausablePool();
        gate = new DepositGate(ISuretyPool(address(pausable)), treasury);
    }

    function test_constructor_rejectsZero() public {
        vm.expectRevert(DepositGate.ZeroAddress.selector);
        new DepositGate(ISuretyPool(address(0)), treasury);
        assertEq(address(gate.pool()), address(pausable));
        assertEq(gate.treasury(), treasury);
    }

    function test_canReceiveShares_followsThePool() public {
        assertTrue(gate.canReceiveShares(user));
        pausable.setPaused(true);
        assertFalse(gate.canReceiveShares(user));
        assertTrue(gate.canReceiveShares(address(pausable)), "the pool always receives");
        assertTrue(gate.canReceiveShares(treasury), "the treasury always receives");
        pausable.setPaused(false);
        assertTrue(gate.canReceiveShares(user));

        // A reverting view never makes the gate revert: everyone but the pool waits.
        vm.mockCallRevert(address(pausable), abi.encodeCall(ISuretyPool.depositsPaused, ()), "boom");
        assertFalse(gate.canReceiveShares(user));
        assertTrue(gate.canReceiveShares(address(pausable)));
        assertTrue(gate.canReceiveShares(treasury));
    }

    /// @dev The treasury is answered without calling the pool, so a fee accrual never reads the vault through the
    /// gate (M-02 of the v2 review).
    function test_canReceiveShares_answersTheTreasuryWithoutThePool() public {
        pausable.setPaused(true);
        vm.expectCall(address(pausable), abi.encodeCall(ISuretyPool.depositsPaused, ()), 0);
        assertTrue(gate.canReceiveShares(treasury));
        assertTrue(gate.canReceiveShares(address(pausable)));
    }

    /// @dev A zero treasury means none: address(0) follows the pool like everyone else.
    function test_zeroTreasuryMeansNone() public {
        DepositGate noTreasury = new DepositGate(ISuretyPool(address(pausable)), address(0));
        pausable.setPaused(true);
        assertFalse(noTreasury.canReceiveShares(address(0)));
        assertFalse(noTreasury.canReceiveShares(treasury));
        assertTrue(noTreasury.canReceiveShares(address(pausable)));
    }
}
