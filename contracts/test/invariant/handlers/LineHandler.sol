// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VaultV2} from "vault-v2/VaultV2.sol";

import {IVeBTC} from "../../../src/interfaces/IVeBTC.sol";
import {VeBTCCreditLine} from "../../../src/lines/VeBTCCreditLine.sol";
import {BtcMusdPriceSource} from "../../../src/oracles/BtcMusdPriceSource.sol";
import {StressedPriceSource} from "../../../src/oracles/StressedPriceSource.sol";
import {MusdPeg} from "../../../src/oracles/peg/MusdPeg.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {MockPegSource} from "../../mocks/MockPegSource.sol";
import {MockPoolsVoter} from "../../mocks/MockPoolsVoter.sol";
import {MockVeBTC} from "../../mocks/MockVeBTC.sol";

/// @notice Drives one VeBTCCreditLine through borrowers, a harvester, keepers, bidders, the vault's allocator, MUSD
/// depegs and BTC shocks, keeping its own books of what the line's cash and every fee recipient must hold.
/// @dev The ghost ledger is computed from the handler's own arithmetic (amounts, prices and debts read before each
/// call), never from the line's events, so the invariants compare two independent accounts.
contract LineHandler is Test {
    struct System {
        VaultV2 vault;
        MockERC20 musd;
        MockERC20 btc;
        MockVeBTC ve;
        MockPoolsVoter poolsVoter;
        VeBTCCreditLine line;
        StressedPriceSource stressed;
        BtcMusdPriceSource lineSource;
        MusdPeg peg;
        MockPegSource pegSource;
        address admin;
        address treasury;
    }

    /// @notice What the line and the fee recipients must hold, by the handler's arithmetic.
    struct Ledger {
        uint256 cash;
        uint256 originationFees;
        uint256 liquidationFeesKept;
        uint256 toLenders;
        uint256 toTreasury;
        uint256 toKeepers;
        uint256 shortfalls;
        uint256 borrowsWhileUnhealthy;
        uint256 harvested;
    }

    uint256 internal constant BPS = 10_000;

    VaultV2 public immutable vault;
    MockERC20 public immutable musd;
    MockERC20 public immutable btc;
    MockVeBTC public immutable ve;
    MockPoolsVoter public immutable poolsVoter;
    VeBTCCreditLine public immutable line;
    StressedPriceSource public immutable stressed;
    BtcMusdPriceSource public immutable lineSource;
    MusdPeg public immutable peg;
    MockPegSource public immutable pegSource;
    address public immutable admin;
    address public immutable treasury;
    MockERC20 public immutable rewardToken;
    address public immutable bribe;

    address[] internal borrowers;
    address[] public keepers;
    address internal lender;
    address internal bidder;
    address internal stranger;

    uint256 public currentTime;
    uint256 public currentBlock;
    Ledger internal ledger;
    mapping(bytes32 action => uint256) public calls;

    constructor(System memory s) {
        vault = s.vault;
        musd = s.musd;
        btc = s.btc;
        ve = s.ve;
        poolsVoter = s.poolsVoter;
        line = s.line;
        stressed = s.stressed;
        lineSource = s.lineSource;
        peg = s.peg;
        pegSource = s.pegSource;
        admin = s.admin;
        treasury = s.treasury;
        rewardToken = new MockERC20("Reward", "RWD", 18);
        bribe = makeAddr("bribeReward");

        for (uint256 i; i < 3; ++i) {
            borrowers.push(makeAddr(string.concat("lineBorrower", vm.toString(i))));
            keepers.push(makeAddr(string.concat("lineKeeper", vm.toString(i))));
        }
        lender = makeAddr("lineLender");
        bidder = makeAddr("lineBidder");
        stranger = makeAddr("harvester");
        currentTime = block.timestamp;
        currentBlock = block.number;
        ledger.cash = s.line.cash();
    }

    modifier step(bytes32 action) {
        vm.warp(currentTime);
        vm.roll(currentBlock);
        _;
        ++calls[action];
    }

    /* Vault */

    function allocate(uint256 assets) external step("allocate") {
        assets = bound(assets, 1e18, 200_000e18);
        musd.mint(lender, assets);
        vm.startPrank(lender);
        musd.approve(address(vault), assets);
        vault.deposit(assets, lender);
        vm.stopPrank();
        vm.prank(admin);
        vault.allocate(address(line), "", assets);
        ledger.cash += assets;
    }

    function deallocate(uint256 assets) external step("deallocate") {
        uint256 cash = line.cash();
        if (cash == 0) return;
        assets = bound(assets, 1, cash);
        vm.prank(admin);
        vault.deallocate(address(line), "", assets);
        ledger.cash -= assets;
    }

    /// @dev MUSD sent to the line by mistake: it must never become cash.
    function donate(uint256 assets) external step("donate") {
        musd.mint(address(line), bound(assets, 1, 1_000e18));
    }

    /* Borrowers */

    function open(uint256 who, uint256 btcAmount, uint256 fraction, bool permanent) external step("open") {
        address user = borrowers[who % borrowers.length];
        btcAmount = bound(btcAmount, 0.01e18, 2e18);
        btc.mint(user, btcAmount);
        vm.startPrank(user);
        btc.approve(address(ve), btcAmount);
        uint256 tokenId = ve.createLock(btcAmount, 28 days, permanent);
        ve.approve(address(line), tokenId);
        vm.stopPrank();

        uint256 amount = line.maxBorrow(tokenId) * bound(fraction, 1, BPS) / BPS;
        if (amount == 0) return;
        if (!peg.pegHealthy()) {
            vm.prank(user);
            try line.open(tokenId, amount) {
                ++ledger.borrowsWhileUnhealthy;
            } catch {}
            return;
        }
        vm.prank(user);
        line.open(tokenId, amount);
        _booksBorrow(amount);
    }

    function borrowMore(uint256 loanSeed, uint256 fraction) external step("borrowMore") {
        uint256 loanId = _findLoan(loanSeed, true, false);
        if (loanId == 0) return;
        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        IVeBTC.LockedBalance memory lock = ve.locked(l.tokenId);
        if (!lock.isPermanent && lock.end < block.timestamp + 3 days) return;
        uint256 value = uint256(int256(lock.amount)) * lineSource.priceWad() / 1e18;
        uint256 limit = value * (lock.isPermanent ? 4000 : 5000) / BPS;
        uint256 debt = line.debtOf(loanId);
        if (limit <= debt + 1) return;
        uint256 room = limit - debt - 1;
        if (room > line.cash()) room = line.cash();
        if (room == 0) return;
        uint256 amount = bound(fraction, 1, room);
        if (!peg.pegHealthy()) {
            vm.prank(l.borrower);
            try line.borrowMore(loanId, amount) {
                ++ledger.borrowsWhileUnhealthy;
            } catch {}
            return;
        }
        vm.prank(l.borrower);
        line.borrowMore(loanId, amount);
        _booksBorrow(amount);
    }

    /// @dev Anyone repays part or all of an Active or auctioned loan; the peg never matters.
    function repay(uint256 loanSeed, uint256 fraction) external step("repay") {
        uint256 loanId = _findLoan(loanSeed, true, true);
        if (loanId == 0) return;
        uint256 debt = line.debtOf(loanId);
        uint256 amount = debt * bound(fraction, 1, BPS + 2000) / BPS;
        if (amount == 0) amount = 1;
        address payer = stranger;
        musd.mint(payer, amount);
        vm.startPrank(payer);
        musd.approve(address(line), amount);
        uint256 repaid = line.repay(loanId, amount);
        vm.stopPrank();
        ledger.cash += repaid;
    }

    function setAutoRepay(uint256 loanSeed, bool enabled) external step("setAutoRepay") {
        uint256 loanId = _findLoan(loanSeed, true, true);
        if (loanId == 0) return;
        vm.prank(line.loan(loanId).borrower);
        line.setAutoRepay(loanId, enabled);
    }

    /// @dev The NFT earned a MUSD bribe and some other reward; the harvester (or, without auto-repay, the borrower)
    /// turns them into repayment.
    function harvest(uint256 loanSeed, uint256 musdReward, uint256 otherReward) external step("harvest") {
        uint256 loanId = _findLoan(loanSeed, true, true);
        if (loanId == 0) return;
        VeBTCCreditLine.Loan memory l = line.loan(loanId);
        // Whole MUSD, so runs reach partial repayments, full ones and excess; wei-level amounts are unit-fuzzed.
        musdReward = bound(musdReward, 0, 50_000) * 1e18;
        otherReward = bound(otherReward, 0, 100e18);
        if (musdReward > 0) {
            musd.mint(address(poolsVoter), musdReward);
            poolsVoter.setReward(bribe, address(musd), musdReward);
        }
        if (otherReward > 0) {
            rewardToken.mint(address(poolsVoter), otherReward);
            poolsVoter.setReward(bribe, address(rewardToken), otherReward);
        }
        address[] memory rewards = new address[](1);
        rewards[0] = bribe;
        address[][] memory tokens = new address[][](1);
        tokens[0] = new address[](3);
        tokens[0][0] = address(musd);
        tokens[0][1] = address(rewardToken);
        tokens[0][2] = address(ve);

        uint256 debt = line.debtOf(loanId);
        uint256 borrowerMusd = musd.balanceOf(l.borrower);
        uint256 borrowerOther = rewardToken.balanceOf(l.borrower);
        vm.prank(l.autoRepay ? stranger : l.borrower);
        uint256 repaid = line.harvest(loanId, rewards, tokens);

        uint256 expected = musdReward < debt ? musdReward : debt;
        assertEq(repaid, expected, "harvest repays min(reward, debt)");
        assertEq(musd.balanceOf(l.borrower) - borrowerMusd, musdReward - repaid, "excess MUSD to the borrower");
        assertEq(rewardToken.balanceOf(l.borrower) - borrowerOther, otherReward, "other rewards to the borrower");
        ledger.cash += repaid;
        ledger.harvested += repaid;
    }

    /* Keepers and bidders */

    function startAuction(uint256 loanSeed, uint256 keeperSeed) external step("startAuction") {
        uint256 loanId = _findLoan(loanSeed, true, false);
        if (loanId == 0) return;
        vm.prank(keepers[keeperSeed % keepers.length]);
        // Healthy loans are refused with NotLiquidatable; that is the keeper's loss of gas, nothing else.
        try line.startAuction(loanId) {} catch {}
    }

    function bid(uint256 loanSeed) external step("bid") {
        uint256 loanId = _findLoan(loanSeed, false, true);
        if (loanId == 0) return;
        _bid(loanId);
    }

    /// @dev A crash: BTC drops, every loan past the trigger is auctioned and bought at the opening price.
    function crash(uint256 bps, uint256 keeperSeed) external step("crash") {
        stressed.shock(uint16(bound(bps, 2500, 9000)), 2 hours);
        uint256 count = line.loanCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (line.loan(id).state != VeBTCCreditLine.LoanState.Active) continue;
            vm.prank(keepers[(keeperSeed % keepers.length + id) % keepers.length]);
            try line.startAuction(id) {} catch {}
            if (line.loan(id).state == VeBTCCreditLine.LoanState.Auction) _bid(id);
        }
    }

    /* Prices */

    function shock(uint256 bps, uint256 duration) external step("shock") {
        stressed.shock(uint16(bound(bps, 0, 9000)), uint32(bound(duration, 10 minutes, 2 hours)));
    }

    /// @dev MUSD moves: on peg, inside the band, a depeg either way, or no reading at all.
    function movePeg(uint256 seed) external step("movePeg") {
        uint256 kind = seed % 5;
        if (kind == 0) pegSource.set(true, 1e18);
        else if (kind == 1) pegSource.set(true, bound(seed >> 8, 0.97e18, 1.03e18));
        else if (kind == 2) pegSource.set(true, bound(seed >> 8, 0.6e18, 0.97e18 - 1));
        else if (kind == 3) pegSource.set(true, bound(seed >> 8, 1.03e18 + 1, 1.2e18));
        else pegSource.set(false, 0);
    }

    function warp(uint256 secs) external step("warp") {
        secs = bound(secs, 1 minutes, 2 days);
        currentTime += secs;
        currentBlock += 1 + secs / 3;
        vm.warp(currentTime);
        vm.roll(currentBlock);
    }

    /* Views */

    function ledgerOf() external view returns (Ledger memory) {
        return ledger;
    }

    function keeperCount() external view returns (uint256) {
        return keepers.length;
    }

    /* Internals */

    function _booksBorrow(uint256 amount) internal {
        ledger.cash -= amount;
        ledger.originationFees += amount * 25 / BPS;
    }

    /// @dev Buys at the current price, booking the split by the line's documented arithmetic.
    function _bid(uint256 loanId) internal {
        uint256 price = line.auctionPrice(loanId);
        uint256 debt = line.debtOf(loanId);
        uint256 owed = debt + debt * 300 / BPS;
        uint256 toLine = price < owed ? price : owed;
        uint256 kept = toLine > debt ? toLine - debt : 0;
        uint256 protocolPart = kept * 2000 / BPS;
        uint256 toKeeper = protocolPart * 5000 / BPS;

        musd.mint(bidder, price);
        vm.startPrank(bidder);
        musd.approve(address(line), price);
        line.bid(loanId, price);
        vm.stopPrank();

        ledger.cash += toLine - protocolPart;
        ledger.liquidationFeesKept += kept;
        ledger.toLenders += kept - protocolPart;
        ledger.toTreasury += protocolPart - toKeeper;
        ledger.toKeepers += toKeeper;
        if (price < debt) ledger.shortfalls += debt - price;
    }

    /// @dev First loan from a seed-chosen start that is Active (if `active`) or in Auction (if `auction`); 0 if none.
    function _findLoan(uint256 seed, bool active, bool auction) internal view returns (uint256) {
        uint256 count = line.loanCount();
        for (uint256 k; k < count; ++k) {
            uint256 id = 1 + (seed % count + k) % count;
            VeBTCCreditLine.LoanState state = line.loan(id).state;
            if (active && state == VeBTCCreditLine.LoanState.Active) return id;
            if (auction && state == VeBTCCreditLine.LoanState.Auction) return id;
        }
        return 0;
    }
}
