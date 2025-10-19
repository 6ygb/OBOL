// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

contract ObolPriceOracle {
    event PriceUpdated(uint128 price6, uint64 epoch, uint256 ts);

    address public immutable relayer;
    uint128 public price6;
    uint64 public epoch;
    uint256 public lastTs;
    uint256 public immutable staleTtl;

    modifier onlyRelayer() {
        require(msg.sender == relayer, "RELAYER");
        _;
    }

    constructor(address _relayer, uint256 _staleTtl) {
        relayer = _relayer;
        staleTtl = _staleTtl;
    }

    function setPrice(uint128 _price6, uint64 _epoch) external onlyRelayer {
        require(_price6 > 0, "ZERO_PRICE");
        require(_epoch > epoch, "STALE_EPOCH");
        price6 = _price6;
        epoch = _epoch;
        lastTs = block.timestamp;
        emit PriceUpdated(_price6, _epoch, lastTs);
    }

    function isFresh() public view returns (bool) {
        return block.timestamp - lastTs <= staleTtl;
    }
}
