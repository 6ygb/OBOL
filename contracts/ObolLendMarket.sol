// SPDX-License-Identifier: BSD-3-Clause-Clear
pragma solidity ^0.8.27;

import {FHE, externalEuint64, euint64, euint32, euint128, ebool} from "@fhevm/solidity/lib/FHE.sol";
import {SepoliaConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "./OZ-confidential-contracts-fork/IERC7984.sol";
import {ERC7984} from "./OZ-confidential-contracts-fork/ERC7984.sol";
import {ObolPriceOracle} from "./ObolPriceOracle.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

contract ConfLendMarket is SepoliaConfig, ERC7984 {
    enum Direction {
        EURtoUSD,
        USDtoEUR
    } //which asset is debt?

    struct UserPos {
        euint64 eCollat;
        euint64 eDebt;
        uint256 A; //secret * collat * LT
        uint256 B; //secret * debt principal
        uint64 posEpoch; //bumps each time A/B recomputed
        uint128 userBorrowIndex6; //snapshot when last touched
        euint32 secret;
        bool updatePending;
        euint64 maxBorrow;
    }

    struct PendingLiqStruct {
        euint64 seizedCollat;
        bool exists;
    }

    //Immutable vars
    Direction public immutable direction;
    IERC7984 public immutable collatToken;
    IERC7984 public immutable debtToken;
    address public immutable collatTokenAddress;
    address public immutable debtTokenAddress;
    address public immutable oracleAddress;
    ObolPriceOracle public immutable oracle;

    uint32 public immutable LT_collat6;
    uint16 public immutable LIQ_BONUS_BPS;
    uint16 public constant CLOSE_FACTOR_BPS = 5000;

    address public rateRelayer; // can set borrow/supply rates

    uint128 public borrowIndex6 = 1_000_000; // 1.000000
    uint128 public supplyIndex6 = 1_000_000; // 1.000000
    uint16 public HYST_BPS;
    uint64 public lastAccrualTs;

    uint64 public borrowApr6; // 1e6-scaled APR (per year)
    uint64 public supplyApr6;
    uint256 constant SECONDS_PER_YEAR = 365 days;

    uint64 private constant RESERVE_MIN6 = 1_000 * 1_000_000;
    bool private bootstrapDone;

    using EnumerableSet for EnumerableSet.AddressSet;
    EnumerableSet.AddressSet private _activeBorrowers;

    //State mappings
    mapping(address => UserPos) public pos;
    mapping(uint256 => address) private factorDecBundle;
    mapping(address => mapping(address => PendingLiqStruct)) private pendingLiquidations;
    mapping(address => bool) public hasOpenDebt;

    //Events
    event RatesUpdated(uint64 brPerSec6, uint64 srPerSec6);
    event Accrued(uint128 borrowIndex6, uint128 supplyIndex6);
    event marketFactorsRefreshed(address indexed user, uint256 requestID, uint256 blockNumber, uint256 A, uint256 B);
    event decryptionRequested(address user, uint256 blockNumber, uint256 requestID);
    event LiquidationQueued(address indexed user, address indexed liquidator, uint256 blockNumber);
    event LiquidationClaimed(address indexed user, address indexed liquidator, uint256 blockNumber);

    /**
     * @dev Restricts access to the {rateRelayer}.
     */
    modifier onlyRateRelayer() {
        require(msg.sender == rateRelayer, "RATE");
        _;
    }

    /**
     * @dev Ensures the oracle price is fresh (prevents stale-risk actions).
     */
    modifier fresh() {
        require(oracle.isFresh(), "STALE_PRICE");
        _;
    }

    /**
     * @dev Ensures the user's risk factors are not in-flight refresh state.
     *      Blocks actions while updatePending is true.
     * @param user The account whose position is being changed
     */
    modifier userPosUTD(address user) {
        require(!pos[user].updatePending, "User position is updating");
        _;
    }

    /**
     * @notice Deploy a new confidential lending market.
     * @param dir          Market direction (which asset is debt)
     * @param _collat      Collateral token (IERC7984)
     * @param _debt        Debt token (IERC7984)
     * @param _oDebtName   Name for oToken (market share token)
     * @param _oDebtTicker Symbol for oToken
     * @param _oracle      Address of price oracle (USD/EUR feed)
     * @param _rateRelayer Address allowed to set APRs
     */
    constructor(
        Direction dir,
        address _collat,
        address _debt,
        string memory _oDebtName,
        string memory _oDebtTicker,
        address _oracle,
        address _rateRelayer
    ) ERC7984(_oDebtName, _oDebtTicker, "") {
        direction = dir;
        collatToken = IERC7984(_collat);
        debtToken = IERC7984(_debt);
        debtTokenAddress = _debt;
        collatTokenAddress = _collat;
        oracleAddress = _oracle;
        oracle = ObolPriceOracle(_oracle);
        LT_collat6 = 850000;
        LIQ_BONUS_BPS = 500;
        HYST_BPS = 100;
        rateRelayer = _rateRelayer;
        lastAccrualTs = uint64(block.timestamp);
    }

    /**
     * @notice Computes ceil(a * b / c) with a single rounding step.
     * @dev Rounds the division up (toward +∞). T
     * @param a Multiplicand
     * @param b Multiplier
     * @param c Divisor (must be non-zero)
     * @return q The value ceil(a * b / c)
     */
    function _ceilDivMul(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        unchecked {
            return (a * b + (c - 1)) / c;
        }
    }

    /**
     * @dev Returns the current number of addresses tracked as having open debt.
     *      Wrapper over {_activeBorrowers.length()} to help clients paginate.
     * @return count Number of active borrower addresses.
     *
     * @notice O(1). The set ordering is not guaranteed and may change as members are added/removed.
     */
    function totalActiveBorrowers() external view returns (uint256) {
        return _activeBorrowers.length();
    }

    /**
     * @dev Returns a paginated slice of active borrower addresses.
     *      If `offset >= totalActiveBorrowers()` or `limit == 0`, returns an empty array.
     *      Uses the iteration order of {EnumerableSet}, which is not guaranteed to be stable.
     *
     * @param offset Starting index into the active-borrowers set snapshot.
     * @param limit  Maximum number of addresses to return.
     * @return out   An array of addresses with length `min(limit, n - offset)` (or zero if out of range).
     *
     * @notice O(limit). The returned view is a snapshot at call time and can get stale immediately after.
     */
    function getActiveBorrowers(uint256 offset, uint256 limit) external view returns (address[] memory) {
        uint256 n = _activeBorrowers.length();

        if (limit == 0 || offset >= n) {
            limit = 0;
        } else {
            uint256 remaining = n - offset;
            if (limit > remaining) limit = remaining;
        }

        address[] memory out = new address[](limit);
        for (uint256 i; i < limit; i++) {
            out[i] = _activeBorrowers.at(offset + i);
        }

        return out;
    }

    /**
     * @dev Returns a paginated slice of active borrowers together with their current
     *      public liquidatability status, as computed by {isLiquidatablePublic}.
     *
     * @param offset Starting index into the active-borrowers set snapshot.
     * @param limit  Maximum number of addresses to check.
     * @return addrs Array of borrower addresses.
     * @return isLiq Array of flags aligned with `addrs` where `true` means liquidatable.
     *
     * @notice O(limit). Results are based on a snapshot at call time and may be stale
     *         by the time a liquidation is attempted on-chain.
     */
    function getLiquidatableSlice(
        uint256 offset,
        uint256 limit
    ) external view returns (address[] memory addrs, bool[] memory isLiq) {
        address[] memory slice = this.getActiveBorrowers(offset, limit);
        bool[] memory flags = new bool[](slice.length);
        for (uint256 i = 0; i < slice.length; i++) {
            flags[i] = isLiquidatablePublic(slice[i]);
        }
        return (slice, flags);
    }

    /**
     * @dev Generates an encrypted random number with optional max and min-add constraints.
     * @param max     Upper bound (0 => unbounded)
     * @param minAdd  If non-zero, ensures result >= minAdd by conditional add
     * @return Encrypted 32-bit random number
     */
    function _generateRNG(uint32 max /* 0 => unbounded */, uint32 minAdd /* 0 => none */) internal returns (euint32) {
        euint32 randomNumber = (max == 0) ? FHE.randEuint32() : FHE.randEuint32(max);
        if (minAdd != 0) {
            ebool tooSmall = FHE.lt(randomNumber, minAdd);
            euint32 addend = FHE.select(tooSmall, FHE.asEuint32(minAdd), FHE.asEuint32(0));
            randomNumber = FHE.add(randomNumber, addend);
        }
        return randomNumber;
    }

    /**
     * @dev Confidential pull: transfer encrypted `amount` of `tokenAddr` from `from` to this market.
     *      Returns the actual encrypted amount received (handles fee-on-transfer tokens).
     * @param from      Source address
     * @param amount    Encrypted amount requested
     * @param tokenAddr Target token address
     * @return sentAmount Encrypted delta actually received
     */
    function _transferTokensToMarket(address from, euint64 amount, address tokenAddr) internal returns (euint64) {
        IERC7984 targetToken = IERC7984(tokenAddr);

        euint64 balBefore = targetToken.confidentialBalanceOf(address(this));
        targetToken.confidentialTransferFrom(from, address(this), amount);
        euint64 balAfter = targetToken.confidentialBalanceOf(address(this));

        euint64 sentAmount = FHE.sub(balAfter, balBefore);
        return sentAmount;
    }

    /**
     * @dev Confidential push: transfer encrypted `amount` of `tokenAddr` from this market to `to`.
     *      Returns the actual encrypted amount sent (handles fee-on-transfer tokens).
     * @param to        Recipient address
     * @param amount    Encrypted amount to send
     * @param tokenAddr Token address
     * @return sentAmount Encrypted delta actually sent (balBefore - balAfter)
     */
    function _transferTokensFromMarket(address to, euint64 amount, address tokenAddr) internal returns (euint64) {
        IERC7984 targetToken = IERC7984(tokenAddr);

        euint64 balBefore = targetToken.confidentialBalanceOf(address(this));
        targetToken.confidentialTransfer(to, amount);
        euint64 balAfter = targetToken.confidentialBalanceOf(address(this));

        euint64 sentAmount = FHE.sub(balBefore, balAfter);
        return sentAmount;
    }

    /**
     * @dev Returns the 1e6-scaled quote of "collateral units per 1 debt unit".
     *      For EURtoUSD markets, inverts USD/EUR (ceil) to get EUR/USD; for USDtoEUR uses raw USD/EUR.
     * @return price6 Collateral units per 1 debt unit (1e6 scale)
     */
    function _getPrice() internal view returns (uint128) {
        // Oracle returns USD per 1 EUR (USD/EUR), 1e6
        uint128 raw = oracle.price6();

        if (direction == Direction.EURtoUSD) {
            //need EUR per 1 USD -> invert(USD/EUR)
            uint256 inv = _ceilDivMul(1_000_000_000_000, 1, raw); // ceil(1e12 * 1 / raw)
            require(inv <= type(uint128).max, "PRICE_OVERFLOW");
            return uint128(inv);
        } else {
            //USDtoEUR: need USD per 1 EUR -> use raw
            return raw;
        }
    }

    /**
     * @notice Update per-year APRs (1e6 scale) used for index accrual.
     * @param brPerSec6 Borrow APR per second (1e6)
     * @param srPerSec6 Supply APR per second (1e6)
     */
    function setRates(uint64 brPerSec6, uint64 srPerSec6) external onlyRateRelayer {
        borrowApr6 = brPerSec6;
        supplyApr6 = srPerSec6;
        emit RatesUpdated(brPerSec6, srPerSec6);
    }

    /**
     * @notice Accrue borrow/supply indices up to the current timestamp.
     *         Emits {Accrued} if an accrual occurs.
     */
    function updateIndexes() public {
        uint64 dt = uint64(block.timestamp) - lastAccrualTs;
        if (dt == 0) return;
        // idx *= (1 + APR * dt / YEAR) ; APR is 1e6-scaled per-year
        borrowIndex6 = _acc(borrowIndex6, borrowApr6, dt);
        supplyIndex6 = _acc(supplyIndex6, supplyApr6, dt);
        lastAccrualTs = uint64(block.timestamp);
        emit Accrued(borrowIndex6, supplyIndex6);
    }

    /**
     * @dev Pure APR accrual step.
     * @param idx6 Current index (1e6)
     * @param apr6 APR per year (1e6)
     * @param dt   Elapsed seconds
     * @return New index after accrual
     */
    function _acc(uint128 idx6, uint64 apr6, uint64 dt) internal pure returns (uint128) {
        // idx_new = idx * (1 + APR * dt / YEAR)
        uint256 inc = (uint256(idx6) * uint256(apr6) * uint256(dt)) / (1_000_000 * SECONDS_PER_YEAR);
        return uint128(uint256(idx6) + inc);
    }

    /**
     * @dev Computes the encrypted max borrow allowed by collateral at current price and indices.
     *      Allows the result to the user and caches it in {UserPos.maxBorrow}.
     * @param user Address for which to compute
     * @return eMax Encrypted max borrow (1e6)
     */
    function _maxBorrowFromCollat(address user) internal returns (euint64) {
        updateIndexes();

        uint128 price6 = _getPrice();
        uint256 userIdx = (pos[user].userBorrowIndex6 == 0) ? borrowIndex6 : pos[user].userBorrowIndex6;

        uint256 idxRatio6 = _ceilDivMul(uint256(borrowIndex6), 1_000_000, userIdx);

        uint256 den = _ceilDivMul(uint256(price6), idxRatio6, 1_000_000);
        require(den > 0, "DEN_ZERO");

        uint256 denAdj = _ceilDivMul(den, uint256(10_000 + HYST_BPS), 10_000); // 1e6
        require(denAdj <= type(uint128).max, "DEN_OVF");

        if (!FHE.isInitialized(pos[user].eCollat)) {
            pos[user].eCollat = FHE.asEuint64(0);
            FHE.allowThis(pos[user].eCollat);
            FHE.allow(pos[user].eCollat, user);
        }
        if (!FHE.isInitialized(pos[user].eDebt)) {
            pos[user].eDebt = FHE.asEuint64(0);
            FHE.allowThis(pos[user].eDebt);
            FHE.allow(pos[user].eDebt, user);
        }

        euint128 num = FHE.mul(FHE.asEuint128(pos[user].eCollat), uint128(LT_collat6));
        euint64 eMax = FHE.asEuint64(FHE.div(num, uint128(denAdj)));

        // Headroom = max(0, eMax - eDebt)
        ebool underflow = FHE.gt(pos[user].eDebt, eMax);
        euint64 headroom = FHE.select(underflow, FHE.asEuint64(0), FHE.sub(eMax, pos[user].eDebt));

        pos[user].maxBorrow = headroom;
        FHE.allowThis(pos[user].maxBorrow);
        FHE.allow(pos[user].maxBorrow, user);

        return headroom;
    }

    /**
     * @notice Convenience method to expose the latest encrypted maxBorrow to the caller.
     *         (The encrypted value is allowed to the user for off-chain decryption.)
     */
    function maxBorrow() public {
        _maxBorrowFromCollat(msg.sender);
    }

    /**
     * @notice Folds accrued interest into the user's encrypted principal via index ratio.
     *         Then snapshots userBorrowIndex6 to the current index.
     * @param user The account to update
     */
    function updateDebtInterest(address user) public {
        updateIndexes();

        UserPos storage p = pos[user];
        uint256 userIdx = (p.userBorrowIndex6 == 0) ? uint256(borrowIndex6) : uint256(p.userBorrowIndex6);

        if (userIdx != uint256(borrowIndex6)) {
            uint256 idxRatio6 = (uint256(borrowIndex6) * 1_000_000) / userIdx; // 1e6

            // grown = eDebt * idxRatio6 / 1e6
            euint128 grown = FHE.mul(FHE.asEuint128(p.eDebt), uint128(idxRatio6));
            p.eDebt = FHE.asEuint64(FHE.div(grown, uint128(1_000_000)));
        }

        p.userBorrowIndex6 = borrowIndex6;
    }

    /**
     * @notice Requests a factor refresh for `user` (A = s*collat*LT, B = s*debt).
     *         Emits {decryptionRequested}. Blocks state-changing ops via {userPosUTD}.
     * @param user Address whose factors are refreshed
     */
    function refreshMarketFactors(address user) public {
        if (!FHE.isInitialized(pos[user].eCollat)) {
            pos[user].eCollat = FHE.asEuint64(0);
            FHE.allowThis(pos[user].eCollat);
            FHE.allow(pos[user].eCollat, user);
        }

        if (!FHE.isInitialized(pos[user].eDebt)) {
            pos[user].eDebt = FHE.asEuint64(0);
            FHE.allowThis(pos[user].eDebt);
            FHE.allow(pos[user].eDebt, user);
        }

        pos[user].secret = _generateRNG(0, 27);
        FHE.allowThis(pos[user].secret);
        FHE.allow(pos[user].secret, user);

        euint64 eCollat = pos[user].eCollat;
        euint64 eDebt = pos[user].eDebt;
        euint32 eSecret = pos[user].secret;

        euint128 uncompleteUAFactor = FHE.mul(FHE.asEuint128(eSecret), FHE.asEuint128(eCollat));
        euint128 uBFactor = FHE.mul(FHE.asEuint128(eSecret), FHE.asEuint128(eDebt));

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(uncompleteUAFactor);
        cts[1] = FHE.toBytes32(uBFactor);

        uint256 requestID = FHE.requestDecryption(cts, this.refreshMarketFactorsCallback.selector);
        factorDecBundle[requestID] = user;

        pos[user].updatePending = true;

        emit decryptionRequested(user, block.number, requestID);
    }

    /**
     * @notice Decryption callback to finalize A and B and clear updatePending.
     * @param requestID        Decryption request id
     * @param cleartexts       ABI-encoded (uncompleteUAFactor, uBFactor)
     * @param decryptionProof  Signature proof
     */
    function refreshMarketFactorsCallback(
        uint256 requestID,
        bytes memory cleartexts,
        bytes memory decryptionProof
    ) external {
        FHE.checkSignatures(requestID, cleartexts, decryptionProof);

        (uint128 uncompleteUAFactor, uint128 uBFactor) = abi.decode(cleartexts, (uint128, uint128));

        address user = factorDecBundle[requestID];

        uint256 uAFactor = uint256(uncompleteUAFactor) * uint256(LT_collat6);

        pos[user].A = uAFactor;
        pos[user].B = uint256(uBFactor);
        pos[user].updatePending = false;

        bool open = (pos[user].B != 0);
        bool listed = _activeBorrowers.contains(user);

        if (open && !listed) {
            _activeBorrowers.add(user);
            hasOpenDebt[user] = true;
        } else if (!open && listed) {
            _activeBorrowers.remove(user);
            hasOpenDebt[user] = false;
        }

        emit marketFactorsRefreshed(user, requestID, block.number, pos[user].A, pos[user].B);
    }

    /**
     * @notice Returns the 1e6-scaled quote of collateral seized per 1 debt unit repaid.
     *         seizePerUnit6 = price6 * (1 + LIQ_BONUS_BPS/10000)
     * @return 1e6-scaled "collateral units per debt unit"
     */
    function liquidationSeizePerUnit6() public view returns (uint128) {
        uint128 price6 = _getPrice(); // collat per 1 debt, 1e6
        uint256 v = (uint256(price6) * uint256(10_000 + LIQ_BONUS_BPS)) / 10_000;
        require(v <= type(uint128).max, "SEIZE_RATE_OVF");
        return uint128(v);
    }

    /**
     * @notice Public liquidatability check using only public scalars and factors.
     *         A = s * collat * LT ; RHS = B * price6 * idxRatio6 (with hysteresis).
     * @param u User to check
     * @return True if position is liquidatable
     */
    function isLiquidatablePublic(address u) public view returns (bool) {
        UserPos memory p = pos[u];
        if (p.B == 0) return false;

        uint128 price6 = _getPrice();
        uint256 userIdx = (p.userBorrowIndex6 == 0) ? borrowIndex6 : p.userBorrowIndex6;
        uint256 idxRatio6 = (uint256(borrowIndex6) * 1_000_000) / userIdx;

        uint256 rhs = (((uint256(p.B) * uint256(price6)) / 1_000_000) * idxRatio6) / 1_000_000;

        uint256 rhsWithLT = rhs * uint256(LT_collat6);
        uint256 rhsWithHyst = (rhsWithLT * (10_000 + HYST_BPS)) / 10_000;

        return uint256(p.A) < rhsWithHyst;
    }

    /**
     * @dev Internal deposit of debt asset, mints confidential oToken shares to `user`.
     *      On first-ever deposit, enforces a RESERVE_MIN6 bootstrap kept in the pool.
     *      Requires `debtToken.isOperator(user, address(this))`.
     * @param user   Depositor
     * @param amount Encrypted deposit amount (1e6)
     */
    function _depositDebtAsset(address user, euint64 amount) internal {
        require(debtToken.isOperator(user, address(this)), "Obol must be operator");
        updateIndexes();

        FHE.allowTransient(amount, debtTokenAddress);
        euint64 receivedAmount = _transferTokensToMarket(user, amount, debtTokenAddress);

        if (!bootstrapDone) {
            ebool leMin = FHE.le(receivedAmount, FHE.asEuint64(RESERVE_MIN6));
            euint64 afterReserve = FHE.select(
                leMin,
                FHE.asEuint64(0),
                FHE.sub(receivedAmount, FHE.asEuint64(RESERVE_MIN6))
            );

            // shares = afterReserve * 1e6 / supplyIndex6
            euint64 eShares_ = FHE.asEuint64(
                FHE.div(FHE.mul(FHE.asEuint128(afterReserve), uint128(1_000_000)), supplyIndex6)
            );

            _mint(user, eShares_);
            bootstrapDone = true; // we’ve established the reserve floor
            return;
        }
        // mint oToken shares: shares = amount * 1e6 / exchangeRate6
        // exchangeRate6 = supplyIndex6
        euint64 eShares = FHE.asEuint64(
            FHE.div(FHE.mul(FHE.asEuint128(receivedAmount), uint128(1_000_000)), supplyIndex6)
        );

        _mint(user, eShares);
    }

    /**
     * @notice Deposit debt-asset and receive confidential oTokens (shares).
     * @param encryptedAmount External encrypted amount
     * @param inputProof      FHE input proof
     */
    function depositDebtAsset(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);

        _depositDebtAsset(msg.sender, amount);
    }

    /**
     * @notice Deposit debt-asset and receive confidential oTokens (shares).
     * @param Amt Encrypted amount
     */
    function depositDebtAsset(euint64 Amt) external {
        _depositDebtAsset(msg.sender, Amt);
    }

    /**
     * @dev Internal withdrawal: pulls oToken shares from `user`, pays underlying up to liquidity,
     *      refunds unredeemed shares, and burns redeemed shares.
     *      Requires `isOperator(user, address(this))` on the oToken (market contract).
     * @param user   Withdrawer
     * @param amount Encrypted share amount requested
     */
    function _withdrawDebtAsset(address user, euint64 amount) internal {
        require(isOperator(user, address(this)), "Obol must be operator");
        updateIndexes();

        FHE.allowTransient(amount, address(this));
        euint64 receivedShareAmount = _transferTokensToMarket(user, amount, address(this));

        // Available underlying above reserve (clamped to zero)
        euint64 poolBal = debtToken.confidentialBalanceOf(address(this));
        ebool gtReserve = FHE.gt(poolBal, FHE.asEuint64(RESERVE_MIN6));
        euint64 poolAvailable = FHE.select(gtReserve, FHE.sub(poolBal, FHE.asEuint64(RESERVE_MIN6)), FHE.asEuint64(0));

        // Cap shares by liquidity: maxRedeemShares = floor(poolAvailable * 1e6 / supplyIndex6)
        euint64 maxRedeemShares = FHE.asEuint64(
            FHE.div(FHE.mul(FHE.asEuint128(poolAvailable), uint128(1_000_000)), supplyIndex6)
        );

        ebool tooManyShares = FHE.gt(receivedShareAmount, maxRedeemShares);
        euint64 redeemShares = FHE.select(tooManyShares, maxRedeemShares, receivedShareAmount);

        // Underlying to pay = floor(redeemShares * supplyIndex6 / 1e6)
        euint64 payUnderlying = FHE.asEuint64(
            FHE.div(FHE.mul(FHE.asEuint128(redeemShares), supplyIndex6), uint128(1_000_000))
        );

        // Refund any leftover shares
        euint64 refundShares = FHE.sub(receivedShareAmount, redeemShares);

        // Send underlying; burn redeemed shares; refund unredeemed shares
        FHE.allowTransient(payUnderlying, address(debtToken));
        _transferTokensFromMarket(user, payUnderlying, address(debtToken));
        _burn(address(this), redeemShares);

        FHE.allowTransient(refundShares, address(this));
        _transferTokensFromMarket(user, refundShares, address(this));
    }

    /**
     * @notice Withdraw underlying by redeeming confidential oTokens (shares).
     * @param encryptedAmount External encrypted share amount
     * @param inputProof      FHE input proof
     */
    function withdrawDebtAsset(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _withdrawDebtAsset(msg.sender, amount);
    }

    /**
     * @notice Withdraw underlying by redeeming confidential oTokens (shares).
     * @param Amt Encrypted share amount
     */
    function withdrawDebtAsset(euint64 Amt) external {
        _withdrawDebtAsset(msg.sender, Amt);
    }

    /**
     * @dev Adds encrypted collateral for `user`, then requests factor refresh.
     *      Requires `collatToken.isOperator(user, address(this))` and fresh oracle.
     * @param user         Account to credit
     * @param collatAmount Encrypted collateral amount
     */
    function _addCollateral(address user, euint64 collatAmount) internal fresh userPosUTD(user) {
        require(collatToken.isOperator(user, address(this)), "Obol must be operator");
        updateIndexes();

        FHE.allowTransient(collatAmount, collatTokenAddress);
        euint64 receivedAmount = _transferTokensToMarket(user, collatAmount, collatTokenAddress);

        pos[user].eCollat = FHE.add(pos[user].eCollat, receivedAmount);
        FHE.allowThis(pos[user].eCollat);
        FHE.allow(pos[user].eCollat, user);

        refreshMarketFactors(user);
    }

    /**
     * @notice Add collateral (encrypted).
     * @param encryptedAmount External encrypted amount
     * @param inputProof      FHE input proof
     */
    function addCollateral(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _addCollateral(msg.sender, amount);
    }

    /**
     * @notice Add collateral (encrypted).
     * @param Amt Encrypted amount
     */
    function addCollateral(euint64 Amt) external {
        _addCollateral(msg.sender, Amt);
    }

    /**
     * @dev Removes encrypted collateral up to the safe bound so HF remains >= threshold.
     *      Uses public A/B with user secret to check `requested * (s*LT) <= excess`.
     *      Requires fresh oracle and up-to-date factors.
     * @param user         Account to debit
     * @param collatAmount Encrypted requested removal
     */
    function _removeCollateral(address user, euint64 collatAmount) internal fresh userPosUTD(user) {
        UserPos storage p = pos[user];
        uint128 price = _getPrice();

        // compute public right hand side (RHS) pieces for the safety threshold
        // user's borrow index snapshot vs current -> how much debt grew
        uint256 userIdx = (p.userBorrowIndex6 == 0) ? borrowIndex6 : pos[user].userBorrowIndex6;
        uint256 idxRatio6 = (uint256(borrowIndex6) * 1_000_000) / userIdx;

        // t (1e6) = B * price * idxRatio / 1e12  → debt side scaled to 1e6
        uint256 t = (((uint256(p.B) * uint256(price)) / 1_000_000) * idxRatio6) / 1_000_000;

        // Minimal A needed with LT and hysteresis
        uint256 A_min = _ceilDivMul(t * uint256(LT_collat6) * 10_000, 1, 10_000 + HYST_BPS);
        uint256 excess = (p.A > A_min) ? (p.A - A_min) : 0;

        euint128 eExcess = FHE.asEuint128(uint128(excess));

        euint128 mulVal = FHE.mul(FHE.asEuint128(p.secret), uint128(LT_collat6));

        // Check: requested * (s*LT) <= excess
        euint128 eNeed = FHE.mul(FHE.asEuint128(collatAmount), mulVal);
        ebool ok = FHE.le(eNeed, eExcess);
        euint64 safeAmount = FHE.select(ok, collatAmount, FHE.asEuint64(0));

        FHE.allowTransient(safeAmount, collatTokenAddress);
        euint64 sentAmount = _transferTokensFromMarket(user, safeAmount, address(collatToken));

        pos[user].eCollat = FHE.sub(p.eCollat, sentAmount);
        FHE.allowThis(pos[user].eCollat);
        FHE.allow(pos[user].eCollat, user);

        refreshMarketFactors(user);
    }

    /**
     * @notice Remove collateral (encrypted), clamped to a safe amount.
     * @param encryptedAmount External encrypted requested amount
     * @param inputProof      FHE input proof
     */
    function removeCollateral(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _removeCollateral(msg.sender, amount);
    }

    /**
     * @notice Remove collateral (encrypted), clamped to a safe amount.
     * @param Amt Encrypted requested amount
     */
    function removeCollateral(euint64 Amt) external {
        _removeCollateral(msg.sender, Amt);
    }

    /**
     * @dev Borrows debt-asset up to the encrypted max, transfers actual received to user,
     *      and updates encrypted principal. Triggers factor refresh.
     *      Requires fresh oracle and up-to-date factors.
     * @param user         Borrower
     * @param wantedAmount Encrypted requested amount
     */
    function _borrow(address user, euint64 wantedAmount) internal fresh userPosUTD(user) {
        updateDebtInterest(user);

        euint64 maxBorrow_ = _maxBorrowFromCollat(user);

        ebool isTooMuch = FHE.gt(wantedAmount, maxBorrow_);
        euint64 licitAmount = FHE.select(isTooMuch, maxBorrow_, wantedAmount);

        FHE.allowTransient(licitAmount, address(debtToken));
        euint64 sentAmount = _transferTokensFromMarket(user, licitAmount, address(debtToken));
        pos[user].eDebt = FHE.add(pos[user].eDebt, sentAmount);

        FHE.allowThis(pos[user].eDebt);
        FHE.allow(pos[user].eDebt, user);

        if (!_activeBorrowers.contains(user)) {
            _activeBorrowers.add(user);
            hasOpenDebt[user] = true;
        }

        refreshMarketFactors(user);
    }

    /**
     * @notice Borrow debt-asset (encrypted).
     * @param encryptedAmount External encrypted requested amount
     * @param inputProof      FHE input proof
     */
    function borrow(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _borrow(msg.sender, amount);
    }

    /**
     * @notice Borrow debt-asset (encrypted).
     * @param Amt Encrypted requested amount
     */
    function borrow(euint64 Amt) external {
        _borrow(msg.sender, Amt);
    }

    /**
     * @dev Repays encrypted debt (overpay is clamped to outstanding), pulls actual received
     *      and reduces encrypted principal. Triggers factor refresh.
     *      Requires fresh oracle and up-to-date factors.
     * @param user   Payer
     * @param amount Encrypted repay amount (max)
     */
    function _repay(address user, euint64 amount) internal fresh userPosUTD(user) {
        updateDebtInterest(user);

        ebool overpay = FHE.gt(amount, pos[user].eDebt);
        euint64 licitAmount = FHE.select(overpay, pos[user].eDebt, amount);

        FHE.allowTransient(licitAmount, address(debtToken));
        euint64 receivedAmount = _transferTokensToMarket(user, licitAmount, address(debtToken));

        pos[user].eDebt = FHE.sub(pos[user].eDebt, receivedAmount);
        FHE.allowThis(pos[user].eDebt);
        FHE.allow(pos[user].eDebt, user);

        refreshMarketFactors(user);
    }

    /**
     * @notice Repay debt (encrypted).
     * @param encryptedAmount External encrypted amount
     * @param inputProof      FHE input proof
     */
    function repay(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _repay(msg.sender, amount);
    }

    /**
     * @notice Repay debt (encrypted).
     * @param Amt Encrypted amount
     */
    function repay(euint64 Amt) external {
        _repay(msg.sender, Amt);
    }

    /**
     * @dev Liquidates `user` by pulling encrypted repay from `liquidator`.
     *      Repay is clamped to outstanding, seize is computed from actual received and capped by collateral.
     *      Seized collateral is queued and must be claimed in a separate step.
     *      Requires fresh oracle and up-to-date factors; reverts if healthy.
     * @param liquidator  Address paying the repay
     * @param user        Victim
     * @param repayAmount Encrypted repay amount
     */
    function _liquidate(address liquidator, address user, euint64 repayAmount) internal fresh userPosUTD(user) {
        require(isLiquidatablePublic(user), "HEALTHY");
        updateDebtInterest(user);

        UserPos storage p = pos[user];

        // clamp to outstanding encrypted debt
        ebool overDebt = FHE.gt(repayAmount, p.eDebt);
        euint64 licitRepay = FHE.select(overDebt, p.eDebt, repayAmount);

        FHE.allowTransient(licitRepay, address(debtToken));
        euint64 receivedRepay = _transferTokensToMarket(liquidator, licitRepay, address(debtToken));

        p.eDebt = FHE.sub(p.eDebt, receivedRepay);
        FHE.allowThis(p.eDebt);
        FHE.allow(p.eDebt, user);

        // compute seize from actual received
        uint128 perUnit6 = liquidationSeizePerUnit6();
        euint128 prod = FHE.mul(FHE.asEuint128(receivedRepay), perUnit6);
        euint64 seizeFromRecv = FHE.asEuint64(FHE.div(prod, uint128(1_000_000)));

        // cap seize by available encrypted collateral
        ebool overCollatNow = FHE.gt(seizeFromRecv, p.eCollat);
        euint64 finalSeize = FHE.select(overCollatNow, p.eCollat, seizeFromRecv);

        p.eCollat = FHE.sub(p.eCollat, finalSeize);
        FHE.allowThis(p.eCollat);
        FHE.allow(p.eCollat, user);

        pendingLiquidations[user][liquidator] = PendingLiqStruct({seizedCollat: finalSeize, exists: true});

        FHE.allowThis(pendingLiquidations[user][liquidator].seizedCollat);

        emit LiquidationQueued(user, liquidator, block.number);
    }

    /**
     * @notice Liquidate a target user with an encrypted repay amount.
     * @param targetUser      Victim
     * @param encryptedAmount External encrypted repay amount
     * @param inputProof      FHE input proof
     */
    function liquidate(address targetUser, externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 amount = FHE.fromExternal(encryptedAmount, inputProof);
        _liquidate(msg.sender, targetUser, amount);
    }

    /**
     * @notice Liquidate a target user with an encrypted repay amount.
     * @param targetUser Victim
     * @param Amt        Encrypted repay amount
     */
    function liquidate(address targetUser, euint64 Amt) external {
        _liquidate(msg.sender, targetUser, Amt);
    }

    /**
     * @notice Claims previously seized collateral from a queued liquidation.
     *         Transfers encrypted collateral to the caller and refreshes victim factors.
     * @param user Victim whose seized collateral was queued
     */
    function claimLiquidation(address user) external {
        PendingLiqStruct memory pl = pendingLiquidations[user][msg.sender];
        require(pl.exists, "NO_PENDING");

        FHE.allowTransient(pl.seizedCollat, address(collatToken));
        _transferTokensFromMarket(msg.sender, pl.seizedCollat, address(collatToken));

        delete pendingLiquidations[user][msg.sender];

        refreshMarketFactors(user);

        emit LiquidationClaimed(user, msg.sender, block.number);
    }
}
