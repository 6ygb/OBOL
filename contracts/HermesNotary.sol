// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IHermesNotary} from "./IHermesNotary.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title HermesNotary
 * @notice Confidential notary used by the escrow to persist RFQ lifecycle state under FHE.
 * @dev
 * - All mutating methods are gated by {onlyEscrow}; the escrow address is controlled by the owner.
 * - Numeric amounts are FHE types. Decryption right is granted via FHE.allow().
 * - Ensure the RFQStatus struct field names match the interface; this implementation uses
 */
contract HermesNotary is SepoliaConfig, IHermesNotary, Ownable {
    /// @notice Current escrow allowed to write notary entries. Updatable by the owner.
    address public override escrow;

    /// @dev RFQ id => canonical confidential status snapshot.
    mapping(bytes32 => RFQStatus) private _status;

    /**
     * @dev Initializes the contract and sets the initial escrow to the deployer.
     * Also initializes Ownable with the deployer as the initial owner.
     */
    constructor() Ownable(msg.sender) {
        address initialEscrow = msg.sender;
        escrow = initialEscrow;
    }

    /**
     * @dev Restricts function to the active escrow.
     * Reverts with "Notary: only escrow" otherwise.
     */
    modifier onlyEscrow() {
        require(msg.sender == escrow, "Notary: only escrow");
        _;
    }

    /**
     * @notice Updates the escrow account that can write to this notary.
     * @dev Transfers Ownable ownership to the new escrow as part of the handover.
     * @param newEscrow Address of the new escrow contract (must be nonzero).
     */
    function setEscrow(address newEscrow) external override onlyOwner {
        require(newEscrow != address(0), "Notary: zero escrow");
        escrow = newEscrow;
        _transferOwnership(newEscrow);
    }

    /**
     * @notice Creates a new RFQ notary entry.
     * @dev One-time operation per rfqId; reverts if already created.
     * Grants FHE view permissions of amounts to both maker and taker.
     * @param rfqId Unique RFQ identifier (from escrow).
     * @param createdAt RFQ creation timestamp.
     * @param amountIn Confidential agreed amount for tokenAddressIn.
     * @param amountOut Confidential agreed amount for tokenAddressOut.
     * @param maker Maker address.
     * @param taker Taker address.
     * @param tokenAddressIn Maker-side token address.
     * @param tokenAddressOut Taker-side token address.
     * @param expiration Expiration timestamp recorded for auditing.
     */
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
    ) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt == 0, "Notary: exists");
        s.createdAt = createdAt;
        s.amountIn = amountIn;
        s.amountOut = amountOut;
        s.maker = maker;
        s.taker = taker;
        s.tokenAddressIn = tokenAddressIn;
        s.tokenAddressOut = tokenAddressOut;
        s.expirationTimestamp = expiration;
        s.expired = false;

        //Allow both parties to decrypt the confidential amounts
        FHE.allow(s.amountIn, maker);
        FHE.allow(s.amountOut, maker);
        FHE.allow(s.amountIn, taker);
        FHE.allow(s.amountOut, taker);
    }

    /**
     * @notice Records maker's agreement and deposit.
     * @dev Sets maker bit in consent mask, stores signature hash and FHE deposit.
     * Grants view permissions of the deposit to both parties.
     * @param rfqId RFQ id.
     * @param sigHash keccak256 hash of the maker's EIP-712 signature bytes.
     * @param depositAmount Confidential amount deposited by maker.
     */
    function recordMakerAgree(bytes32 rfqId, bytes32 sigHash, euint64 depositAmount) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt != 0, "Notary: unknown rfq");
        s.consentMask = s.consentMask | 0x01; // maker bit
        s.makerSigHash = sigHash;
        s.makerDeposit = depositAmount;

        FHE.allow(s.makerDeposit, s.maker);
        FHE.allow(s.makerDeposit, s.taker);
    }

    /**
     * @notice Records taker's agreement and deposit.
     * @dev Sets taker bit in consent mask, stores signature hash and FHE deposit.
     * Grants view permissions of the deposit to both parties.
     * @param rfqId RFQ id.
     * @param sigHash keccak256 hash of the taker's EIP-712 signature bytes.
     * @param depositAmount Confidential amount deposited by taker.
     */
    function recordTakerAgree(bytes32 rfqId, bytes32 sigHash, euint64 depositAmount) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt != 0, "Notary: unknown rfq");
        s.consentMask = s.consentMask | 0x02; // taker bit
        s.takerSigHash = sigHash;
        s.takerDeposit = depositAmount;

        FHE.allow(s.takerDeposit, s.maker);
        FHE.allow(s.takerDeposit, s.taker);
    }

    /**
     * @notice Marks an RFQ as canceled.
     * @dev Reverts if already canceled/filled. No deposit logic here (escrow handles funds).
     * @param rfqId RFQ id.
     */
    function recordCancel(bytes32 rfqId) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt != 0, "Notary: unknown rfq");
        require(!s.canceled && !s.filled, "Notary: inactive");
        s.canceled = true;
    }

    /**
     * @notice Records final settlement amounts sent to each party.
     * @dev Requires both consent bits set (0x03). Grants view permissions to both parties.
     * @param rfqId RFQ id.
     * @param sentToMaker Confidential amount of tokenAddressOut sent to maker.
     * @param sentToTaker Confidential amount of tokenAddressIn sent to taker.
     */
    function recordFill(bytes32 rfqId, euint64 sentToMaker, euint64 sentToTaker) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt != 0, "Notary: unknown rfq");
        require(!s.canceled && !s.filled, "Notary: inactive");
        require(s.consentMask == 0x03, "Notary: not both agreed");
        s.filled = true;
        s.amountSentMaker = sentToMaker;
        s.amountSentTaker = sentToTaker;

        FHE.allow(s.amountSentMaker, s.maker);
        FHE.allow(s.amountSentTaker, s.maker);
        FHE.allow(s.amountSentMaker, s.taker);
        FHE.allow(s.amountSentTaker, s.taker);
    }

    /**
     * @notice Records that deposits have been verified via Proof of Deposit (PoD).
     * @dev Stores the obfuscated total deposits for auditability.
     * @param rfqId RFQ id.
     * @param obfuscatedDeposits Obfuscated (makerDeposit + takerDeposit) under shared multiplier.
     */
    function recordPod(bytes32 rfqId, uint128 obfuscatedDeposits) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt != 0, "Notary: unknown rfq");
        require(!s.canceled && !s.filled, "Notary: inactive");
        s.fundDeposited = true;
        s.obfuscatedDeposits = obfuscatedDeposits;
    }

    /**
     * @notice Marks an RFQ as expired.
     * @dev Escrow calls this when its internal time checks trip; users cannot force expiry.
     * @param rfqId RFQ id.
     */
    function recordExpire(bytes32 rfqId) external override onlyEscrow {
        RFQStatus storage s = _status[rfqId];
        require(s.createdAt != 0, "Notary: unknown rfq");
        require(!s.canceled && !s.filled && !s.expired, "Notary: inactive");
        s.expired = true;
    }

    /**
     * @notice Returns the confidential status of an RFQ.
     * @param rfqId RFQ id.
     * @return RFQStatus snapshot stored for the RFQ.
     */
    function statusOf(bytes32 rfqId) external view override returns (RFQStatus memory) {
        return _status[rfqId];
    }
}
