// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IVeBTC} from "../../src/interfaces/IVeBTC.sol";

/// @notice veBTC VotingEscrow model with the semantics Surety depends on (Velodrome v2 rules, as on Mezo):
/// - ERC-721 ownership and approvals; `ownerOf` returns zero for burned or unminted ids instead of reverting.
/// - LOCKED NFTs cannot move; a transfer records `ownershipChange = block.number` and current voting power
///   reads 0 for the rest of that block (flash-NFT protection). Transfers are allowed while voted.
/// - Unlock times round down to whole weeks and may be at most MAXTIME (28 days) away.
/// - Voting power at `t` comes from the last checkpoint at or before `t`:
///   timed `amount * (end - t) / MAXTIME`, permanent `amount`, times `boost / 1e18` (0 means 1x).
/// Test-only helpers: `setVoter`, `setEscrowType`, `setGrantManager`, `setBoost`.
contract MockVeBTC is IVeBTC {
    using SafeERC20 for IERC20;

    uint256 public constant WEEK = 1 weeks;
    uint256 public constant MAXTIME = 28 days;
    uint256 public constant BOOST_PRECISION = 1e18;

    struct Point {
        uint256 ts;
        int128 amount;
        uint256 end;
        bool permanent;
        uint256 boost;
    }

    string public constant name = "veBTC";
    string public constant symbol = "veBTC";

    address public immutable token;
    /// @notice Voter allowed to flag NFTs as voted.
    address public voter;
    uint256 public lastTokenId;

    mapping(uint256 tokenId => EscrowType) public escrowType;
    mapping(uint256 tokenId => address) public grantManager;
    mapping(uint256 tokenId => bool) public voted;
    mapping(uint256 tokenId => uint256) public ownershipChange;

    mapping(uint256 tokenId => address) internal owners;
    mapping(address owner => uint256) internal balances;
    mapping(uint256 tokenId => address) internal approvals;
    mapping(address owner => mapping(address operator => bool)) internal operators;
    mapping(uint256 tokenId => LockedBalance) internal locks;
    mapping(uint256 tokenId => Point[]) internal history;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    error NotApprovedOrOwner();
    error NotOwner();
    error NotVoter();
    error ZeroAddress();
    error SameAddress();
    error SameNFT();
    error NotManagedOrNormalNFT();
    error NotNormalNFT();
    error ZeroAmount();
    error NoLockFound();
    error LockExpired();
    error LockNotExpired();
    error LockDurationNotInFuture();
    error LockDurationTooLong();
    error PermanentLock();
    error AlreadyVoted();

    constructor(address token_) {
        token = token_;
    }

    /* ERC-721 */

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        return owners[tokenId];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return approvals[tokenId];
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return operators[owner][operator];
    }

    function isApprovedOrOwner(address spender, uint256 tokenId) public view returns (bool) {
        address owner = owners[tokenId];
        if (owner == address(0)) return false;
        return spender == owner || spender == approvals[tokenId] || operators[owner][spender];
    }

    function approve(address approved, uint256 tokenId) external {
        address owner = owners[tokenId];
        if (owner == address(0)) revert ZeroAddress();
        if (owner == approved) revert SameAddress();
        if (msg.sender != owner && !operators[owner][msg.sender]) revert NotApprovedOrOwner();
        approvals[tokenId] = approved;
        emit Approval(owner, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == msg.sender) revert SameAddress();
        operators[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (escrowType[tokenId] == EscrowType.LOCKED) revert NotManagedOrNormalNFT();
        if (!isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        if (owners[tokenId] != from) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();

        delete approvals[tokenId];
        balances[from]--;
        balances[to]++;
        owners[tokenId] = to;
        ownershipChange[tokenId] = block.number;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        ERC721Utils.checkOnERC721Received(msg.sender, from, to, tokenId, data);
    }

    /* Locks */

    /// @notice Locks `value` BTC from the caller until `now + lockDuration` (rounded down to weeks).
    function createLock(uint256 value, uint256 lockDuration) external returns (uint256) {
        return _createLock(value, lockDuration, msg.sender);
    }

    /// @notice Convenience overload: creates the lock and, if `permanent`, converts it to a permanent lock.
    function createLock(uint256 value, uint256 lockDuration, bool permanent) external returns (uint256 tokenId) {
        tokenId = _createLock(value, lockDuration, msg.sender);
        if (permanent) _lockPermanent(tokenId);
    }

    function createLockFor(uint256 value, uint256 lockDuration, address to) external returns (uint256) {
        return _createLock(value, lockDuration, to);
    }

    /// @notice Adds `value` BTC from the caller to any live lock. Used by the rewards distributor.
    function depositFor(uint256 tokenId, uint256 value) external {
        _increaseAmount(tokenId, value);
    }

    function increaseAmount(uint256 tokenId, uint256 value) external {
        if (!isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        _increaseAmount(tokenId, value);
    }

    function increaseUnlockTime(uint256 tokenId, uint256 lockDuration) external {
        if (!isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        if (escrowType[tokenId] != EscrowType.NORMAL) revert NotNormalNFT();
        LockedBalance storage l = locks[tokenId];
        if (l.isPermanent) revert PermanentLock();
        uint256 unlockTime = (block.timestamp + lockDuration) / WEEK * WEEK;
        if (l.end <= block.timestamp) revert LockExpired();
        if (l.amount <= 0) revert NoLockFound();
        if (unlockTime <= l.end) revert LockDurationNotInFuture();
        if (unlockTime > block.timestamp + MAXTIME) revert LockDurationTooLong();

        l.end = unlockTime;
        _checkpoint(tokenId);
    }

    function lockPermanent(uint256 tokenId) external {
        if (!isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        _lockPermanent(tokenId);
    }

    /// @notice Burns `from` and adds its BTC to `to`, keeping the later end. `from` loses its boost.
    function merge(uint256 from, uint256 to) external {
        if (voted[from]) revert AlreadyVoted();
        if (escrowType[from] != EscrowType.NORMAL || escrowType[to] != EscrowType.NORMAL) revert NotNormalNFT();
        if (from == to) revert SameNFT();
        if (!isApprovedOrOwner(msg.sender, from) || !isApprovedOrOwner(msg.sender, to)) {
            revert NotApprovedOrOwner();
        }
        LockedBalance storage lTo = locks[to];
        if (lTo.end <= block.timestamp && !lTo.isPermanent) revert LockExpired();
        LockedBalance memory lFrom = locks[from];
        if (lFrom.isPermanent) revert PermanentLock();

        _burn(from);
        lTo.amount += lFrom.amount;
        if (!lTo.isPermanent && lFrom.end > lTo.end) lTo.end = lFrom.end;
        _checkpoint(to);
    }

    /// @notice Returns the BTC of an expired, unvoted, timed lock to the caller and burns the NFT.
    function withdraw(uint256 tokenId) external {
        if (!isApprovedOrOwner(msg.sender, tokenId)) revert NotApprovedOrOwner();
        if (voted[tokenId]) revert AlreadyVoted();
        if (escrowType[tokenId] != EscrowType.NORMAL) revert NotNormalNFT();
        LockedBalance memory l = locks[tokenId];
        if (l.isPermanent) revert PermanentLock();
        if (block.timestamp < l.end) revert LockNotExpired();

        _burn(tokenId);
        IERC20(token).safeTransfer(msg.sender, uint256(int256(l.amount)));
    }

    /* Views */

    function locked(uint256 tokenId) external view returns (LockedBalance memory) {
        return locks[tokenId];
    }

    /// @notice Current boosted voting power; zero in the block the NFT changed hands.
    function votingPowerOfNFT(uint256 tokenId) external view returns (uint256) {
        if (ownershipChange[tokenId] == block.number) return 0;
        return votingPowerOfNFTAt(tokenId, block.timestamp);
    }

    function votingPowerOfNFTAt(uint256 tokenId, uint256 timestamp) public view returns (uint256) {
        Point[] storage points = history[tokenId];
        for (uint256 i = points.length; i > 0; i--) {
            Point memory p = points[i - 1];
            if (p.ts <= timestamp) return _power(p, timestamp);
        }
        return 0;
    }

    /* Voter hook */

    function voting(uint256 tokenId, bool voted_) external {
        if (msg.sender != voter) revert NotVoter();
        voted[tokenId] = voted_;
    }

    /* Test helpers */

    function setVoter(address voter_) external {
        voter = voter_;
    }

    function setEscrowType(uint256 tokenId, EscrowType escrowType_) external {
        escrowType[tokenId] = escrowType_;
    }

    function setGrantManager(uint256 tokenId, address grantManager_) external {
        grantManager[tokenId] = grantManager_;
    }

    /// @param boost Multiplier with 1e18 precision (5e18 = 5x); 0 means 1x.
    function setBoost(uint256 tokenId, uint256 boost) external {
        locks[tokenId].boost = boost;
        _checkpoint(tokenId);
    }

    /* Internals */

    function _createLock(uint256 value, uint256 lockDuration, address to) internal returns (uint256 tokenId) {
        uint256 unlockTime = (block.timestamp + lockDuration) / WEEK * WEEK;
        if (value == 0) revert ZeroAmount();
        if (unlockTime <= block.timestamp) revert LockDurationNotInFuture();
        if (unlockTime > block.timestamp + MAXTIME) revert LockDurationTooLong();
        if (to == address(0)) revert ZeroAddress();

        tokenId = ++lastTokenId;
        owners[tokenId] = to;
        balances[to]++;
        emit Transfer(address(0), to, tokenId);

        IERC20(token).safeTransferFrom(msg.sender, address(this), value);
        locks[tokenId] = LockedBalance({amount: _toInt128(value), end: unlockTime, isPermanent: false, boost: 0});
        _checkpoint(tokenId);
    }

    function _increaseAmount(uint256 tokenId, uint256 value) internal {
        if (escrowType[tokenId] == EscrowType.LOCKED) revert NotManagedOrNormalNFT();
        LockedBalance storage l = locks[tokenId];
        if (value == 0) revert ZeroAmount();
        if (l.amount <= 0) revert NoLockFound();
        if (l.end <= block.timestamp && !l.isPermanent) revert LockExpired();

        IERC20(token).safeTransferFrom(msg.sender, address(this), value);
        l.amount += _toInt128(value);
        _checkpoint(tokenId);
    }

    function _lockPermanent(uint256 tokenId) internal {
        if (escrowType[tokenId] != EscrowType.NORMAL) revert NotNormalNFT();
        LockedBalance storage l = locks[tokenId];
        if (l.isPermanent) revert PermanentLock();
        if (l.end <= block.timestamp) revert LockExpired();
        if (l.amount <= 0) revert NoLockFound();

        l.end = 0;
        l.isPermanent = true;
        _checkpoint(tokenId);
    }

    function _burn(uint256 tokenId) internal {
        address owner = owners[tokenId];
        delete approvals[tokenId];
        delete owners[tokenId];
        balances[owner]--;
        delete locks[tokenId];
        _checkpoint(tokenId);
        emit Transfer(owner, address(0), tokenId);
    }

    function _checkpoint(uint256 tokenId) internal {
        LockedBalance memory l = locks[tokenId];
        history[tokenId].push(
            Point({ts: block.timestamp, amount: l.amount, end: l.end, permanent: l.isPermanent, boost: l.boost})
        );
    }

    function _power(Point memory p, uint256 timestamp) internal pure returns (uint256) {
        if (p.amount <= 0) return 0;
        uint256 amount = uint256(int256(p.amount));
        uint256 power;
        if (p.permanent) {
            power = amount;
        } else if (p.end > timestamp) {
            power = amount * (p.end - timestamp) / MAXTIME;
        }
        return p.boost == 0 ? power : power * p.boost / BOOST_PRECISION;
    }

    function _toInt128(uint256 value) internal pure returns (int128) {
        return SafeCast.toInt128(SafeCast.toInt256(value));
    }
}
