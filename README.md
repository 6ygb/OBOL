
# Obol - Confidential lending protocol

**A single‑pair lending protocol (EUR⇄USD) that keeps user balances fully encrypted on‑chain using Zama’s FHEVM.**  
Borrowing and liquidations are driven by **public static factors** and a **public price**; **no per‑epoch per‑user recomputation** is needed. Lenders earn yield via **index accrual**. All amounts and user balances remain confidential. Liquidation are done without revealing any informations about the user's postion (debt and collat).

> Built on Zama’s [fhEVM](https://github.com/zama-ai/fhevm). This document explains how the provided `ConfLendMarket` contract works, field‑by‑field and function‑by‑function, with 6‑decimals math throughout.

---

## Table of Contents

- [Design Overview](#design-overview)
- [Core Math: A/B Factors, Price, Indexes](#core-math-ab-factors-price-indexes-and-health-factor-hf)
- [Data Structures](#data-structures)
- [Parameters & Constants](#parameters--constants)
- [Lifecycle & Flows](#lifecycle--flows)
  - [Lenders: deposit / withdraw debt asset](#lenders-deposit--withdraw-debt-asset)
  - [Borrowers: add / remove collateral, borrow / repay](#borrowers-add--remove-collateral-borrow--repay)
  - [Liquidations (permissionless)](#liquidations-permissionless)
- [Public Health Check](#public-health-check)
- [Rate Accrual & APR](#rate-accrual--apr)
- [Oracle & Price Semantics](#oracle--price-semantics)
- [Event Reference](#event-reference)
- [Key Functions - Code Snippets & Commentary](#key-functions---code-snippets--commentary)
- [ OBOL - Tasks & Deployment Guide](#obol---tasks--deployment-guide)
- [License](#license)

---

## Design Overview

- **One contract per direction** (via `Direction` enum at construction):
  - `EURtoUSD`: debt asset is **EUR**, collateral asset is **USD**.
  - `USDtoEUR`: debt asset is **USD**, collateral asset is **EUR**.
- **Encrypted balances** with fhEVM types (`euint64`) for collateral and debt principals.
- **Static public factors** per user:
  - `A = s * collat * LT` (scaled 1e6)
  - `B = s * debtPrincipal` (scaled 1e6)  
  A fresh encrypted secret `s` (per user) is generated and kept on‑chain (encrypted). Factors are refreshed **only** when a user modifies their position or gets liquidated.
- **HF off‑chain:** Watchers compute Health Factor using only **A**, **B**, the **public price** and the **public borrow index ratio**. There’s no per‑epoch FHE recompute.
- **Lenders** supply the **debt asset** (the asset borrowers borrow) and receive confidential **oTokens** (this contract itself extends `ERC7984` to act as the share token).
- **Liquidations**: Anyone can liquidate an unhealthy account using a public check; the seized collateral is queued and then claimed by the liquidator.

Everything is **6‑decimals** (the same scale as your confidential tokens).

---

## Core Math: A/B Factors, Price, Indexes, and Health Factor (HF)

### Static factors

For each user $`u`$, the lending engine maintains **two public, static scalars** $`A_u`$ and $`B_u`$ that encode the user’s position in a *homomorphically masked* form.

```math
A_u = s_u \cdot C_u \cdot LT_{\text{collat,6}}
```
```math
B_u = s_u \cdot D_u
```

Where:

| Symbol | Meaning |
|:--|:--|
| $`s_u`$ | user’s **encrypted random secret**, drawn on-chain as an `euint32` |
| $`C_u`$ | encrypted collateral amount (confidential balance) |
| $`D_u`$ | encrypted debt principal |
| $`LT_{\text{collat,6}}`$ | liquidation threshold (e.g. 0.85 × 1e6 = 850000) |

Thus, $`A_u`$ and $`B_u`$ are **clear (public)** values that depend linearly on an unknown secret $`s_u`$. Because $`s_u`$ is unique and encrypted for each user, an observer can only see the *ratios* between $`A_u`$ and $`B_u`$, not the underlying collateral or debt values.

> **When do A/B change?**
> - **When the user’s encrypted position changes:** add/remove collateral, borrow/repay, or liquidation.  
> - **They remain static** while only prices and indexes evolve - minimizing on-chain FHE recomputation.

---

### Price (1e6 scale)

At every moment, the oracle provides a single price quote $`P(t)`$ representing how many **collateral units** are equivalent to **1 debt unit**.

```solidity
function _getPrice() internal view returns (uint128) {
    uint128 rawPrice = oracle.price6(); // USD per 1 EUR (1e6 scale)
    if (direction == Direction.EURtoUSD) {
        uint256 numerator = 1_000_000_000_000; // 1e12
        uint256 inv = (numerator + rawPrice - 1) / rawPrice; // ceil division
        return uint128(inv);
    } else {
        return rawPrice;
    }
}
```

Formally:
```math
P(t) =
\begin{cases}
\frac{1}{\text{USD/EUR}(t)} & \text{for EUR→USD (collateral = USD, debt = EUR)} \\
\text{USD/EUR}(t) & \text{for USD→EUR (collateral = EUR, debt = USD)}
\end{cases}
```

---

### Indexes (1e6 scale)

To account for time-dependent interest, the protocol maintains **accrual indexes** that scale all positions proportionally:

- $`I_b(t)`$: **borrow index** (starts at $`1.000.000`$)
- $`I_s(t)`$: **supply index** (starts at $`1.000.000`$)

Each index evolves continuously according to the current annualized APR ($`\text{APR}_b, \text{APR}_s `$), as:

```math
I_b(t+\Delta t) = I_b(t) \times \left( 1 + \frac{\text{APR}_b \cdot \Delta t}{10^6 \cdot T_{\text{year}}} \right)
```

```math
I_s(t+\Delta t) = I_s(t) \times \left( 1 + \frac{\text{APR}_s \cdot \Delta t}{10^6 \cdot T_{\text{year}}} \right)
```

In Solidity:
```solidity
uint256 inc = (idx6 * apr6 * dt) / (1_000_000 * SECONDS_PER_YEAR);
```

When a user borrows, their debt evolves proportionally to:
```math
D_u(t) = D_u(t_0) \cdot \frac{I_b(t)}{I_{b,u}(t_0)}
```
where $`I_{b,u}(t_0)`$ is the snapshot at the time of the user’s last update.

---

### Health Factor (HF)

The **Health Factor** measures the ratio between a user’s adjusted collateral value and their current debt exposure.

Conceptually:
```math
HF_u(t) = \frac{\text{collateral value (adjusted by LT)}}{\text{debt value}}
```

Using the protocol’s masked scalars $`A_u`$ and $`B_u`$, this becomes:

```math
HF_u(t) =
\frac{A_u}{B_u \cdot P(t) \cdot \frac{I_b(t)}{I_{b,u}(t_0)}}
```

Because $`A_u = s_u \cdot C_u \cdot LT`$ and $`B_u = s_u \cdot D_u`$:

```math
HF_u(t)
= \frac{s_u \cdot C_u \cdot LT}
{s_u \cdot D_u \cdot P(t) \cdot \frac{I_b(t)}{I_{b,u}(t_0)}}
= \frac{C_u \cdot LT}
{D_u \cdot P(t) \cdot \frac{I_b(t)}{I_{b,u}(t_0)}}
```

The random secret \( s_u \) **cancels out**, meaning the health factor can be fully computed **without knowing $`s_u`$**, $`C_u`$, or $`D_u`$.  
All the required data - $`A_u`$, $`B_u`$, $`P(t)`$, and the index ratio - are **public**.

---

### Interpretation

- $`HF > 1`$: position is healthy (collateral sufficiently covers debt).  
- $`HF = 1`$: user is exactly at the liquidation threshold.  
- $`HF < 1`$: position becomes liquidatable.

In Solidity, `isLiquidatablePublic()` performs the inequality check corresponding to:

```math
A_u < B_u \cdot P(t) \cdot \frac{I_b(t)}{I_{b,u}(t_0)} \cdot LT \cdot (1 + \text{HYST})
```

---

### Why HF Computation is Private Yet Verifiable

Even though anyone can compute `HF_u(t)` from public values, they **cannot deduce** the user’s actual collateral or debt amounts because both are scaled by an **unknown, user-specific secret $`s_u`$**:

```math
A_u = s_u \cdot C_u \cdot LT
\quad , \quad
B_u = s_u \cdot D_u
```

Without $`s_u`$, the absolute magnitude of $`C_u`$ or $`D_u`$ remains hidden.  
Only the *relative ratios* across assets (if multiple) could be inferred - not the totals.

Thus:
- **Risk visibility** (HF, liquidatability) is public.
- **Wealth confidentiality** (actual holdings) is preserved.

---

## Data Structures

```solidity
struct UserPos {
    euint64 eCollat;          // encrypted collateral balance
    euint64 eDebt;            // encrypted debt principal
    uint256 A;                // s * collat * LT (public)
    uint256 B;                // s * debt principal (public)
    uint64  posEpoch;         // bumps when A/B recomputed
    uint128 userBorrowIndex6; // snapshot for interest folding
    euint32 secret;           // encrypted per-user random secret s
    bool    updatePending;    // locks while factors are refreshing
    euint64 maxBorrow;        // encrypted “you can borrow up to” (allowed to user)
}

struct PendingLiqStruct {
    euint64 seizedCollat;     // encrypted collateral queued for a liquidator
    bool    exists;
}
```

- `pos[u]` stores all per‑user state.
- `pendingLiquidations[user][liquidator]` queues seized collateral for later claim.

---

## Parameters & Constants

- `LT_collat6` - liquidation threshold for the collateral (e.g., `850000` for 85%).
- `LIQ_BONUS_BPS` - liquidation incentive in bps (e.g., `500` = 5%).
- `HYST_BPS` - public hysteresis in bps to avoid flapping around HF≈1 (default `100` = 1%).
- `borrowApr6`, `supplyApr6` - per‑year APRs, 1e6 scale (set by `rateRelayer`).
- `borrowIndex6`, `supplyIndex6` - indices starting at `1_000_000`.
- `RESERVE_MIN6` - minimum debt‑asset reserve kept in the pool to preserve liquidity for withdrawals.
- `CLOSE_FACTOR_BPS` - maximum debt percentage a liquidator may repay per call (present as a constant; use as policy if desired).

---

## Lifecycle & Flows

### Lenders: deposit / withdraw debt asset

Lenders provide the **debt asset** (EUR in `EURtoUSD`, USD in `USDtoEUR`) and receive confidential **oTokens** (this `ERC7984`) that appreciate as `supplyIndex6` grows.

**Deposit (mint oTokens):**
```solidity
function depositDebtAsset(externalEuint64 encryptedAmount, bytes calldata proof) external
```
1. Pull encrypted amount from the lender.  
2. Mint **oTokens** at:  
   `shares = amount * 1e6 / supplyIndex6` (all 1e6‑scaled).  
3. On the very first deposit, keep a `RESERVE_MIN6` buffer in the pool.

**Withdraw (burn oTokens):**
```solidity
function withdrawDebtAsset(externalEuint64 encryptedAmount, bytes calldata proof) external
```
1. Burn requested shares (or clamp by liquidity).  
2. Pay out underlying: `underlying = shares * supplyIndex6 / 1e6`.  
3. Enforce the `RESERVE_MIN6` floor.

> oTokens are fully confidential (encrypted share amounts), since `ConfLendMarket` inherits `ERC7984` and mints/burns using `euint64` amounts.

---

### Borrowers: add / remove collateral, borrow / repay

#### Add collateral
```solidity
function addCollateral(externalEuint64 encryptedAmount, bytes calldata proof) external
```
- Pull encrypted collateral from user and increase `eCollat`.
- Trigger **factor refresh** to recompute public `A` and `B` with a fresh secret (see below).

#### Remove collateral (clamped to safety)
```solidity
function removeCollateral(externalEuint64 encryptedAmount, bytes calldata proof) external
```
- Using **public** scalars (A, B, price, indexes), compute how much “safety buffer” in A remains.
- Encrypted check: `requested * (s*LT) <= excess` using the encrypted `secret` and LT.  
- Transfer the **safe** amount; refresh factors.

#### Borrow debt asset (clamped by max borrow)
```solidity
function borrow(externalEuint64 encryptedAmount, bytes calldata proof) external
```
- Fold interest into encrypted principal (`updateDebtInterest`), keeping balances consistent.
- Compute encrypted **maxBorrow** from current collateral via:
  ```
  maxBorrowDebt ≈ (eCollat * LT) / (price * idxRatio)
  idxRatio = borrowIndex6 / userBorrowIndex6
  ```
- Clamp to that maximum, transfer debt to user, increase `eDebt`, refresh factors.

#### Repay
```solidity
function repay(externalEuint64 encryptedAmount, bytes calldata proof) external
```
- Fold interest, clamp repay to outstanding, pull encrypted repay, reduce `eDebt`, refresh factors.

---

### Liquidations (permissionless)

**Pre‑check (public):**
```solidity
function isLiquidatablePublic(address u) public view returns (bool)
```
Compares `A` to the RHS built from `B`, `price`, `idxRatio`, `LT`, and `HYST_BPS` (see [Public Health Check](#public-health-check)).

**Execute liquidation:**
```solidity
function liquidate(address targetUser, externalEuint64 encryptedAmount, bytes calldata proof) external
```
- Fold interest and clamp `repay` to debt. Pull encrypted repay from the liquidator.
- Compute **seize** in collateral units:
  ```
  perUnit6 = price6 * (1 + LIQ_BONUS_BPS/10000)
  seize = repay * perUnit6 / 1e6
  ```
- Clamp by available `eCollat`, reduce `eDebt`, reduce `eCollat` by `seize`.
- **Queue** the seized collateral in `pendingLiquidations[targetUser][liquidator]`.
- Liquidator later calls:
  ```solidity
  function claimLiquidation(address user) external
  ```
  to receive the encrypted seized collateral transfer; then the victim’s factors are refreshed.

> Seize and repay amounts are never made public. Transfers are confidential; only the **liquidatability** condition is public.

---

## Public Health Check

```solidity
function isLiquidatablePublic(address u) public view returns (bool) {
    UserPos memory p = pos[u];
    if (p.B == 0) return false;

    uint128 price6 = _getPrice();
    uint256 userIdx = (p.userBorrowIndex6 == 0) ? borrowIndex6 : p.userBorrowIndex6;
    uint256 idxRatio6 = (uint256(borrowIndex6) * 1_000_000) / userIdx;

    // debt side with price and index ratio (1e6)
    uint256 rhs = (((uint256(p.B) * uint256(price6)) / 1_000_000) * idxRatio6) / 1_000_000;

    // include LT and hysteresis on RHS
    uint256 rhsWithLT   = rhs * uint256(LT_collat6);
    uint256 rhsWithHyst = (rhsWithLT * (10_000 + HYST_BPS)) / 10_000;

    return uint256(p.A) < rhsWithHyst;
}
```

Interpretation: **liquidate if** the public `A` (masked collateral * LT) is **less than** the debt‑side expression inflated by LT and hysteresis at the current price and index ratio.

---

## Rate Accrual & APR

APR parameters are **per year** at 1e6 scale (`borrowApr6`, `supplyApr6`) and are set by a `rateRelayer`.

```solidity
function setRates(uint64 brPerSec6, uint64 srPerSec6) external onlyRateRelayer
```

Indexes update with wall‑clock time:

```solidity
function updateIndexes() public {
    uint64 dt = uint64(block.timestamp) - lastAccrualTs;
    if (dt == 0) return;
    borrowIndex6 = _acc(borrowIndex6, borrowApr6, dt);
    supplyIndex6 = _acc(supplyIndex6, supplyApr6, dt);
    lastAccrualTs = uint64(block.timestamp);
}
function _acc(uint128 idx6, uint64 apr6, uint64 dt) internal pure returns (uint128) {
    // idx_new = idx * (1 + APR * dt / YEAR)
    uint256 inc = (uint256(idx6) * uint256(apr6) * uint256(dt)) / (1_000_000 * SECONDS_PER_YEAR);
    return uint128(uint256(idx6) + inc);
}
```

Borrower debt growth is folded into the encrypted principal on **user touch** via:
```
eDebt := eDebt * (borrowIndex6 / userBorrowIndex6)
userBorrowIndex6 := borrowIndex6
```

Supply APY flows into the **oToken exchange rate** (`supplyIndex6`).

---

## Oracle & Price Semantics

Obol works with a price oracle. This price oracle must be fed by a **relayer** (the oracle deployer).
The price data should come from a reliable source. In the demo web-app, the oracle gets its data from the associated CAMM pair.

```solidity
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

```

The market converts this into the **collateral per debt** quote (1e6 scale) used in risk and liquidation math via `_getPrice()`.

> All state‑changing user actions that depend on price are guarded by `fresh` (oracle staleness check).

---

## Event Reference

- `RatesUpdated(uint64 brPerSec6, uint64 srPerSec6)` - APRs updated.
- `Accrued(uint128 borrowIndex6, uint128 supplyIndex6)` - indices updated.
- `decryptionRequested(address user, uint256 blockNumber, uint256 requestID)` - factor refresh requested.
- `marketFactorsRefreshed(address user, uint256 requestID, uint256 blockNumber, uint256 A, uint256 B)` - A/B refreshed.
- `LiquidationQueued(address user, address liquidator, uint256 blockNumber)` - a liquidation seized collateral (queued).
- `LiquidationClaimed(address user, address liquidator, uint256 blockNumber)` - liquidator claimed seized collateral.

---

## Key Functions - Code Snippets & Commentary

### Factor Refresh (A, B)

```solidity
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
  
      emit marketFactorsRefreshed(user, requestID, block.number, pos[user].A, pos[user].B);
    }
```

**What’s happening:**  
- A fresh encrypted secret `s` (generated at each factor refresh) multiplies the encrypted balances to form masked products.  
- Only the masked products are decrypted by the gateway; raw balances remain confidential.  
- `A = (s * collat) * LT_collat6`, `B = s * debt` are finalized and stored **publicly**.

### Max Borrow (encrypted “quote to user”)

```solidity
function _maxBorrowFromCollat(address user) internal returns (euint64) {
    updateIndexes();

    uint128 price6 = _getPrice();
    uint256 userIdx = (pos[user].userBorrowIndex6 == 0) ? borrowIndex6 : pos[user].userBorrowIndex6;
    uint256 idxRatio6 = (uint256(borrowIndex6) * 1_000_000) / userIdx;

    // den = price * idxRatio (1e6 scale)
    uint256 den = (uint256(price6) * idxRatio6) / 1_000_000;

    // eMax ≈ (eCollat * LT) / den
    euint128 num = FHE.mul(FHE.asEuint128(pos[user].eCollat), uint128(LT_collat6));
    euint64  eMax = FHE.asEuint64(FHE.div(num, uint128(den)));

    // Store and allow the encrypted maxBorrow to the user for off-chain decryption
    pos[user].maxBorrow = eMax;
    FHE.allowThis(pos[user].maxBorrow);
    FHE.allow(pos[user].maxBorrow, user);
    return eMax;
}
```

The user can call `maxBorrow()` to have the latest value allowed to them for local decryption.

### Liquidation - seize amount per unit

```solidity
function liquidationSeizePerUnit6() public view returns (uint128) {
    uint128 price6 = _getPrice(); // collat per 1 debt, 1e6
    uint256 v = (uint256(price6) * uint256(10_000 + LIQ_BONUS_BPS)) / 10_000;
    return uint128(v);
}
```

Seize is then `seize = repay * perUnit6 / 1e6`, clamped by current encrypted collateral.

---


## OBOL - Tasks & Deployment Guide

> Hardhat tasks to deploy, operate and inspect **ConfLendMarket** (Obol) with Zama fhEVM.  
> Amounts use **6 decimals** (1e6 scale) across tokens, prices and indices.

---

### Prerequisites

- **Hardhat** with `hardhat-deploy` and the **fhEVM plugin** (`@fhevm/hardhat-plugin`).
- Your network config set (e.g., `--network sepolia`).  
- A signer with funds and permissions to deploy & send txs.

> Tip: when a task mentions *operator*, it refers to **ERC-7984 operator** for confidential transfers (the market/oracle must be set as an operator to move your encrypted funds).

---

### 1) Deploy stack

#### One-shot deployment (tokens + oracle + both markets)
```bash
npx hardhat obol:deploy --network sepolia \
  [--relayer 0xRateRelayer] \
  [--tokenUsd 0xPreExistingUSD] \
  [--tokenEur 0xPreExistingEUR]
```
- If `--tokenUsd/--tokenEur` are omitted, fixture **ConfidentialToken** contracts are deployed.
- Writes all addresses into **`OBOL.json`** (see config section below).

**Artifacts registered:**
- `TokenUSD` (USD ConfidentialToken), `TokenEUR` (EUR ConfidentialToken)
- `ObolPriceOracle`
- `ConfLendMarket_EURtoUSD` and `ConfLendMarket_USDtoEUR` (two directed markets)
- `ConfLendMarket` ABI mirrored for both addresses

---

### 2) Patch defaults (optional)

Update or fix values in `OBOL.json` manually via task:
```bash
npx hardhat obol:set_defaults \
  [--usd 0x...] [--eur 0x...] [--oracle 0x...] \
  [--m1 0x...]  [--m2 0x...]  [--relayer 0x...] \
  [--deadline 86400] \
  --network sepolia
```
- `deadline` is the default operator validity in seconds for `setOperator` tasks.

---

### 3) Faucets & balances

#### Airdrop test funds
```bash
npx hardhat obol:airdrop --network sepolia
```
Claims the example airdrop on both USD and EUR test tokens for the caller.

#### Decrypt & print balances
```bash
npx hardhat obol:get_balances --network sepolia
```
Prints clear **USD, EUR** balances and **oUSD, oEUR** (market share tokens) by decrypting your own ciphertexts via fhEVM CLI.

---

### 4) Operator approvals (confidential tokens)

Allow a spender (market/oracle/escrow) to move your encrypted tokens:
```bash
npx hardhat obol:set_operator \
  --token 0xToken \
  --spender 0xSpender \
  [--seconds 86400] \
  --network sepolia
```
- Sets `setOperator(spender, deadline)` if not already set.  
- Uses `OPERATOR_DEADLINE_SECS` from `OBOL.json` when available.

---

### 5) Oracle controls

#### Push a price (1e6 scale)
```bash
npx hardhat obol:set_price --price6 1100000 --network sepolia
```
Sets e.g. **1.10 USD per 1 EUR**. Epoch is `Date.now()/1000` by default.

#### Read current price
```bash
npx hardhat obol:get_price --network sepolia
```
Prints the last price and timestamp (humanized).

---

### 6) Rates & indexes

#### Set borrow/supply APRs (per-year, 1e6 scale) on both markets
```bash
npx hardhat obol:set_rates --borrow 50000 --supply 15000 --network sepolia
# = 5.0000% borrow APR, 1.5000% supply APR
```
> Requires the **rate relayer** role set during deploy.

#### Inspect current APRs
```bash
npx hardhat obol:get_rates --network sepolia
```

#### Manually accrue indices on both markets
```bash
npx hardhat obol:update_indexes --network sepolia
```
Applies time delta to `borrowIndex6` and `supplyIndex6` immediately.

---

### 7) Market operations

Two directed markets exist:
- `EURtoUSD` : **collateral EUR**, **debt USD**, oToken = **oUSD**
- `USDtoEUR` : **collateral USD**, **debt EUR**, oToken = **oEUR**

> All human amounts are multiplied by `1e6` under the hood.

#### Add collateral (encrypted)
```bash
npx hardhat obol:add_collat \
  --market EURtoUSD \
  --amount 1000 \
  --network sepolia
```
- Ensures the **market** is an **operator** on the **collateral token**.
- Encrypts the amount and calls `addCollateral(bytes32,bytes)`.
- Waits for `marketFactorsRefreshed` (A/B recompute).

#### Remove collateral (clamped by safety)
```bash
npx hardhat obol:remove_collat \
  --market USDtoEUR \
  --amount 250 \
  --network sepolia
```
- Amount is capped so HF stays above the threshold (done under FHE).

#### Deposit debt asset (earn yield → mint oTokens)
```bash
npx hardhat obol:deposit_debt \
  --market EURtoUSD \
  --amount 500 \
  --network sepolia
```
- Ensures **market** is an **operator** on the **debt token** for the caller.
- Mints oTokens at `shares = amount * 1e6 / supplyIndex6`.

#### Withdraw debt asset (redeem oTokens → underlying)
```bash
npx hardhat obol:withdraw_debt \
  --market USDtoEUR \
  --shares 100 \
  --network sepolia
```
- Requires the **market contract to be operator of your oTokens** (the market pulls your shares from you).
- Pays underlying up to pool liquidity above the internal reserve floor.

#### Borrow (encrypted)
```bash
npx hardhat obol:borrow \
  --market EURtoUSD \
  --amount 200 \
  --network sepolia
```
- Computes your **encrypted maxBorrow** under FHE and clamps the request.
- Transfers actual debt tokens; updates encrypted principal; refreshes A/B.

#### Repay (encrypted)
```bash
npx hardhat obol:repay \
  --market USDtoEUR \
  --amount 75 \
  --network sepolia
```
- Market must be **operator on the debt token** to pull the repayment.
- Overpay is clamped to outstanding under FHE; A/B refreshed.

#### Compute & decrypt your max borrow
```bash
npx hardhat obol:max_borrow \
  --market EURtoUSD \
  --network sepolia
```
- Calls `maxBorrow()` then decrypts your own `pos.maxBorrow` handle via fhEVM CLI.

---

### 8) Liquidations

#### Check liquidatability (public)
```bash
npx hardhat obol:is_liq \
  --market EURtoUSD \
  [--user 0xVictim] \
  --network sepolia
```
Uses **public** A, B, price and index ratio; no private data needed.

#### Liquidate (queue seize)
```bash
npx hardhat obol:liquidate \
  --market EURtoUSD \
  --victim 0xVictim \
  --amount 50 \
  --network sepolia
```
- Ensures market is **operator on your debt token** (as liquidator).  
- Repay is clamped to victim’s outstanding encrypted debt; seize is computed with bonus and capped by encrypted collateral.
- Waits for `LiquidationQueued` event.

#### Claim seized collateral
```bash
npx hardhat obol:claim_liquidation \
  --market EURtoUSD \
  --victim 0xVictim \
  --network sepolia
```
- Transfers seized **encrypted collateral** to the liquidator.  
- Prints before/after clear balances by decrypting **your own** ciphertexts.  
- Triggers factor refresh on the victim’s position.

---

### 9) Position & price utilities

#### Dump & decrypt your `UserPos`
```bash
npx hardhat obol:pos --market USDtoEUR --network sepolia
```
Outputs handles for encrypted fields + decrypted values for **your** collat/debt/maxBorrow when available.

#### Effective market price (collateral per 1 debt, 1e6)
```bash
npx hardhat obol:price_effective --market EURtoUSD --network sepolia
```
Uses oracle raw price and market direction (inversion for EUR→USD).

#### Seize rate (collat per 1 repaid debt) + implied bonus
```bash
npx hardhat obol:seize_rate --market USDtoEUR --network sepolia
```
Prints `liquidationSeizePerUnit6` and bonus basis points relative to price.

### 10) Custom price oracle
You can deploy price oracle independently and then provide the address in the deploy task.
```bash
npx hardhat --network sepolia obol:deploy_oracle --relayer 0x94f37a938FC67c3e61cC0dbbeff33373122507ec
-> Oracle address : 0xF0c298A3c3300D89bA610C3a0a968eFa031dD868
```
Then
```bash
 npx hardhat --network sepolia obol:deploy --reset --oracle 0xF0c298A3c3300D89bA610C3a0a968eFa031dD868
```
If your current signer is not the price relayer address on the oracle, the `obol:set_price` task won't work.

### 11) Get oracle address from markets
To check what oracle is currently used by the markets :
```bash
npx hardhat --network sepolia obol:get_oracle_address
```

### 12) Get price relayer address from pracle
To check what is the current price relayer address :
```bash
npx hardhat --network sepolia obol:get_price_relayer
```

---

### OBOL.json (runtime config)

Created/updated by tasks at repo root:
```jsonc
{
  "ORACLE_ADDRESS": "0x...",
  "TOKEN_USD": "0x...",
  "TOKEN_EUR": "0x...",
  "MARKET_EURtoUSD": "0x...",
  "MARKET_USDtoEUR": "0x...",
  "RATE_RELAYER": "0x...",
  "OPERATOR_DEADLINE_SECS": 86400
}
```
- Used by most tasks to resolve addresses & operator deadline defaults.

---

### Notes & Troubleshooting

- **Units**: All amounts and indices are **1e6**-scaled (6 decimals).
- **Event waits**: Tasks like `add_collat`, `borrow`, and liquidations wait for their respective events (e.g., `marketFactorsRefreshed`, `LiquidationQueued`, `LiquidationClaimed`).
- **fhEVM CLI**: Tasks that decrypt your values run `fhevm.initializeCLIApi()` and decrypt **only your own** handles (privacy preserving).

---

## License

- Contract is released under the **BSD 3‑Clause Clear License** (same as your other projects).  
- Dependencies retain their original licenses (e.g., fhEVM / OZ forks).
