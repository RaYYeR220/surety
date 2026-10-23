// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IMorpho} from "morpho-blue/interfaces/IMorpho.sol";

/// @notice Deploys Morpho Blue and the AdaptiveCurveIrm from the pinned sources in `lib/` (the commits Mezo mainnet
/// runs) and enables the IRM and the 86% LLTV, the only one Mezo enables. Testnet only: Morpho is not deployed on
/// Mezo testnet, while mainnet uses Mezo's own instance.
/// @dev Artifacts come from `test/utils/MorphoImports.sol` (solc 0.8.19). `owner` becomes Morpho's owner.
abstract contract MorphoStackDeployer is Script {
    uint256 internal constant MEZO_MAINNET = 31612;
    uint256 internal constant MORPHO_LLTV = 0.86e18;

    function _deployMorphoStack(address owner) internal returns (address morpho, address irm) {
        require(block.chainid != MEZO_MAINNET, "Mezo mainnet: use Mezo's Morpho Blue");
        morpho = vm.deployCode("Morpho.sol:Morpho", abi.encode(owner));
        irm = vm.deployCode("AdaptiveCurveIrm.sol:AdaptiveCurveIrm", abi.encode(morpho));
        IMorpho(morpho).enableIrm(irm);
        IMorpho(morpho).enableLltv(MORPHO_LLTV);
    }

    /// @dev Starts broadcasting with `DEPLOYER_KEY` if set, else with the `--sender` / default account.
    function _startBroadcast() internal returns (address deployer) {
        uint256 key = vm.envOr("DEPLOYER_KEY", uint256(0));
        if (key != 0) {
            vm.startBroadcast(key);
            return vm.addr(key);
        }
        vm.startBroadcast();
        (, deployer,) = vm.readCallers();
    }
}

/// @notice `forge script script/DeployMorphoStack.s.sol --rpc-url mezo_testnet --broadcast`
/// Env: `DEPLOYER_KEY` (optional; otherwise `--sender` / `--account`).
contract DeployMorphoStack is MorphoStackDeployer {
    function run() external returns (address morpho, address irm) {
        address deployer = _startBroadcast();
        (morpho, irm) = _deployMorphoStack(deployer);
        vm.stopBroadcast();
        console2.log("Morpho Blue      ", morpho);
        console2.log("AdaptiveCurveIrm ", irm);
    }
}
