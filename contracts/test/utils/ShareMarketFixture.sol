// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Test} from "forge-std/Test.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";

import {DepositGate} from "../../src/DepositGate.sol";
import {ShareMarket} from "../../src/ShareMarket.sol";
import {ISuretyPool} from "../../src/interfaces/ISuretyPool.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockPausablePool} from "../mocks/MockPausablePool.sol";

/// @notice ShareMarket on a real VaultV2 (srMUSD over mock MUSD) behind the real DepositGate, whose pool is a mock
/// that tests pause and unpause directly.
/// @dev The vault has no adapters: deposits stay idle. `_gain` moves the share price up the way VaultV2 recognises
/// interest (MUSD appears, recognised up to `maxRate` over time; the rate is the maximum and a year passes), `_lose`
/// moves it down (MUSD disappears and VaultV2 realises the loss at once). No performance fee, so holders get all of it.
abstract contract ShareMarketFixture is Test {
    /// @dev Fri 2026-10-23 16:02:33 UTC.
    uint256 internal constant START_TIME = 1792771353;
    uint16 internal constant FEE_BPS = 10;
    uint256 internal constant BPS = 10_000;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal carol = makeAddr("carol");

    MockERC20 internal musd;
    VaultV2 internal vault;
    MockPausablePool internal surety;
    DepositGate internal gate;
    ShareMarket internal market;

    function setUp() public virtual {
        vm.warp(START_TIME);
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        vault = new VaultV2(admin, address(musd));
        vm.startPrank(admin);
        vault.setCurator(admin);
        vault.setName("Surety MUSD");
        vault.setSymbol("srMUSD");
        vm.stopPrank();
        _curate(abi.encodeCall(IVaultV2.setIsAllocator, (admin, true)));
        vm.prank(admin);
        vault.setMaxRate(MAX_MAX_RATE);

        surety = new MockPausablePool();
        gate = new DepositGate(ISuretyPool(address(surety)));
        _curate(abi.encodeCall(IVaultV2.setReceiveSharesGate, (address(gate))));

        market = new ShareMarket(IVaultV2(address(vault)), treasury, FEE_BPS);
        vm.label(address(musd), "MUSD");
        vm.label(address(vault), "VaultV2");
        vm.label(address(surety), "SuretyPool");
        vm.label(address(gate), "DepositGate");
        vm.label(address(market), "ShareMarket");
    }

    /// @notice Submits and immediately executes a timelocked VaultV2 curator call (timelocks are 0).
    function _curate(bytes memory data) internal {
        vm.startPrank(admin);
        vault.submit(data);
        (bool ok, bytes memory ret) = address(vault).call(data);
        vm.stopPrank();
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _deposit(address user, uint256 assets) internal returns (uint256 shares) {
        musd.mint(user, assets);
        vm.startPrank(user);
        musd.approve(address(vault), assets);
        shares = vault.deposit(assets, user);
        vm.stopPrank();
    }

    function _list(address user, uint256 shares, uint16 discountBps) internal returns (uint256 id) {
        vm.startPrank(user);
        vault.approve(address(market), shares);
        id = market.list(shares, discountBps);
        vm.stopPrank();
    }

    /// @notice Mints the quoted price to `who` and fills with exactly that as the limit.
    function _fill(address who, uint256 id, uint256 shares) internal returns (uint256 filled, uint256 assets) {
        (, uint256 quoted,) = market.quote(id, shares);
        musd.mint(who, quoted);
        vm.startPrank(who);
        musd.approve(address(market), quoted);
        (filled, assets) = market.fill(id, shares, quoted);
        vm.stopPrank();
    }

    function _gain(uint256 assets) internal {
        musd.mint(address(vault), assets);
        vm.warp(vm.getBlockTimestamp() + 365 days);
        vault.accrueInterest();
    }

    function _lose(uint256 assets) internal {
        musd.burn(address(vault), assets);
        vault.accrueInterest();
    }

    function _pause(bool paused) internal {
        surety.setPaused(paused);
    }

    /// @notice The price the market should charge for `shares` at `discountBps`, from the vault's view.
    function _expectedPrice(uint256 shares, uint16 discountBps) internal view returns (uint256 assets, uint256 fee) {
        assets = Math.mulDiv(vault.convertToAssets(shares), BPS - discountBps, BPS, Math.Rounding.Ceil);
        fee = assets * FEE_BPS / BPS;
    }
}
