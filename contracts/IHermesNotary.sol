// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import "@fhevm/solidity/lib/FHE.sol";

/**
 * @title Hermes Notary Interface (FHE)
 * @notice Read/Write surface used by the escrow to maintain an auditable OTC RFQ trail
 *         while keeping numeric values confidential via FHE types.
 * @dev
 * - All state-mutating functions are intended to be callable only by the escrow (see implementation).
 * - Amounts are stored as FHE encrypted integers and must be permissioned with FHE.allow/allowThis.
 */
interface IHermesNotary {
    /**
     * @dev Canonical, confidential status for a given RFQ.
     *      Used by off-chain indexers and on-chain views to audit lifecycle.
     */
    struct RFQStatus {
        /// @notice RFQ maker address.
        address maker;
        /// @notice RFQ taker address (counterparty).
        address taker;
        /// @notice Maker-side token (the one maker deposits / taker receives).
        address tokenAddressIn;
        /// @notice Taker-side token (the one taker deposits / maker receives).
        address tokenAddressOut;
        /// @notice Creation timestamp (seconds since epoch).
        uint64 createdAt;
        /// @notice Expiration timestamp.
        uint256 expirationTimestamp;
        /**
         * @notice Consent bitmask.
         * @dev bit0 (0x01) = maker agreed, bit1 (0x02) = taker agreed, 0x03 = both agreed.
         */
        uint8 consentMask;
        /// @notice True if RFQ was canceled.
        bool canceled;
        /// @notice True if RFQ was internally marked expired by escrow.
        bool expired;
        /// @notice True once settlement completed.
        bool filled;
        /// @notice Confidential agreed amount for tokenAddressIn.
        euint64 amountIn;
        /// @notice Confidential agreed amount for tokenAddressOut.
        euint64 amountOut;
        /// @notice Confidential amount actually deposited by maker.
        euint64 makerDeposit;
        /// @notice Confidential amount actually deposited by taker.
        euint64 takerDeposit;
        /// @notice Confidential amount sent to maker at settlement (tokenAddressOut).
        euint64 amountSentMaker;
        /// @notice Confidential amount sent to taker at settlement (tokenAddressIn).
        euint64 amountSentTaker;
        /// @notice keccak256 hash of maker’s EIP-712 signature bytes.
        bytes32 makerSigHash;
        /// @notice keccak256 hash of taker’s EIP-712 signature bytes.
        bytes32 takerSigHash;
        /// @notice True once Proof of Deposit (PoD) confirms funds are fully deposited.
        bool fundDeposited;
        /// @notice Obfuscated (makerDeposit + takerDeposit) used during PoD (same multiplier on both sums).
        uint128 obfuscatedDeposits;
    }

    // --- writes (escrow-only) ---
    function recordCreate(
        bytes32 rfqId,
        uint64 createdAt,
        euint64 amountIn,
        euint64 amountOut,
        address maker,
        address taker,
        address tokenAddressIn,
        address tokenAddressOut,
        uint256 expiration
    ) external;

    function recordMakerAgree(bytes32 rfqId, bytes32 sigHash, euint64 depositAmount) external;

    function recordTakerAgree(bytes32 rfqId, bytes32 sigHash, euint64 depositAmount) external;

    function recordCancel(bytes32 rfqId) external;

    function recordFill(bytes32 rfqId, euint64 sentToMaker, euint64 sentToTaker) external;

    function recordPod(bytes32 rfqId, uint128 obfuscatedDeposits) external;

    function recordExpire(bytes32 rfqId) external;

    function statusOf(bytes32 rfqId) external view returns (RFQStatus memory);

    function escrow() external view returns (address);

    function setEscrow(address newEscrow) external;
}
