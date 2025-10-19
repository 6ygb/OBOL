// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;
import {ERC7984} from "./OZ-confidential-contracts-fork/ERC7984.sol";
import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";

contract oToken is ERC7984 {
    address public immutable minter;

    constructor(string memory n, string memory s, address _minter)
      ERC7984(n, s, "") { minter = _minter; }

    modifier onlyMinter(){ require(msg.sender==minter,"MINTER"); _; }

    function confidentialMint(address to, euint64 amount) external onlyMinter {
        _mint(to, amount); 
    }
    function confidentialBurn(address from, euint64 amount) external onlyMinter {
        _burn(from, amount);
    }
}
