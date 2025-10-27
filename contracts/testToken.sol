// SPDX-License-Identifier: BSD-3-Clause-Clear

pragma solidity ^0.8.27;

import "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "./OZ-confidential-contracts-fork/ERC7984.sol";

contract ConfidentialToken is SepoliaConfig, ERC7984 {
    euint64 private airDropAmount;

    constructor(string memory name_, string memory symbol_) ERC7984(name_, symbol_, "") {
        uint64 scalingFactor = uint64(10) ** decimals();
        euint64 mintAmount = FHE.asEuint64(1_000_000 * scalingFactor);
        airDropAmount = FHE.asEuint64(1000 * scalingFactor);
        FHE.allowThis(airDropAmount);
        _mint(msg.sender, mintAmount);
    }

    function airDrop() public {
        _mint(msg.sender, airDropAmount);
    }
}
