// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {ICreditVoter} from "./interfaces/ICreditVoter.sol";
import {IEscrowRegistry} from "./interfaces/IEscrowRegistry.sol";
import {IVeBTC} from "./interfaces/IVeBTC.sol";
import {EpochLib} from "./libraries/EpochLib.sol";

/// @title CreditVoter
/// @notice Lending gauges: each epoch, veBTC holders split their NFT's power across Surety credit lines, and the
/// VoteAllocator sizes each line's share of the vault from these tallies.
/// @dev
/// - An NFT's power for an epoch is its boosted veBTC power at the epoch start. One tokenId carries one snapshot per
///   epoch: a second ballot from the same tokenId replaces the first, a lock created or merged into after the start
///   adds nothing until the next epoch, and a transferred NFT's new owner can only replace its ballot.
/// - Ballots are not accepted during the first second of an epoch (`block.timestamp == currentEpoch()`): a veBTC
///   checkpoint written in that block still moves the snapshot, so a ballot cast then could be followed by a merge
///   that counts the same BTC twice. From the next second on, the snapshot is final.
/// - Ballots persist. `poke` recasts a stored ballot into a later epoch at that epoch's snapshot.
/// - Tallies are keyed by epoch start. Only the current epoch is ever written, so past epochs are final.
/// - Line ids are 0-based registry indexes. Lines are never removed, only deactivated.
contract CreditVoter is ICreditVoter, Ownable2Step {
    struct Ballot {
        uint256[] lineIds;
        uint256[] weightsBps;
        uint256 epochCast;
    }

    /// @notice Ballot weights are in basis points and must sum to this.
    uint256 public constant BPS = 10_000;
    /// @notice Maximum number of lines in one ballot.
    uint256 public constant MAX_LINES_PER_BALLOT = 10;

    /// @notice Mezo's veBTC VotingEscrow, the source of voting power.
    IVeBTC public immutable veBTC;
    /// @notice Epoch length in seconds; epoch ids are their start timestamps.
    uint256 public immutable EPOCH_LENGTH;

    /// @notice Loan escrows whose NFTs may not vote. Unset means no check; once set it cannot change.
    IEscrowRegistry public escrowRegistry;

    /// @inheritdoc ICreditVoter
    mapping(uint256 epoch => mapping(uint256 lineId => uint256)) public lineVotes;
    /// @inheritdoc ICreditVoter
    mapping(uint256 epoch => uint256) public totalVotes;
    /// @inheritdoc ICreditVoter
    mapping(uint256 epoch => mapping(uint256 tokenId => mapping(uint256 lineId => uint256))) public tokenVotes;

    Line[] internal lines;
    /// @dev keccak256(adapter, data) of every listed line, so one market cannot be listed twice.
    mapping(bytes32 lineKey => bool) internal listed;
    /// @dev Latest ballot per NFT. When `epochCast` is the current epoch, its lines are exactly the lines holding
    /// the NFT's tallies for that epoch, which is what a replacement ballot subtracts.
    mapping(uint256 tokenId => Ballot) internal ballots;

    event LineAdded(uint256 indexed lineId, address indexed adapter, LineKind kind, string name);
    event LineActiveSet(uint256 indexed lineId, bool active);
    event EscrowRegistrySet(address indexed registry);
    event Voted(
        uint256 indexed epoch,
        uint256 indexed tokenId,
        address indexed voter,
        uint256 power,
        uint256[] lineIds,
        uint256[] weightsBps
    );
    event Poked(uint256 indexed epoch, uint256 indexed tokenId, uint256 power);

    error ZeroAddress();
    error ZeroEpochLength();
    error EscrowRegistryAlreadySet();
    error LineExists();
    error UnknownLine();
    error InactiveLine();
    error NotApprovedOrOwner();
    error EscrowOwnedNFT();
    error SnapshotNotFinal();
    error LengthMismatch();
    error TooManyLines();
    error DuplicateLine();
    error BadWeights();
    error NoPower();
    error NothingToPoke();

    /// @param veBTC_ Mezo's veBTC VotingEscrow.
    /// @param epochLength Epoch length in seconds (1 week on mainnet, aligned with Mezo's Thursday flip).
    /// @param owner_ Account allowed to list lines and set the escrow registry.
    constructor(IVeBTC veBTC_, uint256 epochLength, address owner_) Ownable(owner_) {
        if (address(veBTC_) == address(0)) revert ZeroAddress();
        if (epochLength == 0) revert ZeroEpochLength();
        veBTC = veBTC_;
        EPOCH_LENGTH = epochLength;
    }

    /* Admin */

    /// @notice Sets the registry of loan escrows whose NFTs are barred from voting. Callable once.
    /// @param registry The veBTC credit line (or any IEscrowRegistry).
    function setEscrowRegistry(IEscrowRegistry registry) external onlyOwner {
        if (address(registry) == address(0)) revert ZeroAddress();
        if (address(escrowRegistry) != address(0)) revert EscrowRegistryAlreadySet();
        escrowRegistry = registry;
        emit EscrowRegistrySet(address(registry));
    }

    /// @notice Lists a credit line. It starts active.
    /// @param adapter VaultV2 adapter holding the line's allocation.
    /// @param data Adapter data for VaultV2 allocate/deallocate; (adapter, data) must be new.
    /// @param kind Morpho market or veBTC credit line.
    /// @param name Display name.
    /// @return lineId Index of the new line.
    function addLine(address adapter, bytes calldata data, LineKind kind, string calldata name)
        external
        onlyOwner
        returns (uint256 lineId)
    {
        if (adapter == address(0)) revert ZeroAddress();
        bytes32 key = keccak256(abi.encode(adapter, data));
        if (listed[key]) revert LineExists();
        listed[key] = true;

        lineId = lines.length;
        lines.push(Line({adapter: adapter, data: data, kind: kind, active: true, name: name}));
        emit LineAdded(lineId, adapter, kind, name);
    }

    /// @notice Opens or closes a line to new ballots and pokes. Tallies already cast stay as they are.
    function setLineActive(uint256 lineId, bool active) external onlyOwner {
        if (lineId >= lines.length) revert UnknownLine();
        lines[lineId].active = active;
        emit LineActiveSet(lineId, active);
    }

    /* Voting */

    /// @notice Casts `tokenId`'s power for the current epoch, replacing any ballot it cast earlier in this epoch.
    /// @dev Caller must own or be approved for the NFT, which must not sit in a loan escrow.
    /// @param tokenId veBTC NFT.
    /// @param lineIds Up to 10 distinct active lines.
    /// @param weightsBps Share of the NFT's power for each line, each non-zero, summing to 10_000.
    function vote(uint256 tokenId, uint256[] calldata lineIds, uint256[] calldata weightsBps) external {
        uint256 epoch = _openEpoch();
        if (!veBTC.isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        _requireNotEscrowed(veBTC.ownerOf(tokenId));
        _validate(lineIds, weightsBps);
        uint256 power = _power(tokenId, epoch);

        _cast(epoch, tokenId, lineIds, weightsBps, power);
        emit Voted(epoch, tokenId, msg.sender, power, lineIds, weightsBps);
    }

    /// @notice Recasts `tokenId`'s stored ballot into the current epoch at the current snapshot. Permissionless.
    /// @dev Lines deactivated since the ballot was cast are dropped and the remaining weights rescaled to 10_000
    /// (rounding remainder to the last line); the rescaled ballot replaces the stored one. Reverts `NothingToPoke`
    /// when the ballot is already in this epoch, there is none, or none of its lines is active (the stored ballot is
    /// then kept as is, and becomes pokeable again if a line is reactivated).
    /// @param tokenId veBTC NFT.
    function poke(uint256 tokenId) external {
        uint256 epoch = _openEpoch();
        Ballot storage ballot = ballots[tokenId];
        uint256 n = ballot.lineIds.length;
        if (n == 0 || ballot.epochCast >= epoch) revert NothingToPoke();

        address holder = veBTC.ownerOf(tokenId);
        if (holder == address(0)) revert NoPower(); // burned, e.g. merged into another NFT
        _requireNotEscrowed(holder);

        uint256 kept = 0;
        for (uint256 i; i < n; ++i) {
            if (lines[ballot.lineIds[i]].active) ++kept;
        }
        if (kept == 0) revert NothingToPoke();

        uint256[] memory lineIds = new uint256[](kept);
        uint256[] memory weightsBps = new uint256[](kept);
        uint256 sum = 0;
        uint256 j = 0;
        for (uint256 i; i < n; ++i) {
            uint256 lineId = ballot.lineIds[i];
            if (!lines[lineId].active) continue;
            lineIds[j] = lineId;
            weightsBps[j] = ballot.weightsBps[i];
            sum += weightsBps[j];
            ++j;
        }
        // Identity when no line was dropped (sum == BPS).
        uint256 assigned = 0;
        for (uint256 i; i < kept - 1; ++i) {
            weightsBps[i] = weightsBps[i] * BPS / sum;
            assigned += weightsBps[i];
        }
        weightsBps[kept - 1] = BPS - assigned;

        uint256 power = _power(tokenId, epoch);
        _cast(epoch, tokenId, lineIds, weightsBps, power);
        emit Poked(epoch, tokenId, power);
    }

    /* Views */

    /// @inheritdoc ICreditVoter
    function currentEpoch() public view returns (uint256) {
        return EpochLib.start(block.timestamp, EPOCH_LENGTH);
    }

    /// @inheritdoc ICreditVoter
    function lineCount() external view returns (uint256) {
        return lines.length;
    }

    /// @inheritdoc ICreditVoter
    /// @dev Reverts `UnknownLine` for ids at or past `lineCount()`.
    function line(uint256 lineId) external view returns (Line memory) {
        if (lineId >= lines.length) revert UnknownLine();
        return lines[lineId];
    }

    /// @notice Latest ballot of `tokenId` and the epoch it was cast into (zeros if it never voted).
    function ballotOf(uint256 tokenId)
        external
        view
        returns (uint256[] memory lineIds, uint256[] memory weightsBps, uint256 epochCast)
    {
        Ballot storage ballot = ballots[tokenId];
        return (ballot.lineIds, ballot.weightsBps, ballot.epochCast);
    }

    /* Internals */

    /// @dev Current epoch, once its veBTC snapshot can no longer change.
    function _openEpoch() internal view returns (uint256 epoch) {
        epoch = currentEpoch();
        if (block.timestamp == epoch) revert SnapshotNotFinal();
    }

    function _requireNotEscrowed(address holder) internal view {
        IEscrowRegistry registry = escrowRegistry;
        if (address(registry) != address(0) && registry.isEscrow(holder)) revert EscrowOwnedNFT();
    }

    function _power(uint256 tokenId, uint256 epoch) internal view returns (uint256 power) {
        power = veBTC.votingPowerOfNFTAt(tokenId, epoch);
        if (power == 0) revert NoPower();
    }

    /// @dev Reverts on the first bad entry; bounded by MAX_LINES_PER_BALLOT.
    // forge-lint: disable-next-item(require-revert-in-loop)
    function _validate(uint256[] calldata lineIds, uint256[] calldata weightsBps) internal view {
        uint256 n = lineIds.length;
        if (n != weightsBps.length) revert LengthMismatch();
        if (n > MAX_LINES_PER_BALLOT) revert TooManyLines();

        uint256 sum = 0;
        for (uint256 i; i < n; ++i) {
            uint256 lineId = lineIds[i];
            if (lineId >= lines.length) revert UnknownLine();
            if (!lines[lineId].active) revert InactiveLine();
            for (uint256 k; k < i; ++k) {
                if (lineIds[k] == lineId) revert DuplicateLine();
            }
            uint256 weight = weightsBps[i];
            if (weight == 0 || weight > BPS) revert BadWeights();
            sum += weight;
        }
        if (sum != BPS) revert BadWeights();
    }

    /// @dev Removes `tokenId`'s tallies for `epoch` if it already voted in it, then splits `power` across `lineIds`
    /// by weight with the rounding remainder on the last line, so the token's tallies sum to exactly `power`.
    function _cast(uint256 epoch, uint256 tokenId, uint256[] memory lineIds, uint256[] memory weightsBps, uint256 power)
        internal
    {
        Ballot storage ballot = ballots[tokenId];
        if (ballot.epochCast == epoch) {
            uint256[] storage previous = ballot.lineIds;
            uint256 removed = 0;
            for (uint256 i; i < previous.length; ++i) {
                uint256 lineId = previous[i];
                uint256 votes = tokenVotes[epoch][tokenId][lineId];
                lineVotes[epoch][lineId] -= votes;
                removed += votes;
                delete tokenVotes[epoch][tokenId][lineId];
            }
            totalVotes[epoch] -= removed;
        }

        uint256 n = lineIds.length;
        uint256 allotted = 0;
        for (uint256 i; i < n; ++i) {
            uint256 lineId = lineIds[i];
            uint256 votes = i == n - 1 ? power - allotted : power * weightsBps[i] / BPS;
            allotted += votes;
            tokenVotes[epoch][tokenId][lineId] = votes;
            lineVotes[epoch][lineId] += votes;
        }
        totalVotes[epoch] += power;

        ballot.lineIds = lineIds;
        ballot.weightsBps = weightsBps;
        ballot.epochCast = epoch;
    }
}
