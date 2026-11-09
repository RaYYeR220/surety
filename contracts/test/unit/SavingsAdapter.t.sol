// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {ErrorsLib} from "vault-v2/libraries/ErrorsLib.sol";

import {SavingsAdapter} from "../../src/SavingsAdapter.sol";
import {IMusdSavingsRate} from "../../src/interfaces/IMusdSavingsRate.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockSavingsRate} from "../mocks/MockSavingsRate.sol";
import {SuretyFixture} from "../utils/SuretyFixture.sol";

/// @notice SavingsAdapter against the real VaultV2 and a mock sMUSD that follows Mezo's MUSDSavingsRate. Only the
/// adapter and sMUSD are deployed; `admin` is the vault's allocator and moves capital directly. The live contract is
/// exercised in test/fork/LiveSavings.t.sol.
contract SavingsAdapterTest is SuretyFixture {
    uint256 internal constant DEPOSIT = 100_000e18;

    address internal other = makeAddr("otherHolder");

    function _deploySurety() internal override {
        _deploySavings();
    }

    /* Helpers */

    function _allocate(uint256 assets) internal {
        vm.prank(admin);
        vault.allocate(address(savings), "", assets);
    }

    function _deallocate(uint256 assets) internal {
        vm.prank(admin);
        vault.deallocate(address(savings), "", assets);
    }

    function _park() internal {
        vm.prank(admin);
        vault.setLiquidityAdapterAndData(address(savings), "");
    }

    /// @dev Another sMUSD holder, so yield is shared as on mainnet.
    function _otherHolder(uint256 amount) internal {
        musd.mint(other, amount);
        vm.startPrank(other);
        musd.approve(address(smusd), amount);
        smusd.deposit(amount);
        vm.stopPrank();
    }

    function _allocation() internal view returns (uint256) {
        return vault.allocation(savings.adapterId());
    }

    /* Construction */

    function test_constructor_wiresAndValidates() public {
        assertEq(savings.parentVault(), address(vault));
        assertEq(address(savings.musd()), address(musd));
        assertEq(address(savings.savings()), address(smusd));
        assertEq(savings.adapterId(), LineIds.adapterId(address(savings)));
        bytes32[] memory ids = savings.ids();
        assertEq(ids.length, 1);
        assertEq(ids[0], savings.adapterId());
        assertEq(musd.allowance(address(savings), address(vault)), type(uint256).max);

        vm.expectRevert(SavingsAdapter.ZeroAddress.selector);
        new SavingsAdapter(address(0), smusd);
        vm.expectRevert(SavingsAdapter.ZeroAddress.selector);
        new SavingsAdapter(address(vault), IMusdSavingsRate(address(0)));
        MockSavingsRate foreign = new MockSavingsRate(new MockERC20("Other USD", "oUSD", 18));
        vm.expectRevert(SavingsAdapter.AssetMismatch.selector);
        new SavingsAdapter(address(vault), foreign);
    }

    function test_onlyVault_emptyData() public {
        vm.expectRevert(SavingsAdapter.NotVault.selector);
        savings.allocate("", 1, bytes4(0), address(this));
        vm.expectRevert(SavingsAdapter.NotVault.selector);
        savings.deallocate("", 1, bytes4(0), address(this));

        _deposit(lender, DEPOSIT);
        vm.prank(admin);
        vm.expectRevert(SavingsAdapter.InvalidData.selector);
        vault.allocate(address(savings), hex"01", 1e18);
    }

    /* Allocation */

    function test_allocate_depositsOneToOne_andReportsPosition() public {
        _deposit(lender, DEPOSIT);
        _allocate(60_000e18);

        assertEq(smusd.balanceOf(address(savings)), 60_000e18);
        assertEq(musd.balanceOf(address(savings)), 0);
        assertEq(musd.balanceOf(address(smusd)), 60_000e18);
        assertEq(savings.principal(), 60_000e18);
        assertEq(savings.realAssets(), 60_000e18);
        assertEq(_allocation(), 60_000e18);
        assertEq(musd.allowance(address(savings), address(smusd)), 0, "approval used up");
        assertEq(vault.totalAssets(), DEPOSIT);

        _deallocate(25_000e18);
        assertEq(smusd.balanceOf(address(savings)), 35_000e18);
        assertEq(_allocation(), 35_000e18);
        assertEq(musd.balanceOf(address(vault)), 65_000e18);
        assertEq(musd.balanceOf(address(savings)), 0);
    }

    /// @dev As the vault's liquidity adapter, deposits land in sMUSD and withdrawals pull from it.
    function test_liquidityAdapter_parksDepositsAndServesWithdrawals() public {
        _park();
        _deposit(lender, DEPOSIT);
        assertEq(musd.balanceOf(address(vault)), 0);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT);
        assertEq(_allocation(), DEPOSIT);

        vm.prank(lender);
        vault.withdraw(40_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 40_000e18);
        assertEq(smusd.balanceOf(address(savings)), 60_000e18);
        assertEq(_allocation(), 60_000e18);
        assertEq(vault.totalAssets(), 60_000e18);
    }

    /* Yield */

    /// @dev realAssets includes yield as soon as sMUSD's index moves, matching to the wei what a claim pays.
    function test_realAssets_includesClaimableYield_exactly() public {
        _otherHolder(300_000e18);
        _deposit(lender, DEPOSIT);
        _allocate(DEPOSIT);

        _smusdYield(4_000e18 + 7);
        uint256 claimable = savings.claimableYield();
        assertApproxEqAbs(claimable, 1_000e18, 1, "a quarter of the supply");
        assertEq(savings.realAssets(), DEPOSIT + claimable);
        assertEq(savings.interestEarnedTotal(), claimable);

        assertEq(savings.harvest(), claimable, "claim pays exactly the view");
        assertEq(savings.yieldClaimed(), claimable);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT + claimable, "yield re-deposited");
        assertEq(savings.realAssets(), DEPOSIT + claimable, "harvest moves nothing");
        assertEq(savings.interestEarnedTotal(), claimable);

        // VaultV2 recognises the yield as interest.
        _warp(30 days);
        vault.accrueInterest();
        assertEq(vault.totalAssets(), DEPOSIT + claimable);
    }

    function test_harvest_permissionless_noYieldIsNoop() public {
        _deposit(lender, DEPOSIT);
        _allocate(DEPOSIT);
        vm.prank(keeper);
        assertEq(savings.harvest(), 0);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT);

        // MUSD sent to the adapter is deposited too.
        musd.mint(address(savings), 5e18);
        vm.expectEmit(address(savings));
        emit SavingsAdapter.Harvested(0, 5e18);
        vm.prank(keeper);
        savings.harvest();
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT + 5e18);
        assertEq(savings.yieldClaimed(), 0, "a donation is not yield");
    }

    /* Deallocation */

    /// @dev Yield alone covers a small deallocation: no principal leaves sMUSD.
    function test_deallocate_yieldFirst() public {
        _otherHolder(100_000e18);
        _deposit(lender, DEPOSIT);
        _allocate(DEPOSIT);
        _smusdYield(2_000e18);
        uint256 yield = savings.claimableYield();
        assertEq(yield, 1_000e18);

        _deallocate(600e18);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT, "principal untouched");
        assertEq(musd.balanceOf(address(savings)), yield - 600e18, "the rest of the claim stays held");
        assertEq(savings.yieldClaimed(), yield);
        assertEq(_allocation(), DEPOSIT + yield - 600e18);
        assertEq(savings.realAssets(), DEPOSIT + yield - 600e18);

        // Held MUSD is used before sMUSD is touched again, and the next allocation re-deposits it.
        _deallocate(300e18);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT);
        _allocate(0);
        assertEq(musd.balanceOf(address(savings)), 0);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT + 100e18);
    }

    /// @dev A larger deallocation withdraws only what is missing net of the yield the withdrawal pays.
    function test_deallocate_withdrawsNetOfYield_noIdleLeft() public {
        _otherHolder(100_000e18);
        _deposit(lender, DEPOSIT);
        _allocate(DEPOSIT);
        _smusdYield(2_000e18);
        uint256 yield = savings.claimableYield();

        _deallocate(30_000e18);
        assertEq(musd.balanceOf(address(savings)), 0, "nothing left idle in the adapter");
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT - (30_000e18 - yield));
        assertEq(savings.yieldClaimed(), yield);
        assertEq(savings.interestEarnedTotal(), yield, "moves do not change the yield counter");
        assertEq(_allocation(), DEPOSIT + yield - 30_000e18);
    }

    /// @dev Yield sMUSD's PCV distributes during the withdrawal stays held and counted.
    function test_deallocate_yieldArrivingInTheCall_staysHeldAndCounted() public {
        _otherHolder(100_000e18);
        _deposit(lender, DEPOSIT);
        _allocate(DEPOSIT);
        musd.mint(address(smusd), 400e18);
        smusd.queueProtocolYield(400e18);

        _deallocate(10_000e18);
        assertEq(musd.balanceOf(address(savings)), 200e18, "our half of the PCV push");
        assertEq(savings.yieldClaimed(), 200e18);
        assertEq(_allocation(), DEPOSIT + 200e18 - 10_000e18);
        assertEq(savings.realAssets(), _allocation());
    }

    /// @dev The whole position, yield included, can be deallocated; the allocation then reads zero.
    function test_deallocate_wholePosition() public {
        _otherHolder(100_000e18);
        _deposit(lender, DEPOSIT);
        _allocate(DEPOSIT);
        _smusdYield(1_000e18);
        uint256 all = savings.realAssets();

        _deallocate(all);
        assertEq(smusd.balanceOf(address(savings)), 0);
        assertEq(musd.balanceOf(address(savings)), 0);
        assertEq(_allocation(), 0);
        assertEq(savings.realAssets(), 0);
        assertEq(musd.balanceOf(address(vault)), DEPOSIT + 500e18);
    }

    function test_deallocate_moreThanPosition_reverts() public {
        _deposit(lender, DEPOSIT);
        _allocate(50_000e18);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SavingsAdapter.InsufficientLiquidity.selector, 50_001e18, 50_000e18));
        vault.deallocate(address(savings), "", 50_001e18);
    }

    /// @dev If sMUSD cannot return principal the deallocation reverts and nothing is booked; idle MUSD still serves
    /// withdrawals.
    function test_deallocate_illiquidSavings_failsLoudly() public {
        _deposit(lender, DEPOSIT);
        _allocate(80_000e18);
        _park();
        smusd.freezeWithdrawals(true);

        vm.prank(admin);
        vm.expectRevert(MockSavingsRate.StrategyIlliquid.selector);
        vault.deallocate(address(savings), "", 1e18);
        assertEq(_allocation(), 80_000e18);
        assertEq(savings.realAssets(), 80_000e18);

        // A withdrawal above idle needs sMUSD and reverts; one within idle does not touch it.
        vm.prank(lender);
        vm.expectRevert(MockSavingsRate.StrategyIlliquid.selector);
        vault.withdraw(30_000e18, lender, lender);
        vm.prank(lender);
        vault.withdraw(20_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 20_000e18);
    }

    /// @dev A deposit sMUSD refuses makes a vault deposit through the liquidity adapter revert (the allocator's owner
    /// then stops parking).
    function test_allocate_depositRefused_revertsVaultDeposit() public {
        _park();
        smusd.freezeDeposits(true);
        musd.mint(lender, 1e18);
        vm.startPrank(lender);
        musd.approve(address(vault), 1e18);
        vm.expectRevert(MockSavingsRate.DepositsFrozen.selector);
        vault.deposit(1e18, lender);
        vm.stopPrank();

        vm.prank(admin);
        vault.setLiquidityAdapterAndData(address(0), "");
        _deposit(lender, 1e18);
        assertEq(musd.balanceOf(address(vault)), 1e18);
    }

    /* Liveness and permissionless exits */

    /// @dev realAssets never reverts: with sMUSD's code broken it reports MUSD held plus the last known principal, so
    /// VaultV2 keeps accruing and idle withdrawals keep working.
    function test_realAssets_neverReverts_fallsBackToPrincipal() public {
        _deposit(lender, DEPOSIT);
        _allocate(70_000e18);
        _otherHolder(70_000e18);
        _smusdYield(1_000e18);
        uint256 yield = savings.claimableYield();
        assertApproxEqAbs(yield, 500e18, 1e6);
        assertEq(savings.realAssets(), 70_000e18 + yield);

        // Every call to sMUSD now reverts.
        vm.etch(address(smusd), hex"60006000fd");
        assertEq(savings.realAssets(), 70_000e18, "principal, no yield");
        vm.expectRevert();
        savings.interestEarnedTotal();
        vault.accrueInterest();
        vm.prank(lender);
        vault.withdraw(30_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 30_000e18);
    }

    /// @dev Anyone can force MUSD out of savings into the vault (paying the penalty); the yield counter does not move.
    function test_forceDeallocate_movesCapitalNotYield() public {
        _park();
        _deposit(lender, DEPOSIT);
        _otherHolder(DEPOSIT);
        _smusdYield(2_000e18);
        uint256 earned = savings.interestEarnedTotal();
        assertEq(earned, 1_000e18);

        vm.prank(lender);
        vault.forceDeallocate(address(savings), "", 50_000e18, lender);
        assertEq(savings.interestEarnedTotal(), earned);
        // The penalty is withdrawn to the vault itself: idle keeps it, the forcer's shares pay it.
        assertEq(musd.balanceOf(address(vault)), 50_000e18);
        assertLt(vault.previewRedeem(vault.balanceOf(lender)), DEPOSIT - 500e18 + 1);
        assertEq(_allocation(), DEPOSIT + 1_000e18 - 50_000e18);
    }

    /// @dev Deallocations within the position always succeed and leave exactly the rest, whatever the yield.
    function testFuzz_deallocate_withinPosition(uint256 parked, uint256 yieldSeed, uint256 out) public {
        parked = bound(parked, 1e18, 10_000_000e18);
        _otherHolder(1_000_000e18);
        _deposit(lender, parked);
        _allocate(parked);
        uint256 yield = bound(yieldSeed, 0, 100_000e18);
        if (yield >= 1e18) _smusdYield(yield);
        uint256 before = savings.realAssets();
        out = bound(out, 1, before);

        _deallocate(out);
        assertEq(_allocation(), before - out);
        assertEq(savings.realAssets(), before - out);
        assertEq(musd.balanceOf(address(vault)), out);
        assertEq(savings.interestEarnedTotal(), before - parked, "yield counted once");
    }

    function test_deallocate_zeroAllocation_rejectedByVault() public {
        _deposit(lender, DEPOSIT);
        vm.prank(admin);
        vm.expectRevert(ErrorsLib.ZeroAllocation.selector);
        vault.deallocate(address(savings), "", 0);
        assertEq(IVaultV2(address(vault)).liquidityAdapter(), address(0));
    }
}
