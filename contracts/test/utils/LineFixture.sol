// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {LineIds} from "../../src/libraries/LineIds.sol";
import {LinearKinkIrm} from "../../src/lines/LinearKinkIrm.sol";
import {LoanEscrow} from "../../src/lines/LoanEscrow.sol";
import {VeBTCCreditLine} from "../../src/lines/VeBTCCreditLine.sol";
import {SuretyFixture} from "./SuretyFixture.sol";

/// @notice SuretyFixture plus a VeBTCCreditLine registered as a VaultV2 adapter of the real vault.
/// @dev The line prices collateral through `stressedSource`, so `_shock` moves loan LTVs. Its two ids (adapter and
/// veBTC collateral) get LINE_CAP absolute caps and 100% relative caps. Capital reaches the line only through
/// `vault.allocate`, like in production.
abstract contract LineFixture is SuretyFixture {
    uint256 internal constant LINE_CAP = 100_000_000e18;
    uint256 internal constant BPS = 10_000;

    uint16 internal constant MAX_LTV_TIMED = 5000;
    uint16 internal constant MAX_LTV_PERMANENT = 4000;
    uint16 internal constant LIQ_LTV = 7000;
    uint16 internal constant LIQ_FEE = 300;
    uint16 internal constant FLOOR = 7000;
    uint32 internal constant AUCTION_DURATION = 6 hours;
    uint32 internal constant MIN_TERM = 3 days;

    LinearKinkIrm internal lineIrm;
    VeBTCCreditLine internal line;

    address internal lender = makeAddr("lender");
    address internal borrower = makeAddr("borrower");
    address internal bidder = makeAddr("bidder");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual override {
        super.setUp();
        _deployLine();
    }

    function _lineParams() internal pure returns (VeBTCCreditLine.Params memory) {
        return VeBTCCreditLine.Params({
            maxLtvTimedBps: MAX_LTV_TIMED,
            maxLtvPermanentBps: MAX_LTV_PERMANENT,
            liqLtvBps: LIQ_LTV,
            liqFeeBps: LIQ_FEE,
            floorBps: FLOOR,
            auctionDuration: AUCTION_DURATION,
            minTerm: MIN_TERM
        });
    }

    function _deployLine() internal {
        lineIrm = new LinearKinkIrm(0.02e18, 0.08e18, 0.6e18, 0.8e18);
        line = new VeBTCCreditLine(
            address(vault), musd, ve, poolsVoter, distributor, stressedSource, lineIrm, _lineParams(), admin
        );
        vm.label(address(line), "VeBTCCreditLine");
        vm.label(address(lineIrm), "LinearKinkIrm");

        _curate(abi.encodeCall(IVaultV2.addAdapter, (address(line))));
        _setCaps(LineIds.adapterIdData(address(line)), LINE_CAP);
        _setCaps(LineIds.collateralIdData(address(ve)), LINE_CAP);
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

    /* Loans */

    /// @notice Approves the line for `tokenId` and opens a loan of `amount` as `user`.
    function _open(address user, uint256 tokenId, uint256 amount) internal returns (uint256 loanId) {
        vm.startPrank(user);
        ve.approve(address(line), tokenId);
        loanId = line.open(tokenId, amount);
        vm.stopPrank();
    }

    /// @notice Locks `btcAmount` for 28 days (end on the 4th Thursday) and borrows `amount` against it.
    function _openTimed(address user, uint256 btcAmount, uint256 amount)
        internal
        returns (uint256 loanId, uint256 tokenId)
    {
        tokenId = _lockVeBTC(user, btcAmount, 28 days);
        loanId = _open(user, tokenId, amount);
    }

    function _openPermanent(address user, uint256 btcAmount, uint256 amount)
        internal
        returns (uint256 loanId, uint256 tokenId)
    {
        tokenId = _lockPermanent(user, btcAmount);
        loanId = _open(user, tokenId, amount);
    }

    /// @notice Mints MUSD to `payer` and repays up to `amount` of `loanId`.
    function _repay(address payer, uint256 loanId, uint256 amount) internal returns (uint256 repaid) {
        uint256 debt = line.debtOf(loanId);
        uint256 budget = amount < debt ? amount : debt;
        musd.mint(payer, budget);
        vm.startPrank(payer);
        musd.approve(address(line), budget);
        repaid = line.repay(loanId, amount);
        vm.stopPrank();
    }

    /// @notice Mints the current auction price to `who` and bids exactly that.
    function _bid(address who, uint256 loanId) internal returns (uint256 price) {
        price = line.auctionPrice(loanId);
        musd.mint(who, price);
        vm.startPrank(who);
        musd.approve(address(line), price);
        line.bid(loanId, price);
        vm.stopPrank();
    }

    function _escrowOf(uint256 loanId) internal view returns (LoanEscrow) {
        return LoanEscrow(line.loan(loanId).escrow);
    }

    /// @notice MUSD value of `btcAmount` at the unshocked feed price.
    function _value(uint256 btcAmount) internal pure returns (uint256) {
        return btcAmount * uint256(BTC_USD) / 1e18;
    }

    function _makeStale() internal {
        aggregator.setUpdatedAt(vm.getBlockTimestamp() - ORACLE_MAX_AGE - 1);
    }
}
