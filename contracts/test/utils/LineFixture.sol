// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SuretyFixture} from "./SuretyFixture.sol";

/// @notice Unit fixture: the shared world plus a VeBTCCreditLine registered as a VaultV2 adapter of the real vault,
/// and nothing else from Surety.
/// @dev `admin` keeps the vault allocator role, so tests move capital into the line with `vault.allocate` directly,
/// the same call the VoteAllocator makes in production.
abstract contract LineFixture is SuretyFixture {
    function _deploySurety() internal virtual override {
        _deployLine();
    }

    /* Vault <-> line */

    /// @notice Deposits `assets` from `lender` into the vault and allocates them to the line.
    function _fundLine(uint256 assets) internal {
        _deposit(lender, assets);
        _allocateLine(assets);
    }

    function _allocateLine(uint256 assets) internal {
        vm.prank(admin);
        vault.allocate(address(line), "", assets);
    }

    function _deallocateLine(uint256 assets) internal {
        vm.prank(admin);
        vault.deallocate(address(line), "", assets);
    }
}
