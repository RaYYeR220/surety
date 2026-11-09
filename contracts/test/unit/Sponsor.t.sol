// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";

import {IVeBTCLocks, Sponsor} from "../../src/testnet/Sponsor.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {MockBtcPrecompile} from "../mocks/MockBtcPrecompile.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVeBTC} from "../mocks/MockVeBTC.sol";

/// @notice Sponsor against veBTC (mock, Velodrome v2 rules as on Mezo) locking the BTC precompile, modelled at its
/// real address as the ERC-20 view of native balances (see MockBtcPrecompile).
/// @dev Funded with 0.1 BTC by a plain native transfer and 1,000 MUSD. Kit: 0.0001 BTC gas, a 0.002 BTC lock for 28
/// days, 50 MUSD. The credit line's minTerm is 3 days (mainnet's value).
contract SponsorTest is Test {
    /// @dev Fri 2026-10-23 16:02:33 UTC.
    uint256 internal constant START_TIME = 1792771353;
    uint256 internal constant MIN_TERM = 3 days;
    uint256 internal constant FUNDING = 0.1e18;
    uint256 internal constant GAS = 0.0001e18;
    uint256 internal constant LOCK = 0.002e18;
    uint256 internal constant KIT_MUSD = 50e18;
    address internal constant BTC_PRECOMPILE = 0x7b7C000000000000000000000000000000000000;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal user = makeAddr("user");
    address internal stranger = makeAddr("stranger");

    IERC20 internal btc;
    MockVeBTC internal ve;
    MockERC20 internal musd;
    Sponsor internal sponsor;

    function setUp() public {
        vm.warp(START_TIME);
        btc = IERC20(new MockBtcPrecompile().etch());
        ve = new MockVeBTC(address(btc));
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        sponsor = _newSponsor(MIN_TERM);
        vm.label(address(btc), "BTC");
        vm.label(address(ve), "veBTC");
        vm.label(address(sponsor), "Sponsor");

        vm.deal(owner, 1e18);
        vm.prank(owner);
        (bool ok,) = address(sponsor).call{value: FUNDING}("");
        assertTrue(ok);
        musd.mint(address(sponsor), 1_000e18);
        vm.startPrank(owner);
        sponsor.setKit(GAS, LOCK, KIT_MUSD, 28 days);
        sponsor.setRelayer(relayer, true);
        vm.stopPrank();
    }

    function _newSponsor(uint256 minTerm) internal returns (Sponsor) {
        return new Sponsor(IVeBTCLocks(address(ve)), IERC20(address(musd)), minTerm, owner);
    }

    function _kit(address who) internal returns (uint256 tokenId) {
        vm.prank(relayer);
        tokenId = sponsor.starterKit(who);
    }

    /* The BTC model */

    /// @dev What the Sponsor relies on: an ERC-20 transfer of BTC is a native transfer and the reverse.
    function test_btc_isOneBalanceSeenTwoWays() public {
        assertEq(address(btc), BTC_PRECOMPILE);
        assertEq(btc.balanceOf(address(sponsor)), FUNDING);
        assertEq(address(sponsor).balance, FUNDING);

        vm.prank(owner);
        btc.transfer(address(sponsor), 0.05e18);
        assertEq(address(sponsor).balance, FUNDING + 0.05e18);
        assertEq(btc.balanceOf(address(sponsor)), FUNDING + 0.05e18);
    }

    /* Constructor */

    function test_constructor_setsTheSponsor() public view {
        assertEq(address(sponsor.veBTC()), address(ve));
        assertEq(address(sponsor.btc()), BTC_PRECOMPILE, "BTC is what veBTC locks");
        assertEq(address(sponsor.musd()), address(musd));
        assertEq(sponsor.minTerm(), MIN_TERM);
        assertEq(sponsor.owner(), owner);
        assertEq(sponsor.dailyLimit(), 100);
    }

    function test_constructor_rejectsBadParams() public {
        vm.expectRevert(Sponsor.ZeroAddress.selector);
        new Sponsor(IVeBTCLocks(address(0)), IERC20(address(musd)), MIN_TERM, owner);
        vm.expectRevert(Sponsor.ZeroAddress.selector);
        new Sponsor(IVeBTCLocks(address(ve)), IERC20(address(0)), MIN_TERM, owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new Sponsor(IVeBTCLocks(address(ve)), IERC20(address(musd)), MIN_TERM, address(0));
        // A lock must be able to outlast minTerm after veBTC's rounding to weeks.
        vm.expectRevert(Sponsor.BadLockDuration.selector);
        _newSponsor(21 days + 1);

        Sponsor fresh = _newSponsor(21 days);
        assertEq(fresh.lockDuration(), 28 days);
        assertEq(fresh.lockAmount(), 0);
        assertEq(fresh.kitsLeft(), 0);
    }

    /* starterKit */

    function test_starterKit_handsOutTheKit() public {
        uint256 end = (vm.getBlockTimestamp() + 28 days) / 1 weeks * 1 weeks;
        vm.expectEmit(address(sponsor));
        emit Sponsor.StarterKit(user, 1, GAS, LOCK, KIT_MUSD);
        uint256 tokenId = _kit(user);

        // A veBTC lock owned by the wallet, long enough to borrow against.
        assertEq(tokenId, 1);
        assertEq(ve.ownerOf(tokenId), user);
        IVeBTC.LockedBalance memory lock = ve.locked(tokenId);
        assertEq(uint256(int256(lock.amount)), LOCK);
        assertEq(lock.end, end);
        assertFalse(lock.isPermanent);
        assertGt(lock.end, vm.getBlockTimestamp() + MIN_TERM);
        // Gas money as native BTC, and MUSD.
        assertEq(user.balance, GAS);
        assertEq(musd.balanceOf(user), KIT_MUSD);

        assertEq(btc.balanceOf(address(sponsor)), FUNDING - GAS - LOCK);
        assertEq(btc.balanceOf(address(ve)), LOCK);
        assertEq(musd.balanceOf(address(sponsor)), 1_000e18 - KIT_MUSD);
        assertEq(btc.allowance(address(sponsor), address(ve)), 0, "approval used up");
        assertTrue(sponsor.claimed(user));
        assertEq(sponsor.kitsIssued(), 1);
        assertEq(sponsor.kitsOnDay(vm.getBlockTimestamp() / 1 days), 1);
    }

    function test_starterKit_relayersOnly() public {
        vm.prank(stranger);
        vm.expectRevert(Sponsor.NotRelayer.selector);
        sponsor.starterKit(user);
        vm.prank(owner);
        vm.expectRevert(Sponsor.NotRelayer.selector);
        sponsor.starterKit(user);

        vm.prank(owner);
        sponsor.setRelayer(relayer, false);
        vm.prank(relayer);
        vm.expectRevert(Sponsor.NotRelayer.selector);
        sponsor.starterKit(user);
    }

    function test_starterKit_oncePerWallet() public {
        _kit(user);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Sponsor.AlreadyClaimed.selector, user));
        sponsor.starterKit(user);

        // Even after the wallet has spent or moved everything.
        vm.prank(user);
        ve.transferFrom(user, stranger, 1);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Sponsor.AlreadyClaimed.selector, user));
        sponsor.starterKit(user);

        assertEq(_kit(stranger), 2);
        assertEq(sponsor.kitsIssued(), 2);
    }

    function test_starterKit_rejectsTheZeroAddress() public {
        vm.prank(relayer);
        vm.expectRevert(Sponsor.ZeroAddress.selector);
        sponsor.starterKit(address(0));
    }

    function test_starterKit_needsAKit() public {
        Sponsor fresh = _newSponsor(MIN_TERM);
        vm.deal(address(fresh), FUNDING);
        vm.prank(owner);
        fresh.setRelayer(relayer, true);
        vm.prank(relayer);
        vm.expectRevert(Sponsor.KitNotSet.selector);
        fresh.starterKit(user);
    }

    function test_starterKit_dailyLimit() public {
        vm.prank(owner);
        sponsor.setDailyLimit(2);
        _kit(makeAddr("w1"));
        _kit(makeAddr("w2"));
        vm.prank(relayer);
        vm.expectRevert(Sponsor.DailyLimitReached.selector);
        sponsor.starterKit(user);

        // A new UTC day.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _kit(user);
        assertEq(sponsor.kitsIssued(), 3);

        // Zero stops kits.
        vm.prank(owner);
        sponsor.setDailyLimit(0);
        vm.prank(relayer);
        vm.expectRevert(Sponsor.DailyLimitReached.selector);
        sponsor.starterKit(stranger);
    }

    function test_starterKit_outOfFunds() public {
        // 0.1 BTC pays for 47 kits of 0.0021 BTC; 1,000 MUSD for 20 kits of 50.
        assertEq(sponsor.kitsLeft(), 20);

        vm.prank(owner);
        sponsor.withdraw(btc, owner, FUNDING - GAS - LOCK + 1);
        assertEq(sponsor.kitsLeft(), 0);
        vm.prank(relayer);
        vm.expectRevert(Sponsor.OutOfFunds.selector);
        sponsor.starterKit(user);

        vm.deal(address(sponsor), GAS + LOCK);
        assertEq(sponsor.kitsLeft(), 1);
        vm.prank(owner);
        sponsor.withdraw(musd, owner, 1_000e18 - KIT_MUSD + 1);
        vm.prank(relayer);
        vm.expectRevert(Sponsor.OutOfFunds.selector);
        sponsor.starterKit(user);

        musd.mint(address(sponsor), 1);
        _kit(user);
        assertEq(sponsor.kitsLeft(), 0);
        assertFalse(sponsor.claimed(stranger));
    }

    /// @dev A kit can leave out the gas and the MUSD; the lock is the point.
    function test_starterKit_lockOnly() public {
        vm.prank(owner);
        sponsor.setKit(0, LOCK, 0, 28 days);
        _kit(user);
        assertEq(ve.ownerOf(1), user);
        assertEq(user.balance, 0);
        assertEq(musd.balanceOf(user), 0);
        assertEq(sponsor.kitsLeft(), (FUNDING - LOCK) / LOCK);
    }

    /// @dev For any allowed duration and any moment, veBTC's rounding to weeks still leaves the lock ending after
    /// `minTerm` and no more than 28 days out.
    function testFuzz_starterKit_lockOutlastsMinTerm(uint256 elapsed, uint256 minTerm, uint256 duration) public {
        minTerm = bound(minTerm, 0, 21 days);
        duration = bound(duration, minTerm + 1 weeks, 28 days);
        vm.warp(vm.getBlockTimestamp() + bound(elapsed, 0, 104 weeks));

        Sponsor s = _newSponsor(minTerm);
        vm.deal(address(s), GAS + LOCK);
        musd.mint(address(s), KIT_MUSD);
        vm.startPrank(owner);
        s.setKit(GAS, LOCK, KIT_MUSD, duration);
        s.setRelayer(relayer, true);
        vm.stopPrank();

        vm.prank(relayer);
        uint256 tokenId = s.starterKit(user);
        uint256 end = ve.locked(tokenId).end;
        assertGt(end, vm.getBlockTimestamp() + minTerm);
        assertLe(end, vm.getBlockTimestamp() + 28 days);
        assertEq(end % 1 weeks, 0);
    }

    /* Owner */

    function test_setKit_bounds() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        sponsor.setKit(GAS, LOCK, KIT_MUSD, 28 days);

        vm.startPrank(owner);
        uint256 maxGas = sponsor.MAX_BTC_GAS();
        uint256 maxLock = sponsor.MAX_LOCK_AMOUNT();
        uint256 maxMusd = sponsor.MAX_MUSD();
        vm.expectRevert(Sponsor.ZeroLock.selector);
        sponsor.setKit(GAS, 0, KIT_MUSD, 28 days);
        vm.expectRevert(Sponsor.AmountTooHigh.selector);
        sponsor.setKit(maxGas + 1, LOCK, KIT_MUSD, 28 days);
        vm.expectRevert(Sponsor.AmountTooHigh.selector);
        sponsor.setKit(GAS, maxLock + 1, KIT_MUSD, 28 days);
        vm.expectRevert(Sponsor.AmountTooHigh.selector);
        sponsor.setKit(GAS, LOCK, maxMusd + 1, 28 days);
        vm.expectRevert(Sponsor.BadLockDuration.selector);
        sponsor.setKit(GAS, LOCK, KIT_MUSD, MIN_TERM + 1 weeks - 1);
        vm.expectRevert(Sponsor.BadLockDuration.selector);
        sponsor.setKit(GAS, LOCK, KIT_MUSD, 28 days + 1);

        vm.expectEmit(address(sponsor));
        emit Sponsor.KitSet(maxGas, maxLock, maxMusd, MIN_TERM + 1 weeks);
        sponsor.setKit(maxGas, maxLock, maxMusd, MIN_TERM + 1 weeks);
        vm.stopPrank();
        assertEq(sponsor.btcGas(), maxGas);
        assertEq(sponsor.lockAmount(), maxLock);
        assertEq(sponsor.musdAmount(), maxMusd);
        assertEq(sponsor.lockDuration(), MIN_TERM + 1 weeks);
    }

    function test_setRelayerAndDailyLimit_ownerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        sponsor.setRelayer(stranger, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        sponsor.setDailyLimit(1);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(Sponsor.ZeroAddress.selector);
        sponsor.setRelayer(address(0), true);
        vm.expectEmit(address(sponsor));
        emit Sponsor.RelayerSet(stranger, true);
        sponsor.setRelayer(stranger, true);
        uint256 maxLimit = sponsor.MAX_DAILY_LIMIT();
        vm.expectRevert(Sponsor.BadDailyLimit.selector);
        sponsor.setDailyLimit(maxLimit + 1);
        vm.expectEmit(address(sponsor));
        emit Sponsor.DailyLimitSet(maxLimit);
        sponsor.setDailyLimit(maxLimit);
        vm.stopPrank();
        assertTrue(sponsor.isRelayer(stranger));
        assertEq(sponsor.dailyLimit(), maxLimit);
    }

    function test_withdraw_returnsLeftovers() public {
        address to = makeAddr("to");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        sponsor.withdraw(btc, stranger, 1);
        vm.prank(owner);
        vm.expectRevert(Sponsor.ZeroAddress.selector);
        sponsor.withdraw(btc, address(0), 1);

        // BTC through the precompile arrives as native BTC.
        vm.expectEmit(address(sponsor));
        emit Sponsor.Withdrawn(address(btc), to, FUNDING);
        vm.prank(owner);
        sponsor.withdraw(btc, to, FUNDING);
        assertEq(to.balance, FUNDING);
        assertEq(address(sponsor).balance, 0);

        vm.prank(owner);
        sponsor.withdraw(musd, to, 1_000e18);
        assertEq(musd.balanceOf(to), 1_000e18);
        assertEq(sponsor.kitsLeft(), 0);
    }
}
