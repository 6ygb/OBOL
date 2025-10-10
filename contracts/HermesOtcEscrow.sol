// SPDX-License-Identifier: BSD-3-Clause-Clear

pragma solidity ^0.8.27;

import "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC7984} from "./OZ-confidential-contracts-fork/IERC7984.sol";
import "./IHermesNotary.sol";

/** TO DO :
 * Maybe : KYC whitelist to simulate Private Equity usecase
 */
/**
 * @title Hermes OTC Escrow (FHE)
 * @notice Confidential OTC escrow coordinating deposits, agreement, PoD, and settlement with a Notary.
 * @dev
 * - Uses Fully Homomorphic Encryption (FHE) types to keep amounts confidential on-chain.
 * - Consent is tracked via a 2-bit mask: maker (bit0), taker (bit1).
 * - Expiration is enforced internally via `_checkForExpiration`.
 * - Notary contract is used for an audit trail and cross-contract visibility.
 *
 */
contract HermesOtcEscrow is SepoliaConfig {
    /**
     * @dev Confidential RFQ state stored in escrow.
     * @param maker RFQ maker address.
     * @param taker RFQ taker address (counterparty).
     * @param tokenAddressIn Token the maker deposits (received by taker at settlement).
     * @param tokenAddressOut Token the taker deposits (received by maker at settlement).
     * @param tokenAmountIn Confidential amount for tokenAddressIn.
     * @param tokenAmountOut Confidential amount for tokenAddressOut.
     * @param createdAt Block timestamp at creation.
     * @param expirationTimestamp Expiry timestamp.
     * @param expired True once internally marked expired by `_checkForExpiration`.
     * @param canceled True if RFQ has been canceled.
     * @param filled True once settlement has completed.
     * @param fundDeposited True once PoD validated combined deposits equal agreed amounts.
     */
    struct RFQStruct {
        address maker;
        address taker;
        address tokenAddressIn;
        address tokenAddressOut;
        euint64 tokenAmountIn;
        euint64 tokenAmountOut;
        uint256 createdAt;
        uint256 expirationTimestamp;
        bool expired;
        bool canceled;
        bool filled;
        bool fundDeposited;
    }

    /**
     * @dev Per-user RFQ references for simple UX queries.
     */
    struct userStorage {
        bytes32[] sentRFQ;
        bytes32[] receivedRFQ;
    }

    /// @dev RFQ storage by id
    mapping(bytes32 rfqID => RFQStruct rfq) public rfqs;

    /// @dev User RFQ lists (sent/received).
    mapping(address user => userStorage userHistory) private userRfqs;

    /// @dev Per-maker nonce used to salt RFQ id derivation.
    mapping(address user => uint256 nonce) private makerNonce;

    /// @dev Confidential amounts actually deposited by maker/taker.
    mapping(bytes32 rfqID => euint64 amount) private makerDeposits;
    mapping(bytes32 rfqID => euint64 amount) private takerDeposits;

    /// @dev Map decryption request id -> rfq id for PoD callback bundling.
    mapping(uint256 requestID => bytes32 rfqID) private podBundle;

    /**
     * @dev Consent mask: bit0 (0x01) maker agreed, bit1 (0x02) taker agreed.
     * 0b00: none, 0b01: maker only, 0b10: taker only, 0b11: both.
     */
    mapping(bytes32 => uint8) public consentMask;

    /**
     * @dev Emitted when an RFQ is created.
     * @param maker RFQ maker.
     * @param blockNumber Current block number at creation.
     * @param rfqID Deterministic identifier for the RFQ.
     */
    event RFQCreated(address maker, uint256 blockNumber, bytes32 rfqID);

    /**
     * @dev Emitted when proof-of-deposit is recorded (deposits match agreed amounts).
     * @param maker RFQ maker.
     * @param taker RFQ taker.
     * @param blockNumber Current block number at PoD.
     * @param rfqID RFQ id.
     */
    event ProofOfDeposit(address maker, address taker, uint256 blockNumber, bytes32 rfqID);

    /**
     * @dev Emitted when an RFQ is internally marked as expired.
     * @param maker RFQ maker.
     * @param taker RFQ taker.
     * @param blockNumber Current block number at expiration.
     * @param rfqID RFQ id.
     */
    event OrderExpired(address maker, address taker, uint256 blockNumber, bytes32 rfqID);

    /**
     * @dev Emitted when an RFQ gets canceled (and refunds processed if any deposit).
     * @param maker RFQ maker.
     * @param taker RFQ taker.
     * @param blockNumber Current block number at cancel.
     * @param rfqID RFQ id.
     */
    event OrderCanceled(address maker, address taker, uint256 blockNumber, bytes32 rfqID);

    /**
     * @dev Emitted once a successful settlement occurs.
     * @param maker RFQ maker.
     * @param taker RFQ taker.
     * @param blockNumber Current block number at settlement.
     * @param rfqID RFQ id.
     */
    event OrderFulfilled(address maker, address taker, uint256 blockNumber, bytes32 rfqID);

    //EIP-712 domain
    /// @dev EIP-712 domain name.
    string private constant NAME = "Hermes-OTC";
    /// @dev EIP-712 domain version.
    string private constant VERSION = "1";
    /// @dev EIP-712 domain separator for this deployment.
    bytes32 public immutable DOMAIN_SEPARATOR;

    //typehashes
    /// @dev EIP-712 domain typehash.
    bytes32 private constant EIP712DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev Maker agreement typehash.
    bytes32 private constant MAKER_AGREE_TYPEHASH =
        keccak256(
            "MakerAgree(bytes32 rfqId,address maker,address taker,address tokenAddressIn,address tokenAddressOut,bytes32 amountIn,bytes32 amountOut,uint256 createdAt,uint256 expirationTimestamp)"
        );

    /// @dev Taker agreement typehash.
    bytes32 private constant TAKER_AGREE_TYPEHASH =
        keccak256(
            "TakerAgree(bytes32 rfqId,address maker,address taker,address tokenAddressIn,address tokenAddressOut,bytes32 amountIn,bytes32 amountOut,uint256 createdAt,uint256 expirationTimestamp)"
        );

    /// @dev Consent bit flags for readability.
    uint8 constant MAKER_BIT = 0x01;
    uint8 constant TAKER_BIT = 0x02;

    /// @dev Notary interface and saved address used for FHE `allow` and audit writes.
    IHermesNotary public immutable NOTARY;
    address private immutable notaryAddress;

    /**
     * @dev Contract constructor.
     * @param notaryAddr Address of the deployed Notary contract.
     *
     * Initializes the EIP-712 domain separator and stores the Notary reference.
     */
    constructor(address notaryAddr) {
        notaryAddress = notaryAddr;
        NOTARY = IHermesNotary(notaryAddr);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @dev Pull confidential tokens from `from` into escrow.
     * @param from Token owner (must have set the escrow as operator on the ERC-7984 token).
     * @param targetTokenAddress ERC-7984 token address.
     * @param transferAmount Confidential amount to transfer.
     * @return receivedAmount Confidential delta actually received by this contract.
     *
     * Requirements:
     * - `targetToken.isOperator(from, address(this))` must be true.
     * - `transferAmount` permissions are set transiently for the token contract.
     */
    function _transferTokensToHermes(
        address from,
        address targetTokenAddress,
        euint64 transferAmount
    ) internal returns (euint64 receivedAmount) {
        IERC7984 targetToken = IERC7984(targetTokenAddress);
        require(targetToken.isOperator(from, address(this)), "Hermes must be an Operator.");
        FHE.allowTransient(transferAmount, targetTokenAddress);

        euint64 balanceBefore = targetToken.confidentialBalanceOf(address(this));
        targetToken.confidentialTransferFrom(from, address(this), transferAmount);
        euint64 balanceAfter = targetToken.confidentialBalanceOf(address(this));

        receivedAmount = FHE.sub(balanceAfter, balanceBefore);
    }

    /**
     * @dev Push confidential tokens from escrow to `to`.
     * @param to Recipient address.
     * @param targetTokenAddress ERC-7984 token address.
     * @param transferAmount Confidential amount to transfer.
     * @return sentAmount Confidential delta actually sent (before - after).
     *
     * @notice Uses (before - after) to compute the actual transfer, preventing underflow/overflow artifacts.
     */
    function _transferTokensFromHermes(
        address to,
        address targetTokenAddress,
        euint64 transferAmount
    ) internal returns (euint64 sentAmount) {
        IERC7984 targetToken = IERC7984(targetTokenAddress);
        FHE.allowTransient(transferAmount, targetTokenAddress);

        euint64 balanceBefore = targetToken.confidentialBalanceOf(address(this));
        targetToken.confidentialTransfer(to, transferAmount);
        euint64 balanceAfter = targetToken.confidentialBalanceOf(address(this));

        sentAmount = FHE.sub(balanceBefore, balanceAfter);
    }

    /**
     * @dev Refund any existing deposits based on consent mask bits.
     * @param rfqID Target RFQ id.
     *
     * Refunds only the sides that actually deposited (bit set) using the stored confidential deposit amounts.
     */
    function _refundDeposits(bytes32 rfqID) internal {
        RFQStruct storage targetRFQ = rfqs[rfqID];

        uint8 mask = consentMask[rfqID];
        if ((mask & 0x01) != 0) {
            _transferTokensFromHermes(targetRFQ.maker, targetRFQ.tokenAddressIn, makerDeposits[rfqID]);
        }
        if ((mask & 0x02) != 0) {
            _transferTokensFromHermes(targetRFQ.taker, targetRFQ.tokenAddressOut, takerDeposits[rfqID]);
        }
    }

    /**
     * @dev Internal RFQ creation helper. Mints an RFQ id and initializes storage + Notary.
     * @param _maker Maker address.
     * @param _taker Taker address (must be non-zero).
     * @param tokenIn Maker deposit token address.
     * @param tokenOut Taker deposit token address.
     * @param _amountIn Confidential amount for tokenIn.
     * @param _amountOut Confidential amount for tokenOut.
     * @param expiration Expiry timestamp (must be in the future).
     * @return rfqID Newly created RFQ id.
     */
    function _createRFQ(
        address _maker,
        address _taker,
        address tokenIn,
        address tokenOut,
        euint64 _amountIn,
        euint64 _amountOut,
        uint256 expiration
    ) internal returns (bytes32) {
        require(_taker != address(0), "Invalid taker address.");
        require(expiration > block.timestamp, "expiry in past");

        bytes32 rfqID = keccak256(
            abi.encode(
                _maker,
                _taker,
                tokenIn,
                tokenOut,
                _amountIn,
                _amountOut,
                block.timestamp,
                expiration,
                makerNonce[msg.sender]++
            )
        );

        rfqs[rfqID] = RFQStruct({
            maker: _maker,
            taker: _taker,
            tokenAddressIn: tokenIn,
            tokenAddressOut: tokenOut,
            tokenAmountIn: _amountIn,
            tokenAmountOut: _amountOut,
            createdAt: block.timestamp,
            expirationTimestamp: expiration,
            expired: false,
            canceled: false,
            filled: false,
            fundDeposited: false
        });

        FHE.allow(rfqs[rfqID].tokenAmountIn, _taker);
        FHE.allow(rfqs[rfqID].tokenAmountOut, _taker);
        FHE.allow(rfqs[rfqID].tokenAmountIn, _maker);
        FHE.allow(rfqs[rfqID].tokenAmountOut, _maker);

        FHE.allowThis(rfqs[rfqID].tokenAmountIn);
        FHE.allowThis(rfqs[rfqID].tokenAmountOut);

        FHE.allow(rfqs[rfqID].tokenAmountIn, notaryAddress);
        FHE.allow(rfqs[rfqID].tokenAmountOut, notaryAddress);

        userRfqs[_maker].sentRFQ.push(rfqID);
        userRfqs[_taker].receivedRFQ.push(rfqID);

        emit RFQCreated(_maker, block.number, rfqID);

        NOTARY.recordCreate(
            rfqID,
            uint64(block.timestamp),
            rfqs[rfqID].tokenAmountIn,
            rfqs[rfqID].tokenAmountOut,
            _maker,
            _taker,
            tokenIn,
            tokenOut,
            expiration
        );

        return rfqID;
    }

    /**
     * @dev Internal expiry checker; marks expired, notifies Notary, emits event, and refunds deposits once.
     * @param rfqID Target RFQ id.
     * @return expiredNow True if RFQ is (now) expired or already marked as expired.
     *
     * @notice This function never reverts on expiration; it performs side-effects then returns true,
     *         allowing callers to early-return without rolling back state.
     */
    function _checkForExpiration(bytes32 rfqID) internal returns (bool) {
        RFQStruct storage r = rfqs[rfqID];

        if (r.expired) return true;

        if (block.timestamp > r.expirationTimestamp) {
            r.expired = true;
            NOTARY.recordExpire(rfqID);
            emit OrderExpired(r.maker, r.taker, block.number, rfqID);

            _refundDeposits(rfqID);

            return true;
        }

        return false;
    }

    /**
     * @notice Create a new RFQ using euint64 amounts.
     * @param taker RFQ taker address.
     * @param tokenIn Maker deposit token.
     * @param tokenOut Taker deposit token.
     * @param amountIn Confidential amount for tokenIn.
     * @param amountOut Confidential amount for tokenOut.
     * @param expiration Expiration timestamp (must be > now).
     * @return createdRfqID New RFQ id.
     *
     * @notice This function is called by another contract.
     */
    function createRFQ(
        address taker,
        address tokenIn,
        address tokenOut,
        euint64 amountIn,
        euint64 amountOut,
        uint256 expiration
    ) external returns (bytes32) {
        bytes32 createdRfqID = _createRFQ(msg.sender, taker, tokenIn, tokenOut, amountIn, amountOut, expiration);
        return createdRfqID;
    }

    /**
     * @notice Create a new RFQ using externally encrypted amounts (handles + proof).
     * @param taker RFQ taker address.
     * @param tokenIn Maker deposit token.
     * @param tokenOut Taker deposit token.
     * @param encryptedAmountIn External handle for tokenIn amount.
     * @param encryptedAmountOut External handle for tokenOut amount.
     * @param expiration Expiration timestamp (must be > now).
     * @param inputProof Input proof for FHE conversion.
     * @return createdRfqID New RFQ id.
     *
     * @notice This function is called by an off chain user.
     */
    function createRFQ(
        address taker,
        address tokenIn,
        address tokenOut,
        externalEuint64 encryptedAmountIn,
        externalEuint64 encryptedAmountOut,
        uint256 expiration,
        bytes calldata inputProof
    ) external returns (bytes32) {
        euint64 amountIn = FHE.fromExternal(encryptedAmountIn, inputProof);
        euint64 amountOut = FHE.fromExternal(encryptedAmountOut, inputProof);

        bytes32 createdRfqID = _createRFQ(msg.sender, taker, tokenIn, tokenOut, amountIn, amountOut, expiration);
        return createdRfqID;
    }

    /**
     * @notice Get lists of RFQs created-by and addressed-to msg.sender.
     * @return sent List of RFQ ids created by the caller.
     * @return received List of RFQ ids where the caller is taker.
     */
    function getRFQs() public view returns (bytes32[] memory, bytes32[] memory) {
        userStorage storage ur = userRfqs[msg.sender];
        return (ur.sentRFQ, ur.receivedRFQ);
    }

    /**
     * @notice Cancel an active RFQ (maker or taker).
     * @param rfqID RFQ id.
     *
     * @dev Will early-return if the RFQ has expired (and will refund automatically through `_checkForExpiration`).
     * If still active, refunds any deposits that exist, records cancel to Notary, and marks as canceled.
     */
    function cancelRFQ(bytes32 rfqID) public {
        RFQStruct storage targetRFQ = rfqs[rfqID];

        require(msg.sender == targetRFQ.maker || msg.sender == targetRFQ.taker, "Unauthorized user");
        require(!targetRFQ.filled, "Already filled.");
        require(!targetRFQ.canceled, "Already canceled.");
        if (_checkForExpiration(rfqID)) return;

        _refundDeposits(rfqID);

        NOTARY.recordCancel(rfqID);

        targetRFQ.canceled = true;
    }

    /**
     * @notice Maker agrees to the RFQ terms and deposits `tokenAmountIn`.
     * @param rfqID RFQ id.
     * @param sig EIP-712 maker signature over RFQ data.
     *
     * @dev Pulls maker deposit, checks EIP-712 signature, records to Notary, and sets maker consent bit.
     * Early-returns if the RFQ has expired.
     */
    function makerAgree(bytes32 rfqID, bytes calldata sig) external {
        RFQStruct storage targetRFQ = rfqs[rfqID];
        require(targetRFQ.maker != address(0), "RFQ not found");
        require(!targetRFQ.canceled && !targetRFQ.filled, "inactive");
        require(targetRFQ.maker == msg.sender, "Unauthorized");
        if (_checkForExpiration(rfqID)) return;

        uint8 mask = consentMask[rfqID];
        require((mask & MAKER_BIT) == 0, "maker already agreed");

        euint64 depositAmount = _transferTokensToHermes(
            targetRFQ.maker,
            targetRFQ.tokenAddressIn,
            targetRFQ.tokenAmountIn
        );
        makerDeposits[rfqID] = depositAmount;
        FHE.allowThis(makerDeposits[rfqID]);

        bytes32 structHash = keccak256(
            abi.encode(
                MAKER_AGREE_TYPEHASH,
                rfqID,
                targetRFQ.maker,
                targetRFQ.taker,
                targetRFQ.tokenAddressIn,
                targetRFQ.tokenAddressOut,
                FHE.toBytes32(targetRFQ.tokenAmountIn),
                FHE.toBytes32(targetRFQ.tokenAmountOut),
                targetRFQ.createdAt,
                targetRFQ.expirationTimestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        require(SignatureChecker.isValidSignatureNow(targetRFQ.maker, digest, sig), "bad maker sig");

        FHE.allow(makerDeposits[rfqID], notaryAddress);
        NOTARY.recordMakerAgree(rfqID, keccak256(sig), makerDeposits[rfqID]);

        consentMask[rfqID] = consentMask[rfqID] | MAKER_BIT;
    }

    /**
     * @notice Taker agrees to the RFQ terms and deposits `tokenAmountOut`.
     * @param rfqID RFQ id.
     * @param sig EIP-712 taker signature over RFQ data.
     *
     * @dev Pulls taker deposit, checks EIP-712 signature, records to Notary, and sets taker consent bit.
     * Early-returns if the RFQ has expired.
     */
    function takerAgree(bytes32 rfqID, bytes calldata sig) external {
        RFQStruct storage targetRFQ = rfqs[rfqID];
        require(targetRFQ.maker != address(0), "RFQ not found");
        require(!targetRFQ.canceled && !targetRFQ.filled, "inactive");
        require(targetRFQ.taker == msg.sender, "Unauthorized");
        if (_checkForExpiration(rfqID)) return;

        uint8 mask = consentMask[rfqID];
        require((mask & TAKER_BIT) == 0, "taker already agreed");

        euint64 depositAmount = _transferTokensToHermes(
            targetRFQ.taker,
            targetRFQ.tokenAddressOut,
            targetRFQ.tokenAmountOut
        );
        takerDeposits[rfqID] = depositAmount;
        FHE.allowThis(takerDeposits[rfqID]);

        bytes32 structHash = keccak256(
            abi.encode(
                TAKER_AGREE_TYPEHASH,
                rfqID,
                targetRFQ.maker,
                targetRFQ.taker,
                targetRFQ.tokenAddressIn,
                targetRFQ.tokenAddressOut,
                FHE.toBytes32(targetRFQ.tokenAmountIn),
                FHE.toBytes32(targetRFQ.tokenAmountOut),
                targetRFQ.createdAt,
                targetRFQ.expirationTimestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

        require(SignatureChecker.isValidSignatureNow(targetRFQ.taker, digest, sig), "bad taker sig");

        FHE.allow(takerDeposits[rfqID], notaryAddress);
        NOTARY.recordTakerAgree(rfqID, keccak256(sig), takerDeposits[rfqID]);

        consentMask[rfqID] = consentMask[rfqID] | TAKER_BIT;
    }

    /**
     * @notice Returns the current consent mask for `rfqID`.
     * @param rfqID RFQ id.
     * @return Current consent mask (bit0 maker, bit1 taker).
     *
     * @dev Only participants can query.
     */
    function checkAgreementStatus(bytes32 rfqID) public view returns (uint8) {
        RFQStruct storage targetRFQ = rfqs[rfqID];
        require(targetRFQ.maker != address(0), "RFQ not found");
        require(targetRFQ.maker == msg.sender || targetRFQ.taker == msg.sender, "Unauthorized");

        return consentMask[rfqID];
    }

    /**
     * @notice Generate proof-of-deposit (PoD) once both parties agreed.
     * @param rfqID RFQ id.
     *
     * @dev Obfuscates (maker+taker deposits) and (agreed amounts) with the same random multiplier and
     * requests decryption to compare equality in the callback. Early-returns if expired.
     */
    function generatePoD(bytes32 rfqID) external {
        require(consentMask[rfqID] == (MAKER_BIT | TAKER_BIT), "Both parties must agree.");
        RFQStruct storage targetRFQ = rfqs[rfqID];
        require(targetRFQ.maker == msg.sender || targetRFQ.taker == msg.sender, "Unauthorized");
        if (_checkForExpiration(rfqID)) return;

        //max euint32 4,294,967,295
        //max euint64 18,446,744,073,709,551,615
        //max euint128 340,282,366,920,938,463,463,374,607,431,768,211,455
        //max euint32*euint64 79,228,162,495,817,593,515,539,431,425
        //max euint64*2 * max euint32+27 158,456,325,987,759,367,011,394,650,060

        euint32 randNbr = FHE.randEuint32();
        euint64 randMultiplier = FHE.add(FHE.asEuint64(randNbr), 27);

        euint128 totalDeposits = FHE.add(FHE.asEuint128(makerDeposits[rfqID]), FHE.asEuint128(takerDeposits[rfqID]));
        euint128 agreedAmount = FHE.add(
            FHE.asEuint128(targetRFQ.tokenAmountIn),
            FHE.asEuint128(targetRFQ.tokenAmountOut)
        );

        euint128 obfuscatedDeposits = FHE.mul(totalDeposits, randMultiplier);
        euint128 obfuscatedAgreedAmount = FHE.mul(agreedAmount, randMultiplier);

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(obfuscatedDeposits);
        cts[1] = FHE.toBytes32(obfuscatedAgreedAmount);

        uint256 requestID = FHE.requestDecryption(cts, this.generatePoDCallback.selector);

        FHE.allowThis(obfuscatedDeposits);
        FHE.allowThis(obfuscatedAgreedAmount);

        podBundle[requestID] = rfqID;
    }

    /**
     * @notice Decryption callback for PoD comparison.
     * @param requestID FHE decryption request id.
     * @param cleartexts ABI-encoded (uint128 obfuscatedDeposits, uint128 obfuscatedAgreedAmount).
     * @param decryptionProof Oracle proof for the decryption.
     *
     * @dev If equal, marks funds as deposited and records PoD. Otherwise cancels and refunds.
     */
    function generatePoDCallback(uint256 requestID, bytes memory cleartexts, bytes memory decryptionProof) external {
        FHE.checkSignatures(requestID, cleartexts, decryptionProof);

        (uint128 obfuscatedDeposits, uint128 obfuscatedAgreedAmount) = abi.decode(cleartexts, (uint128, uint128));
        bytes32 rfqID = podBundle[requestID];
        RFQStruct storage targetRFQ = rfqs[rfqID];
        delete podBundle[requestID];

        if (obfuscatedAgreedAmount == obfuscatedDeposits) {
            //write to notary contract
            targetRFQ.fundDeposited = true;
            NOTARY.recordPod(rfqID, obfuscatedDeposits);

            emit ProofOfDeposit(targetRFQ.maker, targetRFQ.taker, block.number, rfqID);
        } else {
            //write to notary contract
            targetRFQ.canceled = true;
            NOTARY.recordCancel(rfqID);

            //refund deposits
            _refundDeposits(rfqID);

            emit OrderCanceled(targetRFQ.maker, targetRFQ.taker, block.number, rfqID);
        }
    }

    /**
     * @notice Settle the RFQ after valid PoD and consent by both parties.
     * @param rfqID RFQ id.
     *
     * @dev Transfers confidential amounts crosswise (maker receives tokenOut, taker receives tokenIn),
     * records settlement to Notary, zeros local deposit records, and emits fulfillment.
     * Early-returns if expired.
     */
    function settle(bytes32 rfqID) external {
        require(consentMask[rfqID] == (MAKER_BIT | TAKER_BIT), "Both parties must agree.");
        RFQStruct storage targetRFQ = rfqs[rfqID];
        require(targetRFQ.maker == msg.sender || targetRFQ.taker == msg.sender, "Unauthorized");
        require(!targetRFQ.filled, "Order already filled");
        require(targetRFQ.fundDeposited, "Fund must be deposited");
        if (_checkForExpiration(rfqID)) return;

        euint64 sentMaker = _transferTokensFromHermes(
            targetRFQ.maker,
            targetRFQ.tokenAddressOut,
            targetRFQ.tokenAmountOut
        );
        euint64 sentTaker = _transferTokensFromHermes(
            targetRFQ.taker,
            targetRFQ.tokenAddressIn,
            targetRFQ.tokenAmountIn
        );

        targetRFQ.filled = true;

        FHE.allow(sentMaker, notaryAddress);
        FHE.allow(sentTaker, notaryAddress);
        NOTARY.recordFill(rfqID, sentMaker, sentTaker);

        makerDeposits[rfqID] = FHE.asEuint64(0);
        takerDeposits[rfqID] = FHE.asEuint64(0);

        emit OrderFulfilled(targetRFQ.maker, targetRFQ.taker, block.number, rfqID);
    }
}
