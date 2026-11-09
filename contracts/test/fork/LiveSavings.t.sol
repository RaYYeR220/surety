// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";

import {SavingsAdapter} from "../../src/SavingsAdapter.sol";
import {IMusdSavingsRate} from "../../src/interfaces/IMusdSavingsRate.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";

/// @notice A strategy whose principal cannot come back: what an illiquid strategy (or a broken one) set by sMUSD's
/// owner would look like to sMUSD.
contract FrozenStrategy {
    IERC20 public immutable token;
    address public immutable savingsVault;

    constructor(IERC20 token_, address savingsVault_) {
        token = token_;
        savingsVault = savingsVault_;
    }

    function allocate(uint256 amount) external {
        token.transferFrom(savingsVault, address(this), amount);
    }

    function deallocate(uint256) external pure {
        revert("principal locked");
    }

    function claimYield() external pure returns (uint256) {
        return 0;
    }

    function migrate(address) external pure returns (uint256) {
        revert("principal locked");
    }

    function onMigrated(uint256) external {}
}

/// @notice The SavingsAdapter against Mezo's live MUSD Savings Rate vault (sMUSD, MUSDSavingsRate behind a proxy) and
/// live MUSD, under a fresh VaultV2 whose liquidity adapter it is.
/// @dev Opt-in like LiveMezo.t.sol: runs only with `SURETY_FORK=true` (RPC from `SURETY_FORK_RPC`, else
/// `https://mezo.drpc.org`, else `mezo_mainnet` in foundry.toml); otherwise, or when no RPC answers, every test is
/// skipped. Yield is pushed with sMUSD's permissionless `receiveProtocolYield`, as Mezo's PCV does.
contract LiveSavingsTest is Test {
    address internal constant MUSD = 0xdD468A1DDc392dcdbEf6db6e34E89AA338F9F186;
    address internal constant SMUSD = 0xb4D498029af77680cD1eF828b967f010d06C51CC;
    address internal constant IDLE_STRATEGY = 0x0C0944713c185ea3e64F5609ECee3fB3C054a295;
    string internal constant FALLBACK_RPC = "https://mezo.drpc.org";
    uint256 internal constant DEPOSIT = 100_000e18;

    IERC20 internal musd = IERC20(MUSD);
    IMusdSavingsRate internal smusd = IMusdSavingsRate(SMUSD);

    address internal admin = makeAddr("admin");
    address internal lender = makeAddr("lender");
    address internal payer = makeAddr("yieldPayer");

    VaultV2 internal vault;
    SavingsAdapter internal savings;

    function setUp() public {
        if (!vm.envOr("SURETY_FORK", false) || !_fork()) {
            vm.skip(true);
            return;
        }
        vm.label(MUSD, "MUSD");
        vm.label(SMUSD, "sMUSD");
        vault = new VaultV2(admin, MUSD);
        savings = new SavingsAdapter(address(vault), smusd);
        vm.prank(admin);
        vault.setCurator(admin);
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (admin, true)));
        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(savings))));
        _curate(abi.encodeCall(IVaultV2.increaseAbsoluteCap, (LineIds.adapterIdData(address(savings)), 1e27)));
        _curate(abi.encodeCall(IVaultV2.increaseRelativeCap, (LineIds.adapterIdData(address(savings)), 1e18)));
        vm.startPrank(admin);
        vault.setMaxRate(MAX_MAX_RATE);
        vault.setLiquidityAdapterAndData(address(savings), "");
        vm.stopPrank();
    }

    /* Tests */

    /// @dev The facts the adapter relies on: MUSD is the yield token, it is not ERC-4626, and every sMUSD is backed
    /// 1:1 by MUSD in the idle strategy.
    function test_fork_liveSavingsIsWhatTheAdapterExpects() public view {
        assertEq(smusd.yieldToken(), MUSD);
        (bool ok,) = SMUSD.staticcall(abi.encodeWithSignature("asset()"));
        assertFalse(ok, "not ERC-4626");
        (ok,) = SMUSD.staticcall(abi.encodeWithSignature("convertToAssets(uint256)", 1e18));
        assertFalse(ok, "no share price");
        (bool read, bytes memory ret) = SMUSD.staticcall(abi.encodeWithSignature("strategy()"));
        assertTrue(read);
        address strategy = abi.decode(ret, (address));
        assertEq(strategy, IDLE_STRATEGY, "IdleStrategy holds the principal");
        assertGe(musd.balanceOf(strategy), smusd.totalSupply(), "principal fully held");
    }

    /// @dev Deposits land in sMUSD 1:1; withdrawals come back out of it.
    function test_fork_parkAndWithdraw() public {
        _depositToVault(lender, DEPOSIT);
        assertEq(smusd.balanceOf(address(savings)), DEPOSIT);
        assertEq(musd.balanceOf(address(vault)), 0);
        assertEq(vault.allocation(savings.adapterId()), DEPOSIT);
        assertGe(savings.realAssets(), DEPOSIT);

        vm.prank(lender);
        vault.withdraw(40_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 40_000e18);
        assertApproxEqAbs(savings.realAssets(), 60_000e18, 1e18, "the rest stays parked");

        uint256 shares = vault.balanceOf(lender);
        vm.prank(lender);
        uint256 out = vault.redeem(shares, lender, lender);
        assertGe(out, 60_000e18 - 1);
        // Left over: yield the live PCV distributed during these calls, not recognised yet (no time passed).
        assertLe(savings.realAssets(), DEPOSIT / 1000, "nothing material left");
    }

    /// @dev The adapter's claimable view matches to the wei what live sMUSD pays, the yield reaches the vault's
    /// assets and the adapter's counter, and harvesting re-deposits it.
    function test_fork_yieldIsExactAndCounted() public {
        _depositToVault(lender, DEPOSIT);
        uint256 before = savings.claimableYield();
        _pushYield(5_000e18);
        uint256 claimable = savings.claimableYield();
        uint256 supply = smusd.totalSupply();
        assertApproxEqAbs(claimable - before, 5_000e18 * DEPOSIT / supply, 1e9, "our share of the push");
        assertEq(savings.realAssets(), musd.balanceOf(address(savings)) + DEPOSIT + claimable);
        assertEq(savings.interestEarnedTotal(), claimable);

        vm.prank(payer);
        uint256 harvested = savings.harvest();
        assertEq(harvested, claimable, "the view is exactly what sMUSD pays");
        assertEq(savings.yieldClaimed(), claimable);
        assertGe(smusd.balanceOf(address(savings)), DEPOSIT + claimable, "re-deposited");
        assertGe(savings.interestEarnedTotal(), claimable);

        vm.warp(block.timestamp + 30 days);
        vault.accrueInterest();
        assertGe(vault.totalAssets(), DEPOSIT + claimable, "lenders get it through the share price");
    }

    /// @dev A withdrawal larger than idle takes principal net of the yield sMUSD pays with it, leaving (almost)
    /// nothing idle in the adapter; whatever the live PCV distributes during the call stays held and counted.
    function test_fork_withdrawNetOfYield() public {
        _depositToVault(lender, DEPOSIT);
        _pushYield(5_000e18);
        uint256 position = savings.realAssets();
        uint256 earnedBefore = savings.interestEarnedTotal();

        vm.prank(lender);
        vault.withdraw(50_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 50_000e18);
        uint256 held = musd.balanceOf(address(savings));
        assertEq(held, savings.yieldClaimed() - earnedBefore, "only what arrived during the call is left idle");
        assertGe(savings.realAssets(), position - 50_000e18);
        assertEq(vault.allocation(savings.adapterId()), savings.realAssets() - savings.claimableYield());
        assertGe(savings.interestEarnedTotal(), earnedBefore, "moves never lower the counter");
    }

    /// @dev If sMUSD's owner moves the principal to a strategy that cannot return it, a deallocation reverts with
    /// sMUSD's error instead of booking anything; idle withdrawals and the vault's accrual keep working, and unsetting
    /// the liquidity adapter (VoteAllocator.setParking(false)) keeps deposits working.
    function test_fork_frozenStrategy_failsLoudly() public {
        _depositToVault(lender, DEPOSIT);
        vm.prank(admin);
        vault.deallocate(address(savings), "", 10_000e18);

        address owner = _owner();
        FrozenStrategy frozen = new FrozenStrategy(musd, SMUSD);
        vm.prank(owner);
        (bool ok,) = SMUSD.call(abi.encodeWithSignature("setStrategy(address)", address(frozen)));
        assertTrue(ok, "owner switched the strategy");

        uint256 allocation = vault.allocation(savings.adapterId());
        uint256 held = musd.balanceOf(address(savings));
        vm.prank(admin);
        vm.expectRevert(bytes("principal locked"));
        vault.deallocate(address(savings), "", held + 1e18);
        assertEq(vault.allocation(savings.adapterId()), allocation, "nothing booked");

        vm.prank(lender);
        vm.expectRevert(bytes("principal locked"));
        vault.withdraw(20_000e18, lender, lender);
        vm.prank(lender);
        vault.withdraw(10_000e18, lender, lender);
        assertEq(musd.balanceOf(lender), 10_000e18, "idle MUSD still pays");
        vault.accrueInterest();
        assertGe(savings.realAssets(), 90_000e18, "the position still reads");

        vm.prank(admin);
        vault.setLiquidityAdapterAndData(address(0), "");
        _depositToVault(lender, 1_000e18);
        assertEq(musd.balanceOf(address(vault)), 1_000e18, "deposits stay idle");
    }

    /* Helpers */

    function _depositToVault(address who, uint256 assets) internal {
        deal(MUSD, who, musd.balanceOf(who) + assets);
        vm.startPrank(who);
        musd.approve(address(vault), assets);
        vault.deposit(assets, who);
        vm.stopPrank();
    }

    /// @dev Pays `amount` MUSD of yield to every sMUSD holder, as Mezo's PCV does.
    function _pushYield(uint256 amount) internal {
        deal(MUSD, payer, amount);
        vm.startPrank(payer);
        musd.approve(SMUSD, amount);
        (bool ok,) = SMUSD.call(abi.encodeWithSignature("receiveProtocolYield(uint256)", amount));
        vm.stopPrank();
        assertTrue(ok, "receiveProtocolYield");
    }

    function _owner() internal view returns (address) {
        (bool ok, bytes memory ret) = SMUSD.staticcall(abi.encodeWithSignature("owner()"));
        assertTrue(ok);
        return abi.decode(ret, (address));
    }

    function _curate(bytes memory data) internal {
        vm.startPrank(admin);
        vault.submit(data);
        (bool ok,) = address(vault).call(data);
        vm.stopPrank();
        require(ok, "curator call failed");
    }

    /// @dev Forks `SURETY_FORK_RPC` if set, else the dRPC endpoint, else foundry.toml's `mezo_mainnet`; at
    /// `SURETY_FORK_BLOCK` if set, else the latest block.
    function _fork() internal returns (bool) {
        uint256 blockNumber = vm.envOr("SURETY_FORK_BLOCK", uint256(0));
        string[3] memory urls = [vm.envOr("SURETY_FORK_RPC", string("")), FALLBACK_RPC, vm.rpcUrl("mezo_mainnet")];
        for (uint256 i; i < urls.length; ++i) {
            if (bytes(urls[i]).length == 0) continue;
            if (blockNumber == 0) {
                try vm.createSelectFork(urls[i]) returns (uint256) {
                    return true;
                } catch {}
            } else {
                try vm.createSelectFork(urls[i], blockNumber) returns (uint256) {
                    return true;
                } catch {}
            }
        }
        return false;
    }
}
