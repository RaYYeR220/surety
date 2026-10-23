// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {Id, Market} from "morpho-blue/interfaces/IMorpho.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../../src/interfaces/IEscrowRegistry.sol";
import {SuretyPool} from "../../src/SuretyPool.sol";
import {PoolFixture} from "../utils/PoolFixture.sol";

/// @notice SuretyPool against the real VaultV2, Morpho Blue, VeBTCCreditLine and CreditVoter; only the allocator is
/// mocked. Epochs are one week and SEASON is 4, so a cohort of tally epoch `t` matures at `t + 6 weeks`.
contract SuretyPoolTest is PoolFixture {
    address internal sponsor2 = makeAddr("sponsor2");

    /* Setup and admin */

    function test_constructor_wiresAndValidates() public {
        assertEq(address(pool.vault()), address(vault));
        assertEq(address(pool.voter()), address(voter));
        assertEq(address(pool.veBTC()), address(ve));
        assertEq(address(pool.musd()), address(musd));
        assertEq(address(pool.morpho()), address(morpho));
        assertEq(pool.morphoAdapter(), address(morphoAdapter));
        assertEq(address(pool.escrows()), address(line));
        assertEq(pool.SEASON(), SEASON);
        assertEq(pool.EPOCH_LENGTH(), EPOCH_LENGTH);
        assertEq(pool.owner(), admin);
        assertEq(pool.maturityOf(1000 weeks), 1006 weeks);
        assertEq(vault.performanceFeeRecipient(), address(pool));
        assertEq(vault.performanceFee(), VOTER_FEE);

        IEscrowRegistry escrows = IEscrowRegistry(address(line));
        IERC20 token = IERC20(address(musd));
        vm.expectRevert(SuretyPool.ZeroAddress.selector);
        new SuretyPool(address(0), voter, token, morpho, address(morphoAdapter), escrows, admin, SEASON);
        vm.expectRevert(SuretyPool.AssetMismatch.selector);
        new SuretyPool(address(vault), voter, IERC20(address(btc)), morpho, address(morphoAdapter), escrows, admin, 4);
        vm.expectRevert(SuretyPool.BadSeason.selector);
        new SuretyPool(address(vault), voter, token, morpho, address(morphoAdapter), escrows, admin, 0);
        vm.expectRevert(SuretyPool.BadSeason.selector);
        new SuretyPool(address(vault), voter, token, morpho, address(morphoAdapter), escrows, admin, 53);
    }

    function test_setAllocator_onlyOwner_oneShot() public {
        SuretyPool fresh = new SuretyPool(
            address(vault),
            voter,
            IERC20(address(musd)),
            morpho,
            address(morphoAdapter),
            IEscrowRegistry(address(line)),
            admin,
            SEASON
        );
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vm.prank(keeper);
        fresh.setAllocator(keeper);
        vm.expectRevert(SuretyPool.ZeroAddress.selector);
        vm.prank(admin);
        fresh.setAllocator(address(0));

        vm.expectEmit(address(fresh));
        emit SuretyPool.AllocatorSet(keeper);
        vm.prank(admin);
        fresh.setAllocator(keeper);
        assertEq(fresh.allocator(), keeper);

        vm.expectRevert(SuretyPool.AllocatorAlreadySet.selector);
        vm.prank(admin);
        fresh.setAllocator(admin);
    }

    /* Incentives */

    function test_postIncentive_entersCurrentCohort() public {
        uint256 e0 = _currentEpoch();
        uint256 expected = vault.previewDeposit(1_000e18);
        musd.mint(sponsor, 1_000e18);
        vm.startPrank(sponsor);
        musd.approve(address(pool), 1_000e18);
        vm.expectEmit(address(pool));
        emit SuretyPool.IncentivePosted(MORPHO_LINE, e0, sponsor, 1_000e18, expected);
        uint256 shares = pool.postIncentive(MORPHO_LINE, 1_000e18);
        vm.stopPrank();

        assertEq(shares, expected);
        (uint256 held, uint256 finalShares, bool frozen) = pool.cohort(MORPHO_LINE, e0);
        assertEq(held, shares);
        assertEq(finalShares, 0);
        assertFalse(frozen);
        assertEq(pool.incentiveShares(MORPHO_LINE, e0), shares);
        assertEq(pool.sponsorShares(MORPHO_LINE, e0, sponsor), shares);
        assertEq(pool.accountedShares(), shares);
        assertEq(vault.balanceOf(address(pool)), shares);
        assertEq(musd.balanceOf(address(vault)), 1_000e18);
        assertEq(musd.balanceOf(address(pool)), 0);

        // A second sponsor in the same epoch adds to the same cohort; the next epoch starts a new one.
        uint256 more = _post(sponsor2, MORPHO_LINE, 500e18);
        assertEq(_cohortShares(MORPHO_LINE, e0), shares + more);
        _warpEpochs(1);
        uint256 next = _post(sponsor, MORPHO_LINE, 200e18);
        assertEq(_cohortShares(MORPHO_LINE, e0 + EPOCH_LENGTH), next);
        assertEq(_cohortShares(MORPHO_LINE, e0), shares + more);
        assertEq(pool.accountedShares(), shares + more + next);

        vm.expectRevert(SuretyPool.ZeroAmount.selector);
        pool.postIncentive(MORPHO_LINE, 0);
        vm.expectRevert(CreditVoter.UnknownLine.selector);
        pool.postIncentive(7, 1e18);
        vm.prank(admin);
        voter.setLineActive(VE_LINE, false);
        vm.expectRevert(SuretyPool.InactiveLine.selector);
        pool.postIncentive(VE_LINE, 1e18);
    }

    function test_refundIncentive_onlyWhenNoVotes() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        _post(sponsor, MORPHO_LINE, 500e18);
        uint256 s1 = _post(sponsor, VE_LINE, 300e18);
        uint256 s2 = _post(sponsor2, VE_LINE, 200e18);

        vm.expectRevert(SuretyPool.EpochNotEnded.selector);
        vm.prank(sponsor);
        pool.refundIncentive(VE_LINE, e1);

        _warpEpochs(1);
        vm.expectRevert(SuretyPool.LineHasVotes.selector);
        vm.prank(sponsor);
        pool.refundIncentive(MORPHO_LINE, e1);
        vm.expectRevert(SuretyPool.NothingToRefund.selector);
        vm.prank(alice);
        pool.refundIncentive(VE_LINE, e1);

        uint256 accounted = pool.accountedShares();
        vm.expectEmit(address(pool));
        emit SuretyPool.IncentiveRefunded(VE_LINE, e1, sponsor, s1);
        vm.prank(sponsor);
        assertEq(pool.refundIncentive(VE_LINE, e1), s1);
        assertEq(vault.balanceOf(sponsor), s1);
        assertEq(_cohortShares(VE_LINE, e1), s2);
        assertEq(pool.accountedShares(), accounted - s1);
        vm.expectRevert(SuretyPool.NothingToRefund.selector);
        vm.prank(sponsor);
        pool.refundIncentive(VE_LINE, e1);

        vm.prank(sponsor2);
        assertEq(pool.refundIncentive(VE_LINE, e1), s2);
        assertEq(_cohortShares(VE_LINE, e1), 0);
        assertEq(pool.incentiveShares(VE_LINE, e1), 0);

        // The voted line's incentive stays first loss until maturity and is claimed by its voters.
        vm.warp(pool.maturityOf(e1));
        vm.expectRevert(SuretyPool.LineHasVotes.selector);
        vm.prank(sponsor);
        pool.refundIncentive(MORPHO_LINE, e1);
    }

    /* Fees */

    function test_distributeFees_splitsByInterest_restToReserve() public {
        uint256 a = _lockPermanent(alice, 3e18);
        uint256 b = _lockPermanent(bob, 1e18);
        // A line id nobody voted for (attributions name line ids; the voter's tallies decide who gets them).
        uint256 thirdLine = 2;
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        _voteAll(bob, b, VE_LINE);
        _earnMorphoInterest(3 days);
        _warpEpochs(1);
        vault.accrueInterest();

        uint256 fees = _pendingFeeShares();
        assertGt(fees, 0, "real performance-fee shares arrived");
        uint256 toMorpho = fees * 600 / 1000;
        uint256 toVe = fees * 300 / 1000;
        uint256 toReserve = fees - toMorpho - toVe;

        vm.expectEmit(address(pool));
        emit SuretyPool.FeesDistributed(e1, fees, toReserve);
        _distribute(e1, _arr(MORPHO_LINE, VE_LINE, thirdLine), _arr(600, 300, 100));

        assertEq(_cohortShares(MORPHO_LINE, e1), toMorpho);
        assertEq(_cohortShares(VE_LINE, e1), toVe);
        assertEq(_cohortShares(thirdLine, e1), 0, "unvoted line's part goes to the reserve");
        assertEq(pool.reserveShares(), toReserve);
        assertGe(toReserve, fees / 10);
        assertEq(pool.accountedShares(), vault.balanceOf(address(pool)));

        // Nothing new arrived: a repeat call moves nothing.
        _distribute(e1, _arr(MORPHO_LINE), _arr(1));
        assertEq(_cohortShares(MORPHO_LINE, e1), toMorpho);
        assertEq(pool.reserveShares(), toReserve);

        // Zero total interest: everything to the reserve.
        _warp(1 days);
        vault.accrueInterest();
        uint256 more = _pendingFeeShares();
        assertGt(more, 0);
        _distribute(e1, _arr(MORPHO_LINE, VE_LINE), _arr(0, 0));
        assertEq(_cohortShares(MORPHO_LINE, e1), toMorpho);
        assertEq(pool.reserveShares(), toReserve + more);
    }

    function test_distributeFees_openOrMaturedEpoch_toReserve() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        _earnMorphoInterest(1 days);

        // The tally of the current epoch is not final yet.
        uint256 fees = _pendingFeeShares();
        _distribute(e1, _arr(MORPHO_LINE), _arr(1));
        assertEq(_cohortShares(MORPHO_LINE, e1), 0);
        assertEq(pool.reserveShares(), fees);

        // At maturity the cohort is closed to inflows.
        vm.warp(pool.maturityOf(e1));
        vault.accrueInterest();
        uint256 late = _pendingFeeShares();
        assertGt(late, 0);
        _distribute(e1, _arr(MORPHO_LINE), _arr(1));
        assertEq(_cohortShares(MORPHO_LINE, e1), 0);
        assertEq(pool.reserveShares(), fees + late);

        // Misaligned epochs are rejected the same way.
        _warp(1 days);
        vault.accrueInterest();
        _distribute(e1 + 1, _arr(MORPHO_LINE), _arr(1));
        assertEq(pool.reserveShares(), vault.balanceOf(address(pool)));
    }

    function test_distributeFees_onlyAllocator() public {
        vm.expectRevert(SuretyPool.NotAllocator.selector);
        vm.prank(keeper);
        pool.distributeFees(0, new uint256[](0), new uint256[](0));
        vm.expectRevert(SuretyPool.LengthMismatch.selector);
        _distribute(0, _arr(MORPHO_LINE), new uint256[](0));
    }

    /* Claims */

    function test_claim_beforeMaturity_reverts() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        uint256 shares = _post(sponsor, MORPHO_LINE, 1_000e18);

        uint256 maturity = pool.maturityOf(e1);
        assertEq(maturity, e1 + (2 + SEASON) * EPOCH_LENGTH);
        vm.warp(maturity - 1);
        assertEq(pool.claimable(a, MORPHO_LINE, e1), 0);
        vm.expectRevert(SuretyPool.NotMatured.selector);
        pool.claim(a, MORPHO_LINE, e1);

        vm.warp(maturity);
        assertEq(pool.claimable(a, MORPHO_LINE, e1), shares);
        assertEq(pool.claim(a, MORPHO_LINE, e1), shares);
        assertEq(vault.balanceOf(alice), shares);
    }

    function test_claim_paysProRataToOwner() public {
        uint256 a = _lockPermanent(alice, 3e18);
        uint256 b = _lockPermanent(bob, 1e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        _vote(bob, b, _arr(MORPHO_LINE, VE_LINE), _arr(5000, 5000));
        uint256 shares = _post(sponsor, MORPHO_LINE, 7_000e18);
        assertEq(voter.lineVotes(e1, MORPHO_LINE), 3.5e18);

        vm.warp(pool.maturityOf(e1));
        uint256 toAlice = shares * 3e18 / 3.5e18;
        uint256 toBob = shares * 0.5e18 / 3.5e18;
        assertEq(pool.claimable(a, MORPHO_LINE, e1), toAlice);

        // Permissionless: a keeper triggers it, the owner is paid.
        vm.expectEmit(address(pool));
        emit SuretyPool.Claimed(a, MORPHO_LINE, e1, alice, toAlice);
        vm.prank(keeper);
        assertEq(pool.claim(a, MORPHO_LINE, e1), toAlice);
        assertEq(vault.balanceOf(alice), toAlice);
        assertEq(vault.balanceOf(keeper), 0);
        (uint256 held, uint256 finalShares, bool frozen) = pool.cohort(MORPHO_LINE, e1);
        assertTrue(frozen);
        assertEq(finalShares, shares);
        assertEq(held, shares - toAlice);
        assertTrue(pool.isClaimed(a, MORPHO_LINE, e1));
        assertEq(pool.claimable(a, MORPHO_LINE, e1), 0);
        vm.expectRevert(SuretyPool.AlreadyClaimed.selector);
        pool.claim(a, MORPHO_LINE, e1);

        // Shares follow the NFT: bob sold it before claiming, so carol is paid.
        vm.prank(bob);
        ve.transferFrom(bob, carol, b);
        assertEq(pool.claim(b, MORPHO_LINE, e1), toBob);
        assertEq(vault.balanceOf(carol), toBob);
        assertEq(vault.balanceOf(bob), 0);
        assertEq(_cohortShares(MORPHO_LINE, e1), shares - toAlice - toBob);
        assertLe(_cohortShares(MORPHO_LINE, e1), 1);

        // Bob voted for the veBTC line too, whose cohort is empty; alice never voted for it.
        assertEq(pool.claim(b, VE_LINE, e1), 0);
        vm.expectRevert(SuretyPool.NothingToClaim.selector);
        pool.claim(a, VE_LINE, e1);
    }

    function test_claim_escrowedNFT_paysBorrower() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        uint256 shares = _post(sponsor, MORPHO_LINE, 1_000e18);

        // After voting, alice borrows against the NFT; its votes stay with it inside the escrow.
        _fundLine(100_000e18);
        uint256 loanId = _open(alice, a, 10_000e18);
        address escrow = line.loan(loanId).escrow;
        assertEq(ve.ownerOf(a), escrow);

        vm.warp(pool.maturityOf(e1));
        vm.expectEmit(address(pool));
        emit SuretyPool.Claimed(a, MORPHO_LINE, e1, alice, shares);
        pool.claim(a, MORPHO_LINE, e1);
        assertEq(vault.balanceOf(alice), shares);
        assertEq(vault.balanceOf(escrow), 0);
    }

    function test_claim_mergedNFT_creditsReserve() public {
        uint256 a = _lockVeBTC(alice, 1e18, 28 days);
        uint256 b = _lockPermanent(alice, 2e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        _voteAll(alice, b, MORPHO_LINE);
        uint256 shares = _post(sponsor, MORPHO_LINE, 1_100e18);

        // Merging burns `a`; its ballot still counts for e1 (power 0.75 of 2.75).
        vm.prank(alice);
        ve.merge(a, b);
        assertEq(ve.ownerOf(a), address(0));
        assertEq(voter.lineVotes(e1, MORPHO_LINE), 2.75e18);

        vm.warp(pool.maturityOf(e1));
        uint256 toReserve = shares * 0.75e18 / 2.75e18;
        uint256 accounted = pool.accountedShares();
        vm.expectEmit(address(pool));
        emit SuretyPool.Claimed(a, MORPHO_LINE, e1, address(pool), toReserve);
        assertEq(pool.claim(a, MORPHO_LINE, e1), toReserve);
        assertEq(pool.reserveShares(), toReserve);
        assertEq(pool.accountedShares(), accounted, "moved from the cohort to the reserve");
        assertEq(vault.balanceOf(alice), 0);
        vm.expectRevert(SuretyPool.AlreadyClaimed.selector);
        pool.claim(a, MORPHO_LINE, e1);

        uint256 toB = shares * 2e18 / 2.75e18;
        assertEq(pool.claim(b, MORPHO_LINE, e1), toB);
        assertEq(vault.balanceOf(alice), toB);
    }

    /* Loss ledger */

    function test_checkpoint_morphoBadDebt_recordsExactLoss() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(100_000e18);
        _borrowMorpho(morphoBorrower, 1e18, 60_000e18);
        _warp(1 days);

        // The first checkpoint sets the mark; each later one moves it (interest only raises the price).
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        _warp(1 days);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        Market memory m0 = morpho.market(btcMarketId);
        bytes32 id = Id.unwrap(btcMarketId);
        (uint128 markAssets, uint128 markShares, bool set, uint256 markAdapterShares) = pool.highWaterMark(MORPHO_LINE);
        assertTrue(set);
        assertEq(markAssets, m0.totalSupplyAssets);
        assertEq(markShares, m0.totalSupplyShares);
        assertEq(markAdapterShares, morphoAdapter.supplyShares(id), "the adapter's shares at the mark");

        _shock(6000);
        uint256 assetsBefore = morphoAdapter.expectedSupplyAssets(id);
        _liquidateMorpho(liquidator, morphoBorrower);
        Market memory m1 = morpho.market(btcMarketId);
        uint256 badDebt = m0.totalSupplyAssets - m1.totalSupplyAssets;
        uint256 expected = assetsBefore - morphoAdapter.expectedSupplyAssets(id);
        assertGt(badDebt, 25_000e18);

        vm.expectEmit(address(pool));
        emit SuretyPool.LossRecorded(MORPHO_LINE, expected);
        uint256 loss = pool.checkpoint(MORPHO_LINE);

        assertEq(loss, expected, "adapter's drop in Morpho-rounded supply assets");
        assertApproxEqAbs(loss, badDebt, 2, "sole supplier bears the whole bad debt");
        assertEq(pool.lossRecorded(MORPHO_LINE), loss);
        assertEq(pool.uncoveredLoss(MORPHO_LINE), loss);

        // Recorded once: the mark moved down to the new price.
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        _warp(1 hours);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        assertEq(pool.lossRecorded(MORPHO_LINE), loss);
    }

    /// @dev Morpho's supply share price never falls through rounding, so the mark always moves: a dust-sized drop is
    /// not recorded and not carried over, and a later material loss is measured from the new mark.
    function test_checkpoint_morphoDust_ignoredAndMarkMoves() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(100_000e18);
        // A position small enough that its bad debt is dust.
        _borrowMorpho(morphoBorrower, 1e7, 5e11);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        (uint128 markAssets,,,) = pool.highWaterMark(MORPHO_LINE);

        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        uint256 afterDust = morpho.market(btcMarketId).totalSupplyAssets;
        assertLt(afterDust, markAssets, "dust bad debt realised");
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        (uint128 moved,,,) = pool.highWaterMark(MORPHO_LINE);
        assertEq(moved, afterDust, "the mark moved to the new price");

        // A material loss later is measured from the new mark only.
        _shock(0);
        _borrowMorpho(carol, 1e18, 60_000e18);
        _shock(6000);
        uint256 before = morphoAdapter.expectedSupplyAssets(Id.unwrap(btcMarketId));
        _liquidateMorpho(liquidator, carol);
        uint256 loss = pool.checkpoint(MORPHO_LINE);
        assertApproxEqAbs(loss, before - morphoAdapter.expectedSupplyAssets(Id.unwrap(btcMarketId)), 2);
    }

    /// @dev Shares that leave the adapter after the mark (here, a sentinel deallocating in place of anyone's
    /// forceDeallocate) left at the impaired price, so the loss is still valued on the shares held at the mark.
    function test_checkpoint_morphoLoss_valuedOnSharesHeldAtMark() public {
        _deposit(lender, 100_000e18);
        _allocateMorpho(100_000e18);
        _borrowMorpho(morphoBorrower, 1e18, 60_000e18);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        bytes32 id = Id.unwrap(btcMarketId);
        uint256 atMark = morphoAdapter.expectedSupplyAssets(id);

        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        uint256 drop = atMark - morphoAdapter.expectedSupplyAssets(id);
        assertGt(drop, 25_000e18);
        _deallocateMorpho(morphoAdapter.expectedSupplyAssets(id) * 95 / 100);

        uint256 loss = pool.checkpoint(MORPHO_LINE);
        assertApproxEqAbs(loss, drop, 2, "the whole drop, not 5% of it");
        (,,, uint256 markAdapterShares) = pool.highWaterMark(MORPHO_LINE);
        assertEq(markAdapterShares, morphoAdapter.supplyShares(id), "the mark now holds the shares left");
        assertEq(pool.checkpoint(MORPHO_LINE), 0, "recorded once");
    }

    function test_checkpoint_veBTCShortfall_recordsLoss() public {
        _fundLine(100_000e18);
        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        assertEq(pool.checkpoint(VE_LINE), 0);

        _shock(6000);
        line.startAuction(loanId);
        uint256 debt = line.debtOf(loanId);
        uint256 price = _bid(bidder, loanId);
        uint256 shortfall = line.badDebtTotal();
        assertEq(shortfall, debt - price);
        assertGt(shortfall, 7_000e18);

        vm.expectEmit(address(pool));
        emit SuretyPool.LossRecorded(VE_LINE, shortfall);
        assertEq(pool.checkpoint(VE_LINE), shortfall);
        assertEq(pool.lossRecorded(VE_LINE), shortfall);
        assertEq(pool.uncoveredLoss(VE_LINE), shortfall);
        assertEq(pool.checkpoint(VE_LINE), 0);

        // A second shortfall adds only its own amount.
        _shock(0);
        (uint256 loan2,) = _openTimed(bidder, 0.5e18, 20_000e18);
        _shock(6000);
        line.startAuction(loan2);
        _bid(keeper, loan2);
        uint256 second = line.badDebtTotal() - shortfall;
        assertGt(second, 0);
        assertEq(pool.checkpoint(VE_LINE), second);
        assertEq(pool.lossRecorded(VE_LINE), line.badDebtTotal());
    }

    /// @dev The CreditVoter only lists Morpho lines on the vault's Morpho adapter; the pool checks again.
    function test_checkpoint_rejectsForeignMorphoAdapter() public {
        vm.expectRevert(CreditVoter.UnsupportedAdapter.selector);
        vm.prank(admin);
        voter.addLine(address(line), abi.encode(btcMarket), ICreditVoter.LineKind.Morpho, "x");

        ICreditVoter.Line memory foreign = ICreditVoter.Line({
            adapter: makeAddr("otherAdapter"),
            data: abi.encode(btcMarket),
            kind: ICreditVoter.LineKind.Morpho,
            active: true,
            name: "x"
        });
        vm.mockCall(address(voter), abi.encodeCall(ICreditVoter.line, (5)), abi.encode(foreign));
        vm.expectRevert(SuretyPool.UnsupportedAdapter.selector);
        pool.checkpoint(5);
    }

    /* Cover */

    /// @dev Cohorts of the Morpho line in e1 (matured by e7), e6 and e7, one of the veBTC line in e6, and a reserve.
    struct SlashScene {
        uint256 tokenId;
        uint256 e1;
        uint256 e6;
        uint256 e7;
        uint256 m1;
        uint256 m6;
        uint256 m7;
        uint256 v6;
        uint256 reserve;
    }

    function _slashScene() internal returns (SlashScene memory sc) {
        sc.tokenId = _lockPermanent(alice, 1e18);
        _deposit(lender, 100_000e18);
        _allocateMorpho(20_000e18);
        _borrowMorpho(morphoBorrower, 0.2e18, 10_000e18);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);

        _warpEpochs(1);
        sc.e1 = _currentEpoch();
        _vote(alice, sc.tokenId, _arr(MORPHO_LINE, VE_LINE), _arr(5000, 5000));
        sc.m1 = _post(sponsor, MORPHO_LINE, 4_000e18);
        _warpEpochs(5);
        sc.e6 = _currentEpoch();
        voter.poke(sc.tokenId);
        sc.m6 = _post(sponsor, MORPHO_LINE, 3_000e18);
        sc.v6 = _post(sponsor, VE_LINE, 2_000e18);
        _warpEpochs(1);
        sc.e7 = _currentEpoch();
        voter.poke(sc.tokenId);
        sc.m7 = _post(sponsor, MORPHO_LINE, 2_000e18);
        // Fee shares earned so far seed the reserve.
        vault.accrueInterest();
        _distribute(0, new uint256[](0), new uint256[](0));
        sc.reserve = pool.reserveShares();
        assertGt(sc.reserve, 0);
        assertEq(pool.maturityOf(sc.e1), sc.e7, "the e1 cohort matured at the start of e7");
    }

    function test_cover_slashesOnlyUnmaturedCohortsOfThatLine() public {
        SlashScene memory sc = _slashScene();
        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        uint256 loss = pool.checkpoint(MORPHO_LINE);
        assertGt(loss, 3_000e18);
        vault.accrueInterest();
        uint256 assets = _fullCoverAssets(loss);
        assertGt(assets, loss, "grossed up for the fee VaultV2 takes on the returned MUSD");
        assertLt(assets, vault.previewRedeem(sc.m6 + sc.m7), "unmatured cohorts of the line suffice");
        uint256 burn = vault.previewWithdraw(assets);
        // The current epoch's cohort is cut first (rounded down); the last one takes the rest.
        uint256 cut7 = burn * sc.m7 / (sc.m6 + sc.m7);
        uint256 accounted = pool.accountedShares();

        vm.expectEmit(address(pool));
        emit SuretyPool.CohortSlashed(MORPHO_LINE, sc.e7, cut7);
        vm.expectEmit(address(pool));
        emit SuretyPool.CohortSlashed(MORPHO_LINE, sc.e6, burn - cut7);
        vm.expectEmit(address(pool));
        emit SuretyPool.Covered(MORPHO_LINE, loss, assets, burn, 0);
        vm.prank(keeper);
        assertEq(pool.cover(MORPHO_LINE), loss);

        assertEq(_cohortShares(MORPHO_LINE, sc.e6), sc.m6 - (burn - cut7));
        assertEq(_cohortShares(MORPHO_LINE, sc.e7), sc.m7 - cut7);
        assertEq(_cohortShares(MORPHO_LINE, sc.e1), sc.m1, "matured cohort untouched");
        assertEq(_cohortShares(VE_LINE, sc.e6), sc.v6, "other line untouched");
        assertEq(pool.reserveShares(), sc.reserve, "cohorts sufficed");
        assertEq(pool.accountedShares(), accounted - burn);
        assertEq(pool.uncoveredLoss(MORPHO_LINE), 0);
        assertEq(pool.lossCovered(MORPHO_LINE), loss);

        // The matured cohort still pays its voter in full.
        assertEq(pool.claim(sc.tokenId, MORPHO_LINE, sc.e1), sc.m1);
        assertEq(vault.balanceOf(alice), sc.m1);
    }

    function test_cover_skipsUnbackedCohorts() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _fundLine(100_000e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        // Incentives on the veBTC line in e1 drew no votes: refundable, never first loss.
        uint256 unbacked = _post(sponsor, VE_LINE, 2_000e18);
        _warpEpochs(1);
        _voteAll(alice, a, VE_LINE);
        uint256 backed = _post(sponsor, VE_LINE, 1_000e18);

        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        _shock(6000);
        line.startAuction(loanId);
        _bid(bidder, loanId);
        assertEq(pool.coverCapacity(VE_LINE), vault.previewRedeem(backed));

        pool.cover(VE_LINE);
        assertEq(_cohortShares(VE_LINE, e1), unbacked);
        assertLe(_cohortShares(VE_LINE, _currentEpoch()), 1);
        vm.prank(sponsor);
        assertEq(pool.refundIncentive(VE_LINE, e1), unbacked);
    }

    function test_cover_thenReserve_thenLendersBearRest() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _deposit(lender, 100_000e18);
        _allocateMorpho(20_000e18);
        _borrowMorpho(morphoBorrower, 0.2e18, 10_000e18);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        vault.accrueInterest();
        _distribute(0, new uint256[](0), new uint256[](0));
        uint256 reserve = pool.reserveShares();
        assertGt(reserve, 0);
        uint256 cohortShares = _post(sponsor, MORPHO_LINE, 1_000e18);
        uint256 lenderPreLoss = vault.previewRedeem(vault.balanceOf(lender));

        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        uint256 loss = pool.checkpoint(MORPHO_LINE);
        uint256 capacity = pool.coverCapacity(MORPHO_LINE);
        assertEq(capacity, vault.previewRedeem(cohortShares + reserve));
        assertLt(capacity, loss, "pool smaller than the loss");
        uint256 lenderPostLoss = vault.previewRedeem(vault.balanceOf(lender));
        assertLt(lenderPostLoss, lenderPreLoss);

        uint256 covered = _coverAllCapacity(loss, capacity, cohortShares);
        assertEq(_cohortShares(MORPHO_LINE, e1), 0, "first loss: cohort exhausted");
        assertLe(pool.reserveShares(), 1, "second loss: reserve exhausted");
        assertEq(pool.uncoveredLoss(MORPHO_LINE), loss - covered, "third loss: lenders");
        assertGt(pool.uncoveredLoss(MORPHO_LINE), 0);

        // Nothing left to slash: further calls pay at most a share's dust and never revert.
        assertLe(pool.cover(MORPHO_LINE), 2);

        // Lenders recover part of the loss. VaultV2 re-recognises the restored assets as interest, at most at
        // maxRate (so over days, not at once), and takes its 10% performance fee on them.
        _warp(30 days);
        vault.accrueInterest();
        uint256 lenderAfter = vault.previewRedeem(vault.balanceOf(lender));
        assertGt(lenderAfter, lenderPostLoss);
        assertLt(lenderAfter, lenderPreLoss);
    }

    /// @dev Covers the Morpho line when the pool (`capacity` MUSD, `cohortShares` of it in cohorts) is smaller than
    /// `loss`: all of it moves, and it covers W*(1-f)*(A+U)/(A-f*W) loss units.
    function _coverAllCapacity(uint256 loss, uint256 capacity, uint256 cohortShares)
        internal
        returns (uint256 covered)
    {
        vault.accrueInterest();
        uint256 burn = vault.previewWithdraw(capacity);
        uint256 units = _partialCoverUnits(loss, capacity);
        assertLt(units, capacity, "the fee VaultV2 takes on the returned MUSD is not cover");
        vm.recordLogs();
        covered = pool.cover(MORPHO_LINE);
        (uint256 loggedUnits, uint256 moved, uint256 fromCohorts, uint256 fromReserve) = _coveredLog();
        assertEq(loggedUnits, covered);
        assertApproxEqAbs(covered, units, 2, "loss units: W*(1-f)*(A+U)/(A-f*W)");
        assertEq(moved, capacity, "the whole capacity moved");
        assertEq(fromCohorts, cohortShares);
        assertEq(fromReserve, burn - cohortShares);
    }

    function test_cover_repeated_neverExceedsRecordedLoss() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _deposit(lender, 100_000e18);
        _allocateMorpho(20_000e18);
        _borrowMorpho(morphoBorrower, 0.2e18, 10_000e18);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, a, MORPHO_LINE);
        _post(sponsor, MORPHO_LINE, 1_000e18);

        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        // cover() checkpoints first: the loss is recorded and partly covered in one call.
        uint256 c1 = pool.cover(MORPHO_LINE);
        uint256 loss = pool.lossRecorded(MORPHO_LINE);
        assertGt(loss, 3_000e18);
        assertEq(pool.lossCovered(MORPHO_LINE), c1);
        assertApproxEqRel(c1, 900e18, 0.05e18, "the cohort, valued after the loss, less the fee on what it returns");
        uint256 c2 = pool.cover(MORPHO_LINE);
        assertLe(c2, 2);

        // New first-loss capital arrives; the next cover finishes the job and stops at the recorded loss.
        _post(sponsor, MORPHO_LINE, 10_000e18);
        uint256 c3 = pool.cover(MORPHO_LINE);
        assertEq(c1 + c2 + c3, loss);
        assertEq(pool.lossCovered(MORPHO_LINE), loss);
        assertEq(pool.uncoveredLoss(MORPHO_LINE), 0);
        uint256 left = _cohortShares(MORPHO_LINE, e1);
        assertGt(left, 0);

        for (uint256 i; i < 3; ++i) {
            assertEq(pool.cover(MORPHO_LINE), 0);
        }
        _warpEpochs(1);
        voter.poke(a);
        _post(sponsor, MORPHO_LINE, 5_000e18);
        assertEq(pool.cover(MORPHO_LINE), 0);
        assertEq(_cohortShares(MORPHO_LINE, e1), left);
        assertEq(pool.lossCovered(MORPHO_LINE), pool.lossRecorded(MORPHO_LINE));

        // The covered cohort is never paid out of a later, matured state either: its voters get what is left.
        vm.warp(pool.maturityOf(e1));
        assertEq(pool.claim(a, MORPHO_LINE, e1), left);
    }

    /// @dev The Morpho adapter values its position from its own supply-share ledger, so cover cannot be supplied to
    /// Morpho on its behalf (see the stranded-supply test below). Cover instead returns the redeemed MUSD to the
    /// vault, which restores the assets the vault lost through the adapter without leaving shares stranded.
    function test_cover_restoresMorphoAdapterAssets() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _deposit(lender, 100_000e18);
        _allocateMorpho(20_000e18);
        _borrowMorpho(morphoBorrower, 0.2e18, 10_000e18);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        _warpEpochs(1);
        _voteAll(alice, a, MORPHO_LINE);
        _post(sponsor, MORPHO_LINE, 10_000e18);
        vault.accrueInterest();
        assertEq(pool.checkpoint(MORPHO_LINE), 0, "mark raised to the pre-loss price");
        uint256 lenderPreLoss = vault.previewRedeem(vault.balanceOf(lender));
        bytes32 id = Id.unwrap(btcMarketId);
        uint256 adapterPreLoss = morphoAdapter.expectedSupplyAssets(id);

        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        uint256 adapterPostLoss = morphoAdapter.expectedSupplyAssets(id);
        uint256 lost = adapterPreLoss - adapterPostLoss;
        uint256 idle = musd.balanceOf(address(vault));
        uint256 positionShares = morpho.position(btcMarketId, address(morphoAdapter)).supplyShares;

        uint256 covered = pool.cover(MORPHO_LINE);
        assertEq(covered, pool.lossRecorded(MORPHO_LINE));
        assertApproxEqAbs(covered, lost, 1, "the adapter's whole loss is paid back");
        assertEq(musd.balanceOf(address(vault)), idle, "redeemed MUSD returned to the vault");
        assertEq(musd.balanceOf(address(pool)), 0);
        assertEq(morpho.position(btcMarketId, address(morphoAdapter)).supplyShares, positionShares);
        assertEq(morphoAdapter.supplyShares(id), positionShares, "no stranded Morpho shares");
        assertEq(morphoAdapter.expectedSupplyAssets(id), adapterPostLoss, "the line itself did not grow back");

        // VaultV2 re-recognises the restored assets at most at maxRate; once it has, lenders are back at the pre-loss
        // price: the cover was sized for the 10% performance fee taken on them (which flows back to the pool).
        _warp(1);
        vault.accrueInterest();
        assertLt(vault.previewRedeem(vault.balanceOf(lender)), lenderPreLoss - covered / 2, "not at once");
        _warp(30 days);
        vault.accrueInterest();
        uint256 lenderAfter = vault.previewRedeem(vault.balanceOf(lender));
        assertApproxEqRel(lenderAfter, lenderPreLoss, EXACT);
        uint256 realAssets = musd.balanceOf(address(vault)) + morphoAdapter.realAssets() + line.realAssets();
        assertEq(vault.totalAssets(), realAssets);
    }

    /// @dev Why cover does not use `morpho.supply(params, assets, 0, morphoAdapter, "")`: MorphoMarketV1AdapterV2
    /// values its position from its own `supplyShares` ledger, so a supply made on its behalf is invisible to the
    /// vault and cannot be withdrawn through the adapter.
    function test_morphoSupplyOnBehalfOfAdapter_isStranded() public {
        _deposit(lender, 10_000e18);
        _allocateMorpho(10_000e18);
        bytes32 id = Id.unwrap(btcMarketId);
        uint256 realBefore = morphoAdapter.realAssets();

        musd.mint(address(this), 1_000e18);
        musd.approve(address(morpho), 1_000e18);
        morpho.supply(btcMarket, 1_000e18, 0, address(morphoAdapter), "");

        assertApproxEqAbs(morphoAdapter.realAssets(), realBefore, 1, "vault sees nothing");
        assertGt(morpho.position(btcMarketId, address(morphoAdapter)).supplyShares, morphoAdapter.supplyShares(id));
    }

    function test_cover_veBTCLine_paysLine_partialWhenIlliquid() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _fundLine(100_000e18);
        _warpEpochs(1);
        _voteAll(alice, a, VE_LINE);
        _post(sponsor, VE_LINE, 10_000e18);
        // Leave only 1,000 MUSD idle in the vault.
        _allocateLine(9_000e18);
        assertEq(musd.balanceOf(address(vault)), 1_000e18);

        (uint256 loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        uint256 preBid = line.realAssets();
        _shock(6000);
        line.startAuction(loanId);
        _bid(bidder, loanId);
        uint256 shortfall = line.badDebtTotal();
        uint256 cashBefore = line.cash();

        // Only the idle MUSD can be redeemed now: cover what it can, no revert.
        vault.accrueInterest();
        uint256 units = _partialCoverUnits(shortfall, 1_000e18);
        uint256 first = pool.cover(VE_LINE);
        assertApproxEqAbs(first, units, 2);
        assertEq(line.cash(), cashBefore + 1_000e18, "all the idle MUSD paid in");
        assertEq(pool.uncoveredLoss(VE_LINE), shortfall - first);
        assertEq(musd.allowance(address(pool), address(line)), 0);
        assertEq(pool.cover(VE_LINE), 0, "no idle MUSD left");

        // Once liquidity is back in the vault the rest is covered.
        _deallocateLine(20_000e18);
        cashBefore = line.cash();
        assertEq(pool.cover(VE_LINE), shortfall - first);
        uint256 paid = 1_000e18 + line.cash() - cashBefore;
        assertGt(paid, shortfall, "grossed up for the fee VaultV2 takes on it");
        assertEq(pool.uncoveredLoss(VE_LINE), 0);
        assertEq(line.realAssets(), preBid - 20_000e18 - shortfall + paid, "line paid its shortfall and the gross-up");
        assertEq(line.badDebtTotal(), shortfall, "ledger stays cumulative");
        assertEq(pool.checkpoint(VE_LINE), 0);
    }

    function test_cover_partialWhenIlliquid_morphoLine_completesOnRepeat() public {
        uint256 a = _lockPermanent(alice, 1e18);
        _deposit(lender, 20_000e18);
        _warpEpochs(1);
        _voteAll(alice, a, MORPHO_LINE);
        _post(sponsor, MORPHO_LINE, 10_000e18);
        _allocateMorpho(28_000e18);
        _borrowMorpho(morphoBorrower, 0.2e18, 10_000e18);
        assertEq(pool.checkpoint(MORPHO_LINE), 0);
        assertEq(musd.balanceOf(address(vault)), 2_000e18);

        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        vm.recordLogs();
        uint256 first = pool.cover(MORPHO_LINE);
        (, uint256 moved,,) = _coveredLog();
        assertEq(moved, 2_000e18, "all the idle MUSD");
        uint256 loss = pool.lossRecorded(MORPHO_LINE);
        assertGt(first, 0);
        assertLt(first, loss);
        // The MUSD went straight back to the vault, so the next call can continue.
        assertEq(musd.balanceOf(address(vault)), 2_000e18);
        assertEq(pool.cover(MORPHO_LINE), loss - first);
        assertEq(pool.uncoveredLoss(MORPHO_LINE), 0);
    }

    /* Cover sizing */

    /// @dev 0.01%, the tolerance of the exact-restoration checks.
    uint256 internal constant EXACT = 1e14;

    /// @dev A lender holding most of the vault (100k MUSD), alice voting both lines and 10k MUSD of incentives on
    /// each, plus one borrower on `lineId` only: a veBTC loan of 40k against 1 BTC (50k allocated to the line) or a
    /// Morpho borrow of 10k against 0.2 BTC (20k allocated). Once that borrower is closed out nothing earns interest,
    /// so lender value moves only through the loss, the cover and VaultV2's recognition of the returned MUSD.
    function _sizingScene(uint256 lineId) internal returns (uint256 loanId) {
        uint256 a = _lockPermanent(alice, 1e18);
        _deposit(lender, 100_000e18);
        _warpEpochs(1);
        _vote(alice, a, _arr(MORPHO_LINE, VE_LINE), _arr(5000, 5000));
        _post(sponsor, MORPHO_LINE, 10_000e18);
        _post(sponsor, VE_LINE, 10_000e18);
        if (lineId == VE_LINE) {
            _allocateLine(50_000e18);
            (loanId,) = _openTimed(borrower, 1e18, 40_000e18);
        } else {
            _allocateMorpho(20_000e18);
            _borrowMorpho(morphoBorrower, 0.2e18, 10_000e18);
            assertEq(pool.checkpoint(MORPHO_LINE), 0);
        }
    }

    /// @dev BTC drops 60% and the scene's borrower is closed out below its debt; returns the loss recorded.
    function _takeLoss(uint256 lineId, uint256 loanId) internal returns (uint256 loss) {
        _shock(6000);
        if (lineId == VE_LINE) {
            line.startAuction(loanId);
            _bid(bidder, loanId);
        } else {
            _liquidateMorpho(liquidator, morphoBorrower);
        }
        loss = pool.checkpoint(lineId);
        assertGt(loss, 1_000e18);
    }

    /// @dev Long enough for VaultV2 to recognise every returned MUSD under MAX_MAX_RATE, in one accrual.
    function _recognise() internal {
        _warp(30 days);
        vault.accrueInterest();
        uint256 real = musd.balanceOf(address(vault)) + morphoAdapter.realAssets() + line.realAssets();
        assertEq(vault.totalAssets(), real, "everything recognised");
    }

    function _valueOf(address who) internal view returns (uint256) {
        return vault.previewRedeem(vault.balanceOf(who));
    }

    /// @dev Cover inputs after `vault.accrueInterest()`, checking nothing awaits recognition (realAssets == A).
    function _sizingInputs() internal view returns (uint256 a, uint256 fee) {
        a = vault.totalAssets();
        fee = vault.performanceFee();
        uint256 real = musd.balanceOf(address(vault)) + morphoAdapter.realAssets() + line.realAssets();
        assertEq(real, a, "nothing pending recognition");
    }

    /// @dev MUSD a full cover of `loss` moves: A*U/(A+U-f*A), rounded up as the pool does.
    function _fullCoverAssets(uint256 loss) internal view returns (uint256) {
        (uint256 a, uint256 fee) = _sizingInputs();
        return Math.mulDiv(a, loss, a + loss - Math.mulDiv(a, fee, 1e18, Math.Rounding.Ceil), Math.Rounding.Ceil);
    }

    /// @dev Loss units a cover of `loss` cut short at `assets` MUSD covers: W*(1-f)*(A+U)/(A-f*W).
    function _partialCoverUnits(uint256 loss, uint256 assets) internal view returns (uint256) {
        (uint256 a, uint256 fee) = _sizingInputs();
        return Math.mulDiv(assets, (1e18 - fee) * (a + loss), a * 1e18 - assets * fee);
    }

    /// @dev The single Covered event in the recorded logs: (lossUnitsCovered, assetsMoved, fromCohorts, fromReserve).
    function _coveredLog()
        internal
        view
        returns (uint256 units, uint256 assets, uint256 fromCohorts, uint256 fromReserve)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != SuretyPool.Covered.selector) continue;
            (units, assets, fromCohorts, fromReserve) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            ++found;
        }
        assertEq(found, 1, "one Covered event");
    }

    /// @dev After a full cover and full recognition, non-pool shares are back at the pre-loss price, and the pool's
    /// value (net of the fee shares VaultV2 mints it on the returned MUSD) is down by exactly the loss. Checked on a
    /// veBTC-line shortfall and, separately, on Morpho bad debt.
    function test_cover_restoresLenderPriceExactly_afterRecognition() public {
        assertEq(vault.performanceFee(), 0.1e18);
        assertEq(vault.maxRate(), MAX_MAX_RATE);
        uint256 snap = vm.snapshotState();
        for (uint256 lineId; lineId < 2; ++lineId) {
            vm.revertToState(snap);
            uint256 loanId = _sizingScene(lineId);
            uint256 lenderPre = _valueOf(lender);
            uint256 poolPre = _valueOf(address(pool));
            assertGt(vault.balanceOf(lender) * 2, vault.totalSupply(), "the lender holds most shares");

            uint256 loss = _takeLoss(lineId, loanId);
            vault.accrueInterest();
            assertLt(_valueOf(lender), lenderPre - loss / 2, "the vault realised the loss");

            assertEq(pool.cover(lineId), loss);
            assertEq(pool.uncoveredLoss(lineId), 0);
            _recognise();

            assertApproxEqRel(_valueOf(lender), lenderPre, EXACT, "lender back at the pre-loss price");
            assertApproxEqRel(poolPre - _valueOf(address(pool)), loss, EXACT, "the pool bore exactly the loss");
            assertGt(_pendingFeeShares(), 0, "fee shares on the returned MUSD came back to the pool");
        }
    }

    /// @dev A cover cut short by idle MUSD, then finished once the allocator frees liquidity, ends at the same
    /// lender price as one cover of the whole loss: right away, or after VaultV2 recognised the first part.
    function test_cover_partialThenFull_equalsOneShot() public {
        uint256 loanId = _sizingScene(VE_LINE);
        // Leave 4,000 MUSD idle: less than a full cover needs.
        _allocateLine(66_000e18);
        assertEq(musd.balanceOf(address(vault)), 4_000e18);
        uint256 lenderPre = _valueOf(lender);
        uint256 loss = _takeLoss(VE_LINE, loanId);
        uint256 snap = vm.snapshotState();

        _deallocateLine(20_000e18);
        assertEq(pool.cover(VE_LINE), loss);
        _recognise();
        uint256 oneShot = _valueOf(lender);
        assertApproxEqRel(oneShot, lenderPre, EXACT, "one shot restores the pre-loss price");

        for (uint256 recogniseBetween; recogniseBetween < 2; ++recogniseBetween) {
            vm.revertToState(snap);
            uint256 first = pool.cover(VE_LINE);
            assertGt(first, 0);
            assertLt(first, loss, "cut short by idle MUSD");
            assertEq(musd.balanceOf(address(vault)), 0, "all idle MUSD moved");
            if (recogniseBetween == 1) _recognise();
            _deallocateLine(20_000e18);
            assertEq(pool.cover(VE_LINE), loss - first, "the rest");
            assertEq(pool.lossCovered(VE_LINE), loss);
            _recognise();
            assertApproxEqRel(_valueOf(lender), oneShot, EXACT, "same lender price as one shot");
        }
    }

    /// @dev Without a performance fee the cover moves A*U/(A+U) MUSD, which burns U/(A+U) of the supply: exactly the
    /// shares the loss is worth at the pre-loss price (A+U)/T.
    function test_cover_feeZero_burnsExactlyAUoverAplusU() public {
        _curate(abi.encodeCall(IVaultV2.setPerformanceFee, (0)));
        uint256 loanId = _sizingScene(VE_LINE);
        uint256 lenderPre = _valueOf(lender);
        uint256 loss = _takeLoss(VE_LINE, loanId);
        vault.accrueInterest();
        uint256 a = vault.totalAssets();
        uint256 t = vault.totalSupply();
        uint256 poolShares = vault.balanceOf(address(pool));
        uint256 cash = line.cash();

        assertEq(pool.cover(VE_LINE), loss);
        assertApproxEqAbs(line.cash() - cash, a * loss / (a + loss), 1, "moves A*U/(A+U)");
        uint256 burned = poolShares - vault.balanceOf(address(pool));
        assertApproxEqAbs(burned, loss * t / (a + loss), 2, "burns U*T/(A+U) shares");

        _recognise();
        assertEq(vault.balanceOf(address(pool)), poolShares - burned, "no fee shares");
        assertApproxEqRel(_valueOf(lender), lenderPre, EXACT, "lender back at the pre-loss price");
    }

    /* Fuzz: cohort conservation */

    struct Ledger {
        uint256 incentives;
        uint256 feesToCohorts;
        uint256 feesToReserve;
        uint256 claimedToOwners;
        uint256 claimedToReserve;
        uint256 slashed;
        uint256 fromReserve;
        uint256 refunded;
    }

    uint256 internal fuzzStart;
    uint256 internal tokenA;
    uint256 internal tokenB;

    /// @dev Random sequences of incentives, votes, epoch flips, fee distributions (to open, eligible and matured
    /// epochs), veBTC-line bad debt with cover, claims and refunds. After every step, shares that entered cohorts
    /// equal shares claimed + slashed + refunded + still held, the reserve equals its inflows minus what cover took,
    /// and cohorts + reserve equal the pool's accounted shares, which never exceed its vault balance.
    function testFuzz_cohortConservation(uint256 seed) public {
        _runConservation(seed);
    }

    function _runConservation(uint256 seed) internal returns (Ledger memory led) {
        tokenA = _lockPermanent(alice, 2e18);
        tokenB = _lockPermanent(bob, 1e18);
        _deposit(lender, 200_000e18);
        _allocateMorpho(50_000e18);
        _borrowMorpho(morphoBorrower, 1e18, 30_000e18);
        _allocateLine(50_000e18);
        _warpEpochs(1);
        fuzzStart = _currentEpoch();
        _castBallots(seed);

        for (uint256 i; i < 10; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 op = r % 6;
            if (op == 0) {
                led.incentives += _post(sponsor, (r >> 8) % 2, 1e18 + (r >> 16) % 5_000e18);
            } else if (op == 1) {
                _warpEpochs(1);
                _castBallots(r);
            } else if (op == 2) {
                _fuzzDistribute(r, led);
            } else if (op == 3) {
                _fuzzLossAndCover(led);
            } else if (op == 4) {
                _fuzzClaimAll(led);
            } else {
                _fuzzRefundAll(led);
            }
            _assertConservation(led);
        }
        vm.warp(pool.maturityOf(_currentEpoch()));
        _fuzzClaimAll(led);
        _fuzzRefundAll(led);
        _assertConservation(led);
    }

    function _castBallots(uint256 r) internal {
        _vote(alice, tokenA, _ballotLines(r), _ballotWeights(r));
        _vote(bob, tokenB, _ballotLines(r >> 4), _ballotWeights(r >> 4));
    }

    function _ballotLines(uint256 r) internal pure returns (uint256[] memory) {
        uint256 k = r % 3;
        return k == 0 ? _arr(MORPHO_LINE) : k == 1 ? _arr(VE_LINE) : _arr(MORPHO_LINE, VE_LINE);
    }

    function _ballotWeights(uint256 r) internal pure returns (uint256[] memory) {
        return r % 3 == 2 ? _arr(3000, 7000) : _arr(BPS);
    }

    function _fuzzDistribute(uint256 r, Ledger memory led) internal {
        _warp(1 days);
        uint256 back = (r >> 8) % 8;
        uint256 cohortEpoch = _currentEpoch() - back * EPOCH_LENGTH;
        vm.recordLogs();
        _distribute(cohortEpoch, _arr(MORPHO_LINE, VE_LINE), _arr((r >> 16) % 1000, (r >> 32) % 1000));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != SuretyPool.FeesDistributed.selector) {
                continue;
            }
            (uint256 shares, uint256 toReserve) = abi.decode(logs[i].data, (uint256, uint256));
            led.feesToCohorts += shares - toReserve;
            led.feesToReserve += toReserve;
        }
    }

    function _fuzzLossAndCover(Ledger memory led) internal {
        uint256 tokenId = _lockPermanent(borrower, 0.1e18);
        uint256 loanId = _open(borrower, tokenId, 3_000e18);
        _shock(8000);
        line.startAuction(loanId);
        _bid(bidder, loanId);
        _shock(0);
        vm.recordLogs();
        pool.cover(VE_LINE);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != SuretyPool.Covered.selector) continue;
            (,, uint256 fromCohorts, uint256 fromReserve) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            led.slashed += fromCohorts;
            led.fromReserve += fromReserve;
        }
        assertLe(pool.lossCovered(VE_LINE), pool.lossRecorded(VE_LINE));
    }

    function _fuzzClaimAll(Ledger memory led) internal {
        for (uint256 e = fuzzStart; e <= _currentEpoch(); e += EPOCH_LENGTH) {
            if (block.timestamp < pool.maturityOf(e)) break;
            for (uint256 lineId; lineId < 2; ++lineId) {
                _fuzzClaim(tokenA, lineId, e, led);
                _fuzzClaim(tokenB, lineId, e, led);
            }
        }
    }

    function _fuzzClaim(uint256 tokenId, uint256 lineId, uint256 e, Ledger memory led) internal {
        if (voter.tokenVotes(e, tokenId, lineId) == 0 || pool.isClaimed(tokenId, lineId, e)) return;
        led.claimedToOwners += pool.claim(tokenId, lineId, e);
    }

    function _fuzzRefundAll(Ledger memory led) internal {
        for (uint256 e = fuzzStart; e + EPOCH_LENGTH <= block.timestamp; e += EPOCH_LENGTH) {
            for (uint256 lineId; lineId < 2; ++lineId) {
                if (voter.lineVotes(e, lineId) != 0 || pool.sponsorShares(lineId, e, sponsor) == 0) continue;
                vm.prank(sponsor);
                led.refunded += pool.refundIncentive(lineId, e);
            }
        }
    }

    function _assertConservation(Ledger memory led) internal view {
        uint256 held = 0;
        for (uint256 e = fuzzStart; e <= _currentEpoch(); e += EPOCH_LENGTH) {
            held += _cohortShares(MORPHO_LINE, e) + _cohortShares(VE_LINE, e);
        }
        assertEq(
            led.incentives + led.feesToCohorts,
            led.claimedToOwners + led.claimedToReserve + led.slashed + led.refunded + held,
            "cohort inflows == claimed + slashed + refunded + remaining"
        );
        assertEq(pool.reserveShares(), led.feesToReserve + led.claimedToReserve - led.fromReserve, "reserve ledger");
        assertEq(held + pool.reserveShares(), pool.accountedShares(), "accounted shares");
        assertLe(pool.accountedShares(), vault.balanceOf(address(pool)), "backed by vault shares");
        assertLe(pool.lossCovered(VE_LINE), pool.lossRecorded(VE_LINE));
    }
}
