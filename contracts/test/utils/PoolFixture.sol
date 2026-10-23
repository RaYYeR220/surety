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

/// @notice Stand-in for the VoteAllocator: forwards `distributeFees` as the allocator would.
contract MockAllocator is IVoteAllocator {
    uint256 public activeTallyEpoch;

    function lineAssets(uint256) external pure returns (uint256) {
        return 0;
    }

    function distribute(ISuretyPool pool, uint256 cohortEpoch, uint256[] calldata lineIds, uint256[] calldata interest)
        external
    {
        pool.distributeFees(cohortEpoch, lineIds, interest);
    }
}

/// @notice Unit fixture: LineFixture plus a CreditVoter with two lines, a SuretyPool wired as the vault's
/// performance-fee recipient (10% fee), and a MockAllocator in the allocator seat.
/// @dev Lines: 0 = BTC/MUSD Morpho market through the shared MorphoMarketV1AdapterV2, 1 = the veBTC credit line.
/// `admin` stays the vault allocator so tests move capital directly. Locks created at START_TIME have no power in
/// the current epoch: tests warp at least one epoch before voting (the offset inside the epoch is kept, so votes
/// never land in an epoch's first second).
abstract contract PoolFixture is LineFixture {
    MockAllocator internal mockAllocator;

    function setUp() public virtual override {
        super.setUp();
        _deployPool();
    }

    function _deployPool() internal {
        voter = new CreditVoter(
            IVeBTC(address(ve)), EPOCH_LENGTH, admin, IVaultV2(address(vault)), address(morphoAdapter), LINE_TIMELOCK
        );
        mockAllocator = new MockAllocator();
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
        vm.label(address(mockAllocator), "MockAllocator");

        vm.startPrank(admin);
        voter.addLine(address(morphoAdapter), abi.encode(btcMarket), ICreditVoter.LineKind.Morpho, "BTC / Morpho");
        voter.addLine(address(line), "", ICreditVoter.LineKind.VeBTC, "veBTC credit");
        voter.setEscrowRegistry(IEscrowRegistry(address(line)));
        line.setSuretyPool(address(pool));
        pool.setAllocator(address(mockAllocator));
        vm.stopPrank();

        _curate(abi.encodeCall(IVaultV2.setPerformanceFeeRecipient, (address(pool))));
        _curate(abi.encodeCall(IVaultV2.setPerformanceFee, (VOTER_FEE)));
    }

    function _distribute(uint256 cohortEpoch, uint256[] memory lineIds, uint256[] memory interest) internal {
        mockAllocator.distribute(pool, cohortEpoch, lineIds, interest);
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
}
