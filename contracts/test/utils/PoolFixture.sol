// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaultV2} from "vault-v2/interfaces/IVaultV2.sol";

import {CreditVoter} from "../../src/CreditVoter.sol";
import {ICreditVoter} from "../../src/interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "../../src/interfaces/IEscrowRegistry.sol";
import {ISuretyPool} from "../../src/interfaces/ISuretyPool.sol";
import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";
import {IVoteAllocator} from "../../src/interfaces/IVoteAllocator.sol";
import {SuretyPool} from "../../src/SuretyPool.sol";
import {LineFixture} from "./LineFixture.sol";

/// @notice Stand-in for the VoteAllocator: records every `noteAdjustment` and forwards `distributeFees` as the
/// allocator would.
contract MockAllocator is IVoteAllocator {
    struct Adjustment {
        address caller;
        uint256 lineId;
        int256 delta;
    }

    Adjustment[] internal adjustments;
    mapping(uint256 lineId => int256) public netAdjustment;
    uint256 public activeTallyEpoch;

    function noteAdjustment(uint256 lineId, int256 delta) external {
        adjustments.push(Adjustment({caller: msg.sender, lineId: lineId, delta: delta}));
        netAdjustment[lineId] += delta;
    }

    function lineAssets(uint256) external pure returns (uint256) {
        return 0;
    }

    function distribute(ISuretyPool pool, uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest)
        external
    {
        pool.distributeFees(cohortEpoch, lineIds, interest);
    }

    function adjustmentCount() external view returns (uint256) {
        return adjustments.length;
    }

    function adjustment(uint256 i) external view returns (Adjustment memory) {
        return adjustments[i];
    }
}

/// @notice LineFixture plus a CreditVoter with two lines, a SuretyPool wired as the vault's performance-fee
/// recipient (10% fee), and a MockAllocator in the allocator seat.
/// @dev Lines: 0 = BTC/MUSD Morpho market through the shared MorphoMarketV1AdapterV2, 1 = the veBTC credit line.
/// `admin` stays the vault allocator so tests move capital directly. Locks created at START_TIME have no power in
/// the current epoch: tests warp at least one epoch before voting (the offset inside the epoch is kept, so votes
/// never land in an epoch's first second).
abstract contract PoolFixture is LineFixture {
    uint256 internal constant MORPHO_LINE = 0;
    uint256 internal constant VE_LINE = 1;
    uint256 internal constant SEASON = 4;

    CreditVoter internal voter;
    SuretyPool internal pool;
    MockAllocator internal allocator;

    address internal sponsor = makeAddr("sponsor");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal liquidator = makeAddr("liquidator");
    address internal morphoBorrower = makeAddr("morphoBorrower");

    function setUp() public virtual override {
        super.setUp();
        _deployPool();
    }

    function _deployPool() internal {
        voter = new CreditVoter(IVeBTC(address(ve)), EPOCH_LENGTH, admin);
        allocator = new MockAllocator();
        pool = new SuretyPool(
            address(vault),
            voter,
            IERC20(address(musd)),
            morpho,
            address(morphoAdapter),
            IEscrowRegistry(address(line)),
            admin,
            SEASON
        );
        vm.label(address(voter), "CreditVoter");
        vm.label(address(pool), "SuretyPool");
        vm.label(address(allocator), "MockAllocator");

        vm.startPrank(admin);
        voter.addLine(address(morphoAdapter), abi.encode(btcMarket), ICreditVoter.LineKind.Morpho, "BTC / Morpho");
        voter.addLine(address(line), "", ICreditVoter.LineKind.VeBTC, "veBTC credit");
        voter.setEscrowRegistry(IEscrowRegistry(address(line)));
        line.setSuretyPool(address(pool));
        pool.setAllocator(address(allocator));
        vm.stopPrank();

        _curate(abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(pool))));
        _curate(abi.encodeCall(IVaultV2.setPerformanceFee, (VOTER_FEE)));
    }

    /* Actors */

    /// @notice Mints `assets` MUSD to `who` and posts them as an incentive for `lineId` in the current epoch.
    function _post(address who, uint256 lineId, uint256 assets) internal returns (uint256 shares) {
        musd.mint(who, assets);
        vm.startPrank(who);
        musd.approve(address(pool), assets);
        shares = pool.postIncentive(lineId, assets);
        vm.stopPrank();
    }

    function _vote(address who, uint256 tokenId, uint256[] memory lineIds, uint256[] memory weights) internal {
        vm.prank(who);
        voter.vote(tokenId, lineIds, weights);
    }

    function _voteAll(address who, uint256 tokenId, uint256 lineId) internal {
        _vote(who, tokenId, _arr(lineId), _arr(BPS));
    }

    function _distribute(uint256 cohortEpoch, uint256[] memory lineIds, uint256[] memory interest) internal {
        allocator.distribute(pool, cohortEpoch, lineIds, interest);
    }

    /// @notice Mints `amount` vault shares' worth of fees: earns interest on a Morpho borrow for `secs`.
    /// @dev Deposits 100k, allocates 50k to the Morpho line and borrows 40k against 1 BTC before warping.
    function _earnMorphoInterest(uint256 secs) internal {
        _deposit(lender, 100_000e18);
        _allocateMorpho(50_000e18);
        _borrowMorpho(morphoBorrower, 1e18, 40_000e18);
        _warp(secs);
        vault.accrueInterest();
    }

    /// @notice Shares the pool holds but has not attributed yet (fee shares since the last distribution).
    function _pendingFeeShares() internal view returns (uint256) {
        return vault.balanceOf(address(pool)) - pool.accountedShares();
    }

    function _cohortShares(uint256 lineId, uint256 epoch) internal view returns (uint256 shares) {
        (shares,,) = pool.cohort(lineId, epoch);
    }

    /* Arrays */

    function _arr(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function _arr(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _arr(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory r) {
        r = new uint256[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }
}
