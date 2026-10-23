// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {MAX_MAX_RATE} from "vault-v2/libraries/ConstantsLib.sol";

import {SuretyPool} from "../../src/SuretyPool.sol";
import {VoteAllocator} from "../../src/VoteAllocator.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {LineIds} from "../../src/libraries/LineIds.sol";
import {SuretyFixture} from "../utils/SuretyFixture.sol";

/// @notice The whole system end to end on the integrated fixture: lenders, veBTC voters, a sponsor, a Morpho BTC
/// borrower, a veBTC borrower and a keeper, through weekly epochs.
/// @dev Shared setup (`_openBook`): E0 lenders deposit 10,000 MUSD (9,000 + 1,000) and alice / bob lock 6 / 4 BTC
/// permanently; E1 both vote 70/30 for the BTC Morpho line / veBTC line and a sponsor posts 100 MUSD for the veBTC
/// line; flip to E2 and rebalance (9,090 MUSD deployable: ~6,363 to Morpho, ~2,727 to the veBTC line); a BTC
/// borrower borrows 4,000 MUSD on Morpho against 0.1 BTC and a veBTC borrower 2,000 MUSD against a 0.05 BTC lock.
/// Every flip is a keeper run: warp one epoch, rebalance, poke both ballots into the new epoch.
contract LifecycleTest is SuretyFixture {
    uint256 internal constant LENDER_DEPOSIT = 9_000e18;
    uint256 internal constant CAROL_DEPOSIT = 1_000e18;
    uint256 internal constant INCENTIVE = 100e18;
    uint256 internal constant MORPHO_BORROW = 4_000e18;
    uint256 internal constant VE_BORROW = 2_000e18;

    uint256 internal aliceId;
    uint256 internal bobId;
    uint256 internal loanId;
    uint256 internal e1;
    /// @dev Whether `_flip` pokes the ballots into the new epoch.
    bool internal poking = true;

    /* Wiring */

    function test_wiring_matchesProduction() public view {
        assertTrue(vault.isAllocator(address(allocator)));
        assertFalse(vault.isAllocator(admin), "the allocator is the only allocator");
        assertEq(vault.liquidityAdapter(), address(0));
        assertEq(vault.performanceFeeRecipient(), address(pool));
        assertEq(vault.performanceFee(), VOTER_FEE);
        assertEq(vault.maxRate(), MAX_MAX_RATE);
        assertEq(vault.forceDeallocatePenalty(address(morphoAdapter)), FORCE_DEALLOCATE_PENALTY);
        assertEq(vault.forceDeallocatePenalty(address(line)), FORCE_DEALLOCATE_PENALTY);
        assertTrue(vault.isAdapter(address(morphoAdapter)));
        assertTrue(vault.isAdapter(address(line)));
        assertEq(vault.absoluteCap(LineIds.adapterId(address(line))), LINE_CAP);
        assertEq(vault.absoluteCap(LineIds.collateralId(address(ve))), LINE_CAP);

        assertEq(voter.lineCount(), 2);
        ICreditVoter.Line memory m = voter.line(MORPHO_LINE);
        assertEq(m.adapter, address(morphoAdapter));
        assertEq(keccak256(m.data), keccak256(abi.encode(btcMarket)));
        assertEq(uint8(m.kind), uint8(ICreditVoter.LineKind.Morpho));
        ICreditVoter.Line memory v = voter.line(VE_LINE);
        assertEq(v.adapter, address(line));
        assertEq(v.data.length, 0);
        assertEq(uint8(v.kind), uint8(ICreditVoter.LineKind.VeBTC));
        assertEq(address(voter.escrowRegistry()), address(line));
        assertEq(address(voter.veBTC()), address(ve));

        assertEq(allocator.suretyPool(), address(pool));
        assertEq(allocator.idleBufferBps(), IDLE_BUFFER_BPS);
        assertEq(pool.allocator(), address(allocator));
        assertEq(line.suretyPool(), address(pool));
        assertEq(address(pool.escrows()), address(line));
        assertEq(pool.SEASON(), SEASON);
        (,, bool markSet,) = pool.highWaterMark(MORPHO_LINE);
        assertTrue(markSet, "the Morpho line was checkpointed when listed");
    }

    /* Happy path */

    function test_fullCycle_happyPath() public {
        _openBook();
        assertEq(vault.balanceOf(address(pool)) - pool.accountedShares(), 0);

        // A month of weekly flips. The loan's lock is extended on the way so it never reaches maturity.
        _flip(); // E3: E2's interest -> cohort E1
        _flip(); // E4: E3's interest -> cohort E2
        vm.prank(borrower);
        line.extend(loanId, 28 days);
        _flip(); // E5
        _flip(); // E6
        assertGt(line.debtOf(loanId), VE_BORROW, "veBTC loan accrued interest");
        uint256 cohortVe1 = _cohort(VE_LINE, e1);
        uint256 cohortMorpho1 = _cohort(MORPHO_LINE, e1);
        assertGt(cohortVe1, vault.previewDeposit(INCENTIVE), "incentive plus fee shares");
        assertGt(cohortMorpho1, 0, "fee shares attributed by interest");

        // Borrowers repay in full; the veBTC NFT comes back to its owner.
        _repayMorphoAll(morphoBorrower);
        _repay(borrower, loanId, type(uint256).max);
        assertEq(ve.ownerOf(line.loan(loanId).tokenId), borrower);

        // The small lender exits from the idle buffer with interest.
        uint256 carolOut = _redeemAll(carol);
        assertGt(carolOut, CAROL_DEPOSIT, "lender earned interest");

        // E7: the E1 cohorts mature; anyone triggers the claims, the voters are paid pro rata to their votes.
        _flip();
        assertEq(_currentEpoch(), pool.maturityOf(e1));
        uint256 aliceShares = _claimBoth(aliceId, e1);
        uint256 bobShares = _claimBoth(bobId, e1);
        assertApproxEqAbs(aliceShares, (cohortVe1 + cohortMorpho1) * 6 / 10, 2);
        assertApproxEqAbs(bobShares, (cohortVe1 + cohortMorpho1) * 4 / 10, 2);
        assertEq(vault.balanceOf(alice), aliceShares);
        assertLe(_cohort(VE_LINE, e1) + _cohort(MORPHO_LINE, e1), 2, "cohorts paid out");

        // E8: the E2 cohorts mature. The voters stop poking, so from E9 nothing is voted and capital returns.
        poking = false;
        _flip();
        aliceShares += _claimBoth(aliceId, e1 + EPOCH_LENGTH);
        bobShares += _claimBoth(bobId, e1 + EPOCH_LENGTH);
        _flip();
        assertEq(allocator.lineAssets(MORPHO_LINE), 0);
        assertEq(allocator.lineAssets(VE_LINE), 0);

        // The lender withdraws everything with profit; voters cash their rewards; the sponsor funded them.
        uint256 lenderOut = _redeemAll(lender);
        assertGt(lenderOut, LENDER_DEPOSIT, "lender earned interest");
        assertGt(_redeemAll(alice), INCENTIVE * 6 / 10, "alice: her part of the incentive plus fees");
        assertGt(_redeemAll(bob), INCENTIVE * 4 / 10, "bob: his part of the incentive plus fees");
        assertEq(vault.balanceOf(sponsor), 0);

        // Everything left in the vault is the pool's (later cohorts and the reserve) and is fully backed by idle MUSD.
        assertEq(vault.totalSupply(), vault.balanceOf(address(pool)));
        assertLe(pool.accountedShares(), vault.balanceOf(address(pool)));
        assertApproxEqAbs(vault.totalAssets(), musd.balanceOf(address(vault)), 2);
        assertEq(pool.lossRecorded(MORPHO_LINE) + pool.lossRecorded(VE_LINE), 0);
    }

    /* Negative path */

    /// @dev Both lines take bad debt in E4. Losses are checkpointed and covered: each line's own unmatured cohorts
    /// pay first, then the shared reserve, and lenders bear only what is left. Covers never exceed recorded losses.
    function test_fullCycle_negativePath() public {
        _openBook();
        _flip(); // E3
        _flip(); // E4
        uint256 morphoCohorts = _unmatured(MORPHO_LINE);
        uint256 veCohorts = _unmatured(VE_LINE);
        assertGt(veCohorts, vault.previewDeposit(INCENTIVE));
        uint256 lenderPreShock = _value(lender) + _value(carol);
        uint256 debtAtE4 = line.debtOf(loanId);

        // BTC drops 60%. Morpho liquidates its borrower and socialises the rest; the veBTC loan is auctioned and sold
        // at the floor, below its debt.
        _shock(6000);
        _liquidateMorpho(liquidator, morphoBorrower);
        line.startAuction(loanId);
        _warp(AUCTION_DURATION);
        _shock(6000);
        uint256 debt = line.debtOf(loanId);
        uint256 price = _bid(bidder, loanId);
        assertEq(price, line.params().floorBps * _shockedValue(0.05e18) / BPS, "sold at the floor");
        assertLt(price, debt);
        assertEq(ve.ownerOf(line.loan(loanId).tokenId), bidder);

        // The keeper records both losses.
        vm.startPrank(keeper);
        uint256 lossMorpho = pool.checkpoint(MORPHO_LINE);
        uint256 lossVe = pool.checkpoint(VE_LINE);
        vm.stopPrank();
        assertGt(lossMorpho, 500e18);
        assertEq(lossVe, debt - price);
        assertEq(line.badDebtTotal(), lossVe);

        // Cover the veBTC line: its cohorts first, then the reserve, then nothing is left for the Morpho line.
        uint256 reserve = pool.reserveShares();
        CoverResult memory ve_ = _cover(VE_LINE);
        assertEq(ve_.fromCohorts, veCohorts, "veBTC cohorts slashed first, in full");
        assertEq(ve_.fromReserve, reserve, "then the reserve");
        assertEq(_unmatured(VE_LINE), 0);
        assertEq(_unmatured(MORPHO_LINE), morphoCohorts, "the other line's cohorts are untouched");
        assertEq(pool.reserveShares(), 0);
        assertLt(ve_.covered, lossVe, "the pool is smaller than the loss");
        assertEq(line.cash(), ve_.lineCashBefore + ve_.assets, "cover paid into the line");
        assertLt(ve_.covered, ve_.assets, "the fee VaultV2 takes on the returned MUSD is not cover");

        CoverResult memory mo = _cover(MORPHO_LINE);
        assertEq(mo.fromCohorts, morphoCohorts, "Morpho cohorts slashed");
        assertEq(mo.fromReserve, 0, "reserve already used");
        assertEq(_unmatured(MORPHO_LINE), 0);

        // Covers never exceed recorded losses; lenders bear the rest. Repeats pay nothing more.
        for (uint256 lineId; lineId < 2; ++lineId) {
            assertLe(pool.lossCovered(lineId), pool.lossRecorded(lineId));
            assertGt(pool.uncoveredLoss(lineId), 0, "third loss: lenders");
            assertEq(pool.cover(lineId), 0);
        }
        uint256 covered = ve_.covered + mo.covered;
        uint256 uncovered = lossMorpho + lossVe - covered;

        // VaultV2 re-recognises the covered MUSD under its max rate (taking the voters' 10% fee on it); after that,
        // lenders are down by at most the uncovered loss.
        _warp(7 days);
        vault.accrueInterest();
        uint256 lenderAfter = _value(lender) + _value(carol);
        assertLt(lenderAfter, lenderPreShock);
        assertGe(lenderAfter + uncovered, lenderPreShock, "lenders bear at most the uncovered loss");

        // The next rebalance attributes no part of the losses or covers as interest.
        vm.recordLogs();
        _flip();
        uint256[] memory interest = _attributed();
        assertLe(interest[MORPHO_LINE], 2, "Morpho loss is not interest");
        assertApproxEqAbs(interest[VE_LINE], debt - debtAtE4, 2, "only the interest the loan accrued");
    }

    /* Scenario */

    function _openBook() internal {
        _deposit(lender, LENDER_DEPOSIT);
        _deposit(carol, CAROL_DEPOSIT);
        aliceId = _lockPermanent(alice, 6e18);
        bobId = _lockPermanent(bob, 4e18);

        _warpEpochs(1);
        e1 = _currentEpoch();
        _vote(alice, aliceId, _arr(MORPHO_LINE, VE_LINE), _arr(7000, 3000));
        _vote(bob, bobId, _arr(MORPHO_LINE, VE_LINE), _arr(7000, 3000));
        assertEq(voter.lineVotes(e1, MORPHO_LINE), 7e18);
        assertEq(voter.lineVotes(e1, VE_LINE), 3e18);
        _post(sponsor, VE_LINE, INCENTIVE);

        _flip(); // E2: allocation follows E1's tally
        assertEq(allocator.activeTallyEpoch(), e1);
        uint256 deployable = (LENDER_DEPOSIT + CAROL_DEPOSIT + INCENTIVE) * (BPS - IDLE_BUFFER_BPS) / BPS;
        assertApproxEqAbs(allocator.lineAssets(MORPHO_LINE), deployable * 7 / 10, 2);
        assertApproxEqAbs(allocator.lineAssets(VE_LINE), deployable * 3 / 10, 2);

        _borrowMorpho(morphoBorrower, 0.1e18, MORPHO_BORROW);
        uint256 tokenId;
        (loanId, tokenId) = _openTimed(borrower, 0.05e18, VE_BORROW);
        assertEq(ve.ownerOf(tokenId), line.loan(loanId).escrow);
        assertEq(musd.balanceOf(borrower), VE_BORROW);
    }

    /// @dev One keeper run at the flip: warp an epoch, rebalance, then carry the ballots into the new epoch.
    function _flip() internal {
        _warpEpochs(1);
        _rebalance();
        if (!poking) return;
        vm.startPrank(keeper);
        voter.poke(aliceId);
        voter.poke(bobId);
        vm.stopPrank();
    }

    struct CoverResult {
        uint256 covered;
        uint256 assets;
        uint256 fromCohorts;
        uint256 fromReserve;
        uint256 burned;
        uint256 lineCashBefore;
    }

    /// @dev Covers `lineId` as the keeper and checks the shares burned equal what the moved MUSD withdraws.
    function _cover(uint256 lineId) internal returns (CoverResult memory r) {
        r.lineCashBefore = line.cash();
        uint256 poolShares = vault.balanceOf(address(pool));
        vm.recordLogs();
        vm.prank(keeper);
        r.covered = pool.cover(lineId);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(pool) || logs[i].topics[0] != SuretyPool.Covered.selector) continue;
            uint256 units;
            (units, r.assets, r.fromCohorts, r.fromReserve) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            assertEq(units, r.covered);
        }
        r.burned = poolShares - vault.balanceOf(address(pool));
        assertEq(r.burned, r.fromCohorts + r.fromReserve, "cohorts and reserve slashed by exactly the burn");
        assertGt(r.covered, 0);
    }

    /* Reads */

    function _cohort(uint256 lineId, uint256 epoch) internal view returns (uint256 shares) {
        (shares,,) = pool.cohort(lineId, epoch);
    }

    /// @dev Shares held by the line's backed, unmatured cohorts (the ones a cover can slash).
    function _unmatured(uint256 lineId) internal view returns (uint256 total) {
        for (uint256 epoch = e1; epoch <= _currentEpoch(); epoch += EPOCH_LENGTH) {
            if (vm.getBlockTimestamp() >= pool.maturityOf(epoch) || voter.lineVotes(epoch, lineId) == 0) continue;
            total += _cohort(lineId, epoch);
        }
    }

    function _value(address who) internal view returns (uint256) {
        return vault.previewRedeem(vault.balanceOf(who));
    }

    function _shockedValue(uint256 btcAmount) internal view returns (uint256) {
        return btcAmount * stressedSource.priceWad() / 1e18;
    }

    /// @dev The interest array of the allocator's InterestAttributed event in the recorded logs.
    function _attributed() internal view returns (uint256[] memory interest) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(allocator)) continue;
            if (logs[i].topics[0] != VoteAllocator.InterestAttributed.selector) continue;
            (, interest) = abi.decode(logs[i].data, (uint256[], uint256[]));
            return interest;
        }
        revert("no attribution");
    }

    /* Actions */

    function _claimBoth(uint256 tokenId, uint256 epoch) internal returns (uint256 shares) {
        vm.startPrank(keeper);
        shares = pool.claim(tokenId, MORPHO_LINE, epoch) + pool.claim(tokenId, VE_LINE, epoch);
        vm.stopPrank();
    }

    function _redeemAll(address who) internal returns (uint256 assets) {
        uint256 shares = vault.balanceOf(who);
        vm.prank(who);
        assets = vault.redeem(shares, who, who);
        assertEq(musd.balanceOf(who), assets);
    }

    function _repayMorphoAll(address user) internal {
        morpho.accrueInterest(btcMarket);
        uint256 shares = morpho.position(btcMarketId, user).borrowShares;
        uint256 budget = morpho.market(btcMarketId).totalBorrowAssets + 1e18;
        musd.mint(user, budget);
        vm.startPrank(user);
        musd.approve(address(morpho), budget);
        morpho.repay(btcMarket, 0, shares, user, "");
        vm.stopPrank();
    }
}
