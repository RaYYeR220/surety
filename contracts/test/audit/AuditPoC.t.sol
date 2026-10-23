// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SuretyFixture} from "../utils/SuretyFixture.sol";

/// @notice Regression tests for the security review of 2026-10-23 (SECURITY-REVIEW.md). Each test replays the
/// reviewer's proof of concept on the integrated fixture (real Morpho Blue + AdaptiveCurveIrm + VaultV2 +
/// MorphoMarketV1AdapterV2, mock Mezo veBTC/oracle) and asserts the fixed behaviour; where useful it runs a control
/// branch and an attack branch from the same snapshot.
contract AuditPoCTest is SuretyFixture {
    address internal mallory = makeAddr("mallory");

    /* ------------------------------------------------------------------ */
    /* M-01  Permissionless forceDeallocate no longer moves voter fees      */
    /* ------------------------------------------------------------------ */

    /// @dev E1: alice (6 BTC) votes the Morpho line, bob (1 BTC, the attacker) votes the veBTC line. E2: capital is
    /// split 6:1, a Morpho borrower takes 4,000 MUSD and a veBTC borrower 600 MUSD. Warp to the end of E2.
    function _feeSetup() internal returns (uint256 e1) {
        _deposit(lender, 10_000e18);
        _deposit(bob, 100e18); // a few vault shares to pay VaultV2's 1% force-deallocate penalty
        uint256 aliceId = _lockPermanent(alice, 6e18);
        uint256 bobId = _lockPermanent(bob, 1e18);
        _warpEpochs(1);
        e1 = _currentEpoch();
        _voteAll(alice, aliceId, MORPHO_LINE);
        _voteAll(bob, bobId, VE_LINE);
        _warpEpochs(1);
        _rebalance(); // first rebalance of E2: allocation follows E1's tally
        _borrowMorpho(morphoBorrower, 0.1e18, 4_000e18);
        _openTimed(borrower, 0.05e18, 600e18);
        _warpEpochs(1); // E3 starts; E2's interest is still pending in the allocator ledger
    }

    /// @dev The review's attack: just before the keeper's first rebalance of E3, bob force-deallocates more than the
    /// Morpho line earned since the last rebalance, which used to read as a drop that wiped the line's interest and
    /// sent every fee share to his line's cohort. Interest now comes from Morpho's supply share price (and the veBTC
    /// line's interest counter), so the cohorts get the same fee shares with or without the forced move.
    function test_M01_forceDeallocateCannotMoveVoterFees() public {
        uint256 e1 = _feeSetup();
        uint256 snap = vm.snapshotState();

        _rebalance();
        uint256 ctrlMorpho = _shares(MORPHO_LINE, e1);
        uint256 ctrlVe = _shares(VE_LINE, e1);
        assertGt(ctrlMorpho, 0, "control: Morpho voters get fee shares");
        assertGt(ctrlVe, 0, "control: veBTC voters get fee shares");

        vm.revertToState(snap);
        // ~860 MUSD forced out of Morpho (the line earned well under 1 MUSD in E2) and half of the veBTC line's cash.
        uint256 position = allocator.lineAssets(MORPHO_LINE);
        vm.startPrank(bob);
        vault.forceDeallocate(address(morphoAdapter), abi.encode(btcMarket), position / 10, bob);
        vault.forceDeallocate(address(line), "", line.cash() / 2, bob);
        vm.stopPrank();
        _rebalance();

        assertApproxEqRel(_shares(MORPHO_LINE, e1), ctrlMorpho, 1e9, "Morpho voters keep their fee shares");
        assertApproxEqRel(_shares(VE_LINE, e1), ctrlVe, 1e9, "the attacker's cohort gains nothing");
    }

    /* ------------------------------------------------------------------ */
    /* M-02  A forced exit after Morpho bad debt no longer shrinks the loss */
    /* ------------------------------------------------------------------ */

    /// @dev alice is the Morpho line's only voter and holds a few vault shares; a sponsor's 1,000 MUSD sits in the
    /// line's E1 cohort as first loss. E2: ~10,100 MUSD is supplied to Morpho, a borrower takes 4,000; BTC then
    /// drops 60% and the borrower is liquidated, socialising ~880 MUSD of bad debt onto the adapter.
    function _dodgeSetup() internal returns (uint256 e1) {
        _deposit(lender, 10_000e18);
        _deposit(alice, 200e18);
        uint256 aliceId = _lockPermanent(alice, 6e18);
        _warpEpochs(1);
        e1 = _currentEpoch();
        _voteAll(alice, aliceId, MORPHO_LINE);
        _post(sponsor, MORPHO_LINE, 1_000e18);
        _warpEpochs(1);
        _rebalance();
        _borrowMorpho(morphoBorrower, 0.1e18, 4_000e18);
        _warp(1 days);
        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
    }

    /// @dev The review's attack: before any checkpoint, alice force-deallocates 95% of the adapter's impaired
    /// position and checkpoints herself. The loss is now valued on the shares the adapter held at the mark (the
    /// allocator re-checkpoints after its moves), so the whole loss is recorded, the cohort pays for it as in the
    /// control, and lenders end up as well off as in the control.
    function test_M02_forcedExitStillRecordsTheWholeMorphoLoss() public {
        uint256 e1 = _dodgeSetup();
        uint256 snap = vm.snapshotState();

        vm.startPrank(keeper);
        uint256 lossCtrl = pool.checkpoint(MORPHO_LINE);
        pool.cover(MORPHO_LINE);
        vm.stopPrank();
        uint256 cohortCtrl = _shares(MORPHO_LINE, e1);
        _warp(60 days);
        vault.accrueInterest();
        uint256 lenderCtrl = vault.previewRedeem(vault.balanceOf(lender));
        assertGt(lossCtrl, 800e18);

        vm.revertToState(snap);
        uint256 position = allocator.lineAssets(MORPHO_LINE);
        uint256 aliceBefore = vault.previewRedeem(vault.balanceOf(alice));
        vm.prank(alice);
        vault.forceDeallocate(address(morphoAdapter), abi.encode(btcMarket), position * 95 / 100, alice);
        uint256 penalty = aliceBefore - vault.previewRedeem(vault.balanceOf(alice));
        vm.prank(alice);
        uint256 lossAtk = pool.checkpoint(MORPHO_LINE);
        vm.prank(keeper);
        pool.cover(MORPHO_LINE);
        uint256 cohortAtk = _shares(MORPHO_LINE, e1);
        _warp(60 days);
        vault.accrueInterest();
        uint256 lenderAtk = vault.previewRedeem(vault.balanceOf(lender));

        assertApproxEqAbs(lossAtk, lossCtrl, 2, "the whole loss is recorded");
        // The penalty stays in the vault for every holder, so the cover needs slightly less; the voter saves far
        // less than the penalty costs her.
        uint256 saved = cohortAtk > cohortCtrl ? vault.previewRedeem(cohortAtk - cohortCtrl) : 0;
        assertLt(saved, penalty / 5, "the dodge does not pay");
        assertGe(lenderAtk + 1e18, lenderCtrl, "lenders do not eat the loss");
    }

    /* ------------------------------------------------------------------ */
    /* L-01  No phantom Morpho loss after a zero-exposure window            */
    /* ------------------------------------------------------------------ */

    /// @dev The review's scenario: a third-party supplier funds the Surety Morpho market while the vault has no
    /// position, takes bad debt alone, then the allocator buys in at the post-loss price. The mark now moves with
    /// every checkpoint (and the shares it values are those held at the mark), so nothing is recorded.
    function test_L01_noPhantomMorphoLossAfterZeroExposure() public {
        musd.mint(carol, 10_000e18);
        vm.startPrank(carol);
        musd.approve(address(morpho), 10_000e18);
        morpho.supply(btcMarket, 10_000e18, 0, carol, "");
        vm.stopPrank();
        _borrowMorpho(morphoBorrower, 0.1e18, 4_000e18);
        _warp(1 days);
        pool.checkpoint(MORPHO_LINE);
        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower); // bad debt, borne by carol alone
        assertEq(pool.checkpoint(MORPHO_LINE), 0, "no shares, nothing recorded");
        (uint128 markAssets,,,) = pool.highWaterMark(MORPHO_LINE);
        assertEq(markAssets, morpho.market(btcMarketId).totalSupplyAssets, "the mark moved to the post-loss price");

        _deposit(lender, 10_000e18);
        uint256 aliceId = _lockPermanent(alice, 6e18);
        _warpEpochs(1);
        uint256 e1 = _currentEpoch();
        _voteAll(alice, aliceId, MORPHO_LINE);
        _post(sponsor, MORPHO_LINE, 1_000e18);
        _rebalance();
        assertGt(allocator.lineAssets(MORPHO_LINE), 9_000e18, "the allocator bought in");
        uint256 cohortBefore = _shares(MORPHO_LINE, e1);

        assertEq(pool.checkpoint(MORPHO_LINE), 0, "no phantom loss");
        vm.prank(keeper);
        assertEq(pool.cover(MORPHO_LINE), 0);
        assertEq(pool.lossRecorded(MORPHO_LINE), 0);
        assertEq(_shares(MORPHO_LINE, e1), cohortBefore, "voters not slashed");
    }

    /* ------------------------------------------------------------------ */
    /* Verified non-issue: donation/inflation on a 0.5 MUSD seed            */
    /* ------------------------------------------------------------------ */

    function test_NI_tinySeedDonationIsNotAnInflationAttack() public {
        // Mainnet launch: 0.5 MUSD seed, then an attacker donates 100,000 MUSD straight to the vault.
        _deposit(admin, 0.5e18);
        musd.mint(mallory, 100_000e18);
        vm.prank(mallory);
        musd.transfer(address(vault), 100_000e18);
        _warp(1 days);
        uint256 shares = _deposit(lender, 1_000e18);
        uint256 worth = vault.previewRedeem(shares);
        // VaultV2 recognises donations no faster than maxRate on _totalAssets (0.5 MUSD * 200%/yr): the share price
        // barely moves, so the victim loses nothing to rounding and the donation is simply given away.
        assertApproxEqRel(worth, 1_000e18, 1e12, "no rounding loss for the victim");
    }

    /* Helpers */

    function _shares(uint256 lineId, uint256 epoch) internal view returns (uint256 s) {
        (s,,) = pool.cohort(lineId, epoch);
    }
}
