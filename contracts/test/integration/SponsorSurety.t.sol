// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IVeBTCLocks, Sponsor} from "../../src/testnet/Sponsor.sol";
import {SuretyFixture} from "../utils/SuretyFixture.sol";

/// @notice A brand-new wallet tries Surety with nothing but a starter kit: it borrows against the kit's veBTC lock on
/// the real veBTC credit line and repays with the kit's MUSD.
/// @dev The fixture's BTC is a plain ERC-20 (the BTC precompile model is in the unit test), so the gas money arrives
/// as ERC-20 BTC here. Book: a lender deposits 10,000 MUSD, alice votes the veBTC line with 6 BTC, and the flip moves
/// ~9,000 MUSD to the line.
contract SponsorSuretyTest is SuretyFixture {
    uint256 internal constant LOCK = 0.002e18;
    uint256 internal constant KIT_MUSD = 50e18;

    Sponsor internal kits;
    address internal relayer = makeAddr("relayer");
    address internal newcomer = makeAddr("newcomer");

    function setUp() public override {
        super.setUp();
        kits = new Sponsor(IVeBTCLocks(address(ve)), IERC20(address(musd)), MIN_TERM, admin);
        btc.mint(address(kits), 1e18);
        musd.mint(address(kits), 10_000e18);
        vm.startPrank(admin);
        kits.setKit(0.0001e18, LOCK, KIT_MUSD, 28 days);
        kits.setRelayer(relayer, true);
        vm.stopPrank();

        _deposit(lender, 10_000e18);
        uint256 aliceId = _lockPermanent(alice, 6e18);
        _warpEpochs(1);
        _voteAll(alice, aliceId, VE_LINE);
        _warpEpochs(1);
        _rebalance();
    }

    function test_newWalletBorrowsAndRepaysWithAStarterKit() public {
        vm.prank(relayer);
        uint256 tokenId = kits.starterKit(newcomer);
        assertEq(ve.ownerOf(tokenId), newcomer);

        // The lock is eligible collateral: about $163 of BTC, half of it borrowable on a timed lock.
        uint256 limit = line.maxBorrow(tokenId);
        assertEq(limit, _value(LOCK) * MAX_LTV_TIMED / BPS);
        uint256 loanId = _open(newcomer, tokenId, 40e18);
        // The loan's MUSD, less any origination fee the line takes.
        uint256 received = musd.balanceOf(newcomer) - KIT_MUSD;
        assertLe(received, 40e18);
        assertGe(received, 40e18 * 99 / 100);
        assertEq(ve.ownerOf(tokenId), address(_escrowOf(loanId)));

        // A week later it repays everything, interest included, from what it holds.
        _warp(7 days);
        uint256 debt = line.debtOf(loanId);
        assertGt(debt, 40e18);
        vm.startPrank(newcomer);
        musd.approve(address(line), debt);
        line.repay(loanId, debt);
        vm.stopPrank();
        assertEq(ve.ownerOf(tokenId), newcomer, "the lock is back");
        assertGt(musd.balanceOf(newcomer), 0);
    }
}
