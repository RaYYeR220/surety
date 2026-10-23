// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title LinearKinkIrm
/// @notice Borrow rate as a piecewise-linear function of utilisation with one kink.
/// @dev APRs and utilisation are WAD (1e18 = 100%). The per-second rate is the APR divided by 365 days and is
/// applied as simple interest between accruals.
contract LinearKinkIrm {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    /// @notice Upper bound on any APR of the curve (1000%), a sanity limit against misconfiguration.
    uint256 public constant APR_LIMIT = 10e18;

    /// @notice APR at 0% utilisation.
    uint256 public immutable baseApr;
    /// @notice APR at `kinkUtilWad`.
    uint256 public immutable kinkApr;
    /// @notice APR at 100% utilisation.
    uint256 public immutable maxApr;
    /// @notice Utilisation where the slope steepens.
    uint256 public immutable kinkUtilWad;

    /// @notice APRs are not non-decreasing, exceed APR_LIMIT, or the kink is not strictly inside (0, 1).
    error BadCurve();

    constructor(uint256 baseApr_, uint256 kinkApr_, uint256 maxApr_, uint256 kinkUtilWad_) {
        if (baseApr_ > kinkApr_ || kinkApr_ > maxApr_ || maxApr_ > APR_LIMIT) revert BadCurve();
        if (kinkUtilWad_ == 0 || kinkUtilWad_ >= WAD) revert BadCurve();
        baseApr = baseApr_;
        kinkApr = kinkApr_;
        maxApr = maxApr_;
        kinkUtilWad = kinkUtilWad_;
    }

    /// @notice Borrow APR at `utilWad`; utilisation above 100% is treated as 100%.
    function aprAt(uint256 utilWad) public view returns (uint256) {
        if (utilWad >= WAD) return maxApr;
        if (utilWad <= kinkUtilWad) return baseApr + (kinkApr - baseApr) * utilWad / kinkUtilWad;
        return kinkApr + (maxApr - kinkApr) * (utilWad - kinkUtilWad) / (WAD - kinkUtilWad);
    }

    /// @notice Borrow rate per second at `utilWad`, WAD-scaled.
    function ratePerSecond(uint256 utilWad) external view returns (uint256) {
        return aprAt(utilWad) / YEAR;
    }
}
