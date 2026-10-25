# Proof

Every public claim about Surety points to something that can be checked: a verified contract, a transaction, a test, or a calculation shown in full. [CLAIMS.md](CLAIMS.md) lists the claims with their evidence tier; this page holds the evidence.

## Verified contracts

### Mezo testnet (31611)

All 14 contracts in [`contracts/deployments/31611.json`](../contracts/deployments/31611.json) are verified on Sourcify with an exact match (metadata and bytecode). Checked on 2026-10-24.

| Contract | Address | Sourcify | Explorer |
| --- | --- | --- | --- |
| Surety vault (VaultV2) | `0xdb2526679a0F285aEF9B31507364c4DD8CE59481` | [source](https://repo.sourcify.dev/31611/0xdb2526679a0F285aEF9B31507364c4DD8CE59481) | [explorer](https://explorer.test.mezo.org/address/0xdb2526679a0F285aEF9B31507364c4DD8CE59481) |
| MorphoMarketV1AdapterV2 | `0x3Dc62001022DdeBf0C8963dDEbC584f5d9635c63` | [source](https://repo.sourcify.dev/31611/0x3Dc62001022DdeBf0C8963dDEbC584f5d9635c63) | [explorer](https://explorer.test.mezo.org/address/0x3Dc62001022DdeBf0C8963dDEbC584f5d9635c63) |
| Morpho Blue | `0xF191f133ecCC997D36713A6c4ee64c24E7e261Ef` | [source](https://repo.sourcify.dev/31611/0xF191f133ecCC997D36713A6c4ee64c24E7e261Ef) | [explorer](https://explorer.test.mezo.org/address/0xF191f133ecCC997D36713A6c4ee64c24E7e261Ef) |
| AdaptiveCurveIrm | `0x8Fa08ff73618EC1ac3844a975d5Ee41b96f45028` | [source](https://repo.sourcify.dev/31611/0x8Fa08ff73618EC1ac3844a975d5Ee41b96f45028) | [explorer](https://explorer.test.mezo.org/address/0x8Fa08ff73618EC1ac3844a975d5Ee41b96f45028) |
| CreditVoter | `0x3e9D39CeF152006831574b604435D22fAd631304` | [source](https://repo.sourcify.dev/31611/0x3e9D39CeF152006831574b604435D22fAd631304) | [explorer](https://explorer.test.mezo.org/address/0x3e9D39CeF152006831574b604435D22fAd631304) |
| VoteAllocator | `0x66541B50a2F5bF7cFFcF623Fa02386e282cDe0E9` | [source](https://repo.sourcify.dev/31611/0x66541B50a2F5bF7cFFcF623Fa02386e282cDe0E9) | [explorer](https://explorer.test.mezo.org/address/0x66541B50a2F5bF7cFFcF623Fa02386e282cDe0E9) |
| SuretyPool | `0xEF54E2e74118B0ea58Eb422660cdd902352aB357` | [source](https://repo.sourcify.dev/31611/0xEF54E2e74118B0ea58Eb422660cdd902352aB357) | [explorer](https://explorer.test.mezo.org/address/0xEF54E2e74118B0ea58Eb422660cdd902352aB357) |
| DepositGate | `0x202129dF9f6Ebd83f508bc34D6C20F41fDCa22b2` | [source](https://repo.sourcify.dev/31611/0x202129dF9f6Ebd83f508bc34D6C20F41fDCa22b2) | [explorer](https://explorer.test.mezo.org/address/0x202129dF9f6Ebd83f508bc34D6C20F41fDCa22b2) |
| VeBTCCreditLine | `0x11A87EA0E77261Eedd2C8F2f27B0bB4D6391bE68` | [source](https://repo.sourcify.dev/31611/0x11A87EA0E77261Eedd2C8F2f27B0bB4D6391bE68) | [explorer](https://explorer.test.mezo.org/address/0x11A87EA0E77261Eedd2C8F2f27B0bB4D6391bE68) |
| LoanEscrow implementation | `0x5480eC4D37Fe1eb31793d7FEC4BE6B3Ab3806417` | [source](https://repo.sourcify.dev/31611/0x5480eC4D37Fe1eb31793d7FEC4BE6B3Ab3806417) | [explorer](https://explorer.test.mezo.org/address/0x5480eC4D37Fe1eb31793d7FEC4BE6B3Ab3806417) |
| LinearKinkIrm | `0x3195fe2Ff429DeC76389947c36A093fd14839949` | [source](https://repo.sourcify.dev/31611/0x3195fe2Ff429DeC76389947c36A093fd14839949) | [explorer](https://explorer.test.mezo.org/address/0x3195fe2Ff429DeC76389947c36A093fd14839949) |
| StressedPriceSource | `0xf57424252c4D4EB015c0f1851a4D64EF5D84150F` | [source](https://repo.sourcify.dev/31611/0xf57424252c4D4EB015c0f1851a4D64EF5D84150F) | [explorer](https://explorer.test.mezo.org/address/0xf57424252c4D4EB015c0f1851a4D64EF5D84150F) |
| SkipPriceSource | `0x5b2889271154adD90BC4b33EaE3Bb5dDC09d6BFC` | [source](https://repo.sourcify.dev/31611/0x5b2889271154adD90BC4b33EaE3Bb5dDC09d6BFC) | [explorer](https://explorer.test.mezo.org/address/0x5b2889271154adD90BC4b33EaE3Bb5dDC09d6BFC) |
| MorphoPriceOracle | `0x7fe38beE73412FFC05263606Bc0caD7bB7632e06` | [source](https://repo.sourcify.dev/31611/0x7fe38beE73412FFC05263606Bc0caD7bB7632e06) | [explorer](https://explorer.test.mezo.org/address/0x7fe38beE73412FFC05263606Bc0caD7bB7632e06) |

To check one yourself:

```sh
curl -s https://sourcify.dev/server/v2/contract/31611/0xEF54E2e74118B0ea58Eb422660cdd902352aB357 | grep -o '"match":"[a-z_]*"'
# "match":"exact_match"
```

### Configuration on chain

Each line below can be run as is against the testnet RPC (`--rpc-url https://rpc.test.mezo.org`). Values were read on 2026-10-24.

| What | Call | Value |
| --- | --- | --- |
| The VoteAllocator is the vault's allocator | `cast call 0xdb2526679a0F285aEF9B31507364c4DD8CE59481 "isAllocator(address)(bool)" 0x66541B50a2F5bF7cFFcF623Fa02386e282cDe0E9` | `true` |
| The deployer is not an allocator | `cast call 0xdb2526679a0F285aEF9B31507364c4DD8CE59481 "isAllocator(address)(bool)" 0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282` | `false` |
| Performance fee is 10%, paid to the SuretyPool | `performanceFee()(uint96)`, `performanceFeeRecipient()(address)` on the vault | `1e17`, `0xEF54…B357` |
| The DepositGate is the receive-shares gate | `receiveSharesGate()(address)` on the vault | `0x2021…22b2` |
| Max rate is 200% a year | `maxRate()(uint64)` on the vault | `63419583967` (2e18 / 31,536,000) |
| Forced-exit penalty is 1% | `forceDeallocatePenalty(address)(uint256)` for each adapter | `1e16` |
| Caps are 10,000,000 MUSD, relative 100% | `absoluteCap(bytes32)`, `relativeCap(bytes32)` for the adapter ids | `1e25`, `1e18` |
| Line listing is closed to instant adds | `bootstrapEnded()(bool)` on the CreditVoter | `true` |
| Epochs are 1 hour; seasoning is 4 epochs | `EPOCH_LENGTH()` on the CreditVoter, `SEASON()` on the SuretyPool | `3600`, `4` |
| veBTC line parameters | `params()` on the VeBTCCreditLine | `(5000, 4000, 7000, 300, 7000, 600, 3600)` |
| veBTC line rate curve | `baseApr()`, `kinkApr()`, `maxApr()`, `kinkUtilWad()` on the LinearKinkIrm | 2%, 8%, 60%, 80% |
| Skip price age limit | `maxAge()` on the SkipPriceSource | `60` |

### Same sources as Mezo mainnet

Mezo's explorer serves the verified sources of a contract at `https://api.explorer.mezo.org/api/v2/smart-contracts/<address>` (`source_code` plus `additional_sources`). Compared file by file with the vendored submodules on 2026-10-24:

| Mezo mainnet contract | Files | Result |
| --- | --- | --- |
| VaultV2 [`0x0629…6a8B`](https://explorer.mezo.org/address/0x06291b67e3d7660240ab44Afc9a708d82b976a8B) | 13 | all identical to `contracts/lib/vault-v2` at `97bcce9` |
| MorphoMarketV1AdapterV2 [`0xb0EE…4F61`](https://explorer.mezo.org/address/0xb0EE3a01d9134733155B28289c09f084Acca4F61) | 25 | all identical to `contracts/lib/vault-v2` at `97bcce9` and its nested submodules |
| AdaptiveCurveIrm [`0x3760…C1e7`](https://explorer.mezo.org/address/0x3760Ebc636F912a4dB9540fdA4Dec09C25C6C1e7) | 11 | all identical to `contracts/lib/morpho-blue-irm` at `10be222` |
| Morpho Blue [`0x5658…A311`](https://explorer.mezo.org/address/0x565834cE7E40b8987BC20EbF83E2159467bDA311) | 14 | 12 identical to `contracts/lib/morpho-blue` at `792a3c9`; 2 differ only in one NatSpec comment each (`IMorpho.sol`, `ErrorsLib.sol`) |

The deployed bytecode differs from Mezo's because Surety compiles with its own settings (solc 0.8.28, optimizer at 200 runs; Mezo's VaultV2 was built with via-IR at 100,000 runs). On mainnet Surety will use Mezo's own Morpho Blue and IRM; the vendored Morpho Blue is deployed on testnet only.

### Mezo mainnet (31612)

Deployed 2026-10-25 from `contracts/deployments/31612.json` (block 12755630); every contract below is an exact match on Sourcify (creation and runtime bytecode; the LoanEscrow implementation is runtime-only because it is created by the line's constructor). Morpho Blue and AdaptiveCurveIrm are Mezo's own deployments.

| Contract | Address | Sourcify |
| --- | --- | --- |
| Surety MUSD vault (VaultV2) | [`0x632d627b66F2b11C8d0Fc61790422B0931D145de`](https://explorer.mezo.org/address/0x632d627b66F2b11C8d0Fc61790422B0931D145de) | [exact match](https://repo.sourcify.dev/31612/0x632d627b66F2b11C8d0Fc61790422B0931D145de) |
| MorphoMarketV1AdapterV2 | [`0xcB92a383a238Ce68d7b8Fe17231c90465379F779`](https://explorer.mezo.org/address/0xcB92a383a238Ce68d7b8Fe17231c90465379F779) | [exact match](https://repo.sourcify.dev/31612/0xcB92a383a238Ce68d7b8Fe17231c90465379F779) |
| CreditVoter | [`0x7B6673dEbB5E2480798ff3e11680182F37aF2f4f`](https://explorer.mezo.org/address/0x7B6673dEbB5E2480798ff3e11680182F37aF2f4f) | [exact match](https://repo.sourcify.dev/31612/0x7B6673dEbB5E2480798ff3e11680182F37aF2f4f) |
| VoteAllocator | [`0x810e269c6ae8198d92eda674B02daB4CF7a05CEE`](https://explorer.mezo.org/address/0x810e269c6ae8198d92eda674B02daB4CF7a05CEE) | [exact match](https://repo.sourcify.dev/31612/0x810e269c6ae8198d92eda674B02daB4CF7a05CEE) |
| SuretyPool | [`0x0597c0aB730BE64DDf797dE999275b627D9e592f`](https://explorer.mezo.org/address/0x0597c0aB730BE64DDf797dE999275b627D9e592f) | [exact match](https://repo.sourcify.dev/31612/0x0597c0aB730BE64DDf797dE999275b627D9e592f) |
| DepositGate | [`0xE708dba05AC671456F6258328794a25D8A352205`](https://explorer.mezo.org/address/0xE708dba05AC671456F6258328794a25D8A352205) | [exact match](https://repo.sourcify.dev/31612/0xE708dba05AC671456F6258328794a25D8A352205) |
| VeBTCCreditLine | [`0xb12ec34B417afB511A5067B31A32c65084FeE723`](https://explorer.mezo.org/address/0xb12ec34B417afB511A5067B31A32c65084FeE723) | [exact match](https://repo.sourcify.dev/31612/0xb12ec34B417afB511A5067B31A32c65084FeE723) |
| LoanEscrow implementation | [`0x1F2Fac07338B7a98B80622e436346fae13B66BE7`](https://explorer.mezo.org/address/0x1F2Fac07338B7a98B80622e436346fae13B66BE7) | [exact match](https://repo.sourcify.dev/31612/0x1F2Fac07338B7a98B80622e436346fae13B66BE7) |
| LinearKinkIrm (veBTC line) | [`0x023091B88CE266BF841868D30AE88D767Bd8fA5b`](https://explorer.mezo.org/address/0x023091B88CE266BF841868D30AE88D767Bd8fA5b) | [exact match](https://repo.sourcify.dev/31612/0x023091B88CE266BF841868D30AE88D767Bd8fA5b) |
| SkipPriceSource (lines’ price) | [`0x2f72e9EEBBF8ffB9bb27c1Efd562bA3B3f2345ba`](https://explorer.mezo.org/address/0x2f72e9EEBBF8ffB9bb27c1Efd562bA3B3f2345ba) | [exact match](https://repo.sourcify.dev/31612/0x2f72e9EEBBF8ffB9bb27c1Efd562bA3B3f2345ba) |
| MorphoPriceOracle | [`0x1cc8daeb91B7da756E3eA1f51eAB8c0776f0cb9B`](https://explorer.mezo.org/address/0x1cc8daeb91B7da756E3eA1f51eAB8c0776f0cb9B) | [exact match](https://repo.sourcify.dev/31612/0x1cc8daeb91B7da756E3eA1f51eAB8c0776f0cb9B) |

Check it yourself: `cast call 0x7B6673dEbB5E2480798ff3e11680182F37aF2f4f "LINE_TIMELOCK()(uint256)" --rpc-url https://mezo.drpc.org` returns 86400, `bootstrapEnded()` returns true, and the vault's `receiveSharesGate()` is the DepositGate.

## Live lifecycle on testnet

`keeper/scripts/testnet-cycle.ts` ran Surety's whole lifecycle on the current testnet deployment from the deployer account [`0x37D5…C282`](https://explorer.test.mezo.org/address/0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282), with its veBTC NFTs #1711 and #1712. Every mined transaction is appended to `proof.txs` in the deployment file as `{ label, hash, block }`, and the table below is rendered from that file by [`docs/proof-table.mjs`](proof-table.mjs). Rows marked PENDING are steps the run has not recorded yet; re-render with `node docs/proof-table.mjs --write` once it has.

<!-- proof:lifecycle:start -->
Rendered by `node docs/proof-table.mjs` from `contracts/deployments/31611.json`: 28 transactions recorded, 0 steps PENDING.

| # | Phase | Step | Transaction | Block |
| --- | --- | --- | --- | --- |
| 1 | setup | approve 1,000 MUSD to vault | [0xb2a1…4d35](https://explorer.test.mezo.org/tx/0xb2a15ba8aa2dd7266123c1da723c172de52b56110060287f75780c7834e14d35) | 16327107 |
| 2 | setup | deposit 1,000 MUSD | [0xb0f5…1b7f](https://explorer.test.mezo.org/tx/0xb0f5454092b8339d438ee251cbe94b482e0395e011a8b81cc6499da063de1b7f) | 16327109 |
| 3 | setup | vote #1711 70/30 | [0x457d…3c19](https://explorer.test.mezo.org/tx/0x457d99be8d82cec9bebc7bdd70b96c297bce02de5ec6ceb0e9b54fa3e13e3c19) | 16327111 |
| 4 | setup | vote #1712 30/70 | [0xa237…2168](https://explorer.test.mezo.org/tx/0xa237c02aa8e258239b3b421ab6b37028dae6d52d4b33ee5a8cab3ba1a1cf2168) | 16327113 |
| 5 | setup | rebalance (bootstrap) | [0xea9d…d272](https://explorer.test.mezo.org/tx/0xea9df942267786c3da071adf30aaf08c99f7215b74f41d8bfafeece18ae1d272) | 16327114 |
| 6 | setup | approve 250 MUSD to SuretyPool | [0xe0e7…2d4f](https://explorer.test.mezo.org/tx/0xe0e7a4cd9493121d7e881c4ac9b103092eae962c6aab539c1ceea255d1992d4f) | 16327116 |
| 7 | setup | incentive 100 MUSD to line 0 (BTC / MUSD (Morpho)) | [0x4028…0bd9](https://explorer.test.mezo.org/tx/0x4028707590f2bfc7480cccef2baf5d1bb6ecc11dc64404ab3c74eb9631020bd9) | 16327117 |
| 8 | setup | incentive 150 MUSD to line 1 (veBTC credit line) | [0xc9ad…a124](https://explorer.test.mezo.org/tx/0xc9ada6b57cb5c1f2b86ab30bada849adc0c98cb0b6417029bb19a26b57dea124) | 16327119 |
| 9 | setup | approve veBTC #1712 to credit line | [0xc169…9ad6](https://explorer.test.mezo.org/tx/0xc169d6a92e13cc62ac348fdb58c4314d33159e65e87c17b17f8f37c36a729ad6) | 16327121 |
| 10 | setup | veBTC loan opened #1712 (100 MUSD) | [0x050d…9fe9](https://explorer.test.mezo.org/tx/0x050dbd83e7328e6f93c8bdf8916a8c10bb2418b92e06c247242d76d142f59fe9) | 16327127 |
| 11 | setup | approve 0.004 BTC to Morpho | [0x3497…529a](https://explorer.test.mezo.org/tx/0x34971220a902c16bff1efa07c4c754a75cbd500dbbc6e3a46f8912d86d26529a) | 16327128 |
| 12 | setup | Morpho supplyCollateral 0.004 BTC | [0x9fb2…832a](https://explorer.test.mezo.org/tx/0x9fb20a4632c5011223a57e9bb694c80da6e3cb30dfdc06375f6d73f05213832a) | 16327131 |
| 13 | setup | Morpho borrow 250 MUSD (LTV 76.91%) | [0xb8b2…b9d2](https://explorer.test.mezo.org/tx/0xb8b21e2420529ec8b36946de5bffa04bf98fc0ef16ba15ebdd574cb68aa6b9d2) | 16327133 |
| 14 | stress | checkpoint Morpho line (pre-shock high-water mark) | [0x994f…8030](https://explorer.test.mezo.org/tx/0x994ff2b005023a6669f3b38b99d0b64296c4093dd6904b3a77f322b5dfdc8030) | 16327137 |
| 15 | stress | shock −60% | [0x1a75…0434](https://explorer.test.mezo.org/tx/0x1a7578c63835b13c73c7528d6e7a737da17f2eee5e0f5c20e7e02f73435f0434) | 16327139 |
| 16 | stress | approve MUSD to Morpho (liquidation) | [0x8d5b…52f3](https://explorer.test.mezo.org/tx/0x8d5b0f72b6057759a32dede8373e481dc9d8d58ff6dd4de03290afa5899c52f3) | 16327141 |
| 17 | stress | **Morpho liquidation with bad debt** | [0x9fd3…0723](https://explorer.test.mezo.org/tx/0x9fd30e57406f16ef8c279011ec20f47b6783164579ad0f3668c06c5e1bec0723) | 16327142 |
| 18 | stress | veBTC auction started (loan #1, LTV 102.51%) | [0xa23a…f4aa](https://explorer.test.mezo.org/tx/0xa23a1a828d775e7b4304e6df2f383b42bdbdb52e3447aa205a3ed13c942ff4aa) | 16327144 |
| 19 | stress | approve MUSD to credit line (bid) | [0x49fd…665e](https://explorer.test.mezo.org/tx/0x49fd709053710d77e3eff0809a5d15bc29970ba6721aa777f2172e2e5807665e) | 16327291 |
| 20 | stress | **veBTC auction bid at floor** | [0x32c4…79ad](https://explorer.test.mezo.org/tx/0x32c467bc1ee7b9b5ae1eef870c4f3f8e6149bfda4a381739dda646ffd23479ad) | 16327293 |
| 21 | settle | **checkpoint Morpho line (loss recorded)** | [0x34c0…00a8](https://explorer.test.mezo.org/tx/0x34c07182444af905b13e4d22705d16d878bd0ab8c37ee1361b4851bef45f00a8) | 16327297 |
| 22 | settle | **checkpoint veBTC line (loss recorded)** | [0x9aeb…da00](https://explorer.test.mezo.org/tx/0x9aebba4424e43ed91863469c282e7c251ae855fe1c1f5e54cdd61bec8844da00) | 16327300 |
| 23 | settle | **cover Morpho line** | [0x7a52…8b03](https://explorer.test.mezo.org/tx/0x7a528516a84e5eebc6d6b32aa99103e7ec8bc2b0b7669457f82d01fd70188b03) | 16327301 |
| 24 | settle | **cover veBTC line** | [0xf260…ae9b](https://explorer.test.mezo.org/tx/0xf260dae6094b993d93781f3f6e202e93d76344047a39ff46f86fcaa2e9b4ae9b) | 16327303 |
| 25 | epoch | poke #1711 (epoch 23:00 UTC, by the keeper) | [0xc1bd…1ecf](https://explorer.test.mezo.org/tx/0xc1bd7ba110180b39d256954c4265f5c6213b690d4d143ba31a865951fafa1ecf) | 16327765 |
| 26 | epoch | poke #1712 (epoch 23:00 UTC, by the keeper) | [0xe8e7…c4ad](https://explorer.test.mezo.org/tx/0xe8e74db83517ef391fe9b69a73d877b5103e10a99e6eadad7457c43e224fc4ad) | 16327767 |
| 27 | epoch | **rebalance (epoch 23:00 UTC, by the keeper): fees attributed to the cohorts** | [0x8f22…622c](https://explorer.test.mezo.org/tx/0x8f22a2de4732ffc0ff32dfec7576c8fdcf2ec4a7234905cb43d98ed286b6622c) | 16327768 |
| 28 | other | cover by the keeper: new fees in the reserve pay down the lenders' share of the Morpho loss | [0x8a3f…c541](https://explorer.test.mezo.org/tx/0x8a3ff37c8d20140804aa5b9d09ff5b62cf9bfb4ec5e250164915cc571c74c541) | 16327820 |

<!-- proof:lifecycle:end -->

What each phase does:

- **setup.** Deposits 1,000 MUSD. #1711 votes 70% for line 0 (BTC / MUSD on Morpho) and 30% for line 1 (veBTC line); #1712 votes 30/70, so the tally is even. The first rebalance has no closed epoch with votes yet, so it bootstraps on the live tally and sends 90% of the vault to the two lines. Sponsors post 100 MUSD of incentives for line 0's voters and 150 MUSD for line 1's. #1712 then borrows 100 MUSD on the veBTC line, and a Morpho borrower posts 0.004 BTC and borrows at about 77% LTV (LLTV 86%).
- **stress.** Checkpoints the Morpho line so its mark is current, then shocks the price source by −60% for 2 hours. The Morpho position is liquidated with all its collateral seized, which leaves bad debt in the market. The veBTC loan, now above 100% LTV, is auctioned and bought at the 70% floor, below its debt.
- **settle.** Checkpoints both lines (`LossRecorded`), then covers both (`CohortSlashed`, `Covered`).
- **epoch.** After each hourly flip: pokes both ballots into the new epoch and rebalances, which attributes the interest of the closed window to the cohorts.

### The loss, from the events

Values decoded from the events of the transactions above (MUSD and srMUSD, 18 decimals, rounded to 4 places):

| | Morpho line (0) | veBTC line (1) |
| --- | --- | --- |
| Bad debt realised | 125.4043 (`Liquidate.badDebtAssets`) | 31.7562 (`Bid.shortfall`: price 68.2439 for a debt of 100.0001) |
| Loss recorded (`LossRecorded`) | 125.4043 | 31.7562 |
| Taken from the voters' cohort of the 22:00 UTC epoch (`CohortSlashed`) | 100.0000 srMUSD, all of it | 35.6901 srMUSD of 150.0000 |
| Taken from the reserve | 0 (the reserve was empty) | 0 |
| MUSD moved by the cover (`Covered.assetsMoved`) | 87.4272, back to the vault as idle | 31.2028, paid into the line |
| Loss units covered (`Covered.lossUnitsCovered`) | 88.4209 | 31.7562, the whole loss |
| Left with lenders | 36.9834 | 0 |

How to read it:

- The veBTC line's loss is covered in full; the Morpho line's cover was cut short because its only cohort held 100 srMUSD and the reserve was empty, so 36.98 MUSD of that loss stays with srMUSD holders. That is the third tier of the waterfall working as specified.
- The MUSD a cover moves is not the loss itself. VaultV2 recognises returned MUSD as interest and takes its 10% fee on it, so `cover` sizes the transfer for that (see [ARCHITECTURE.md](ARCHITECTURE.md#sizing-a-cover)). Line 0: 87.4272 MUSD covered 88.4209 loss units, which matches `w × (1 − f) × (A + U) / (A − f × w)` with the vault at about 1,092.8 MUSD. Line 1 moved 31.2028 MUSD for a 31.7562 loss because 87.43 MUSD from the first cover was already waiting to be recognised and counts toward the restoration.

State after the covers, read at block 16,327,549 (2026-10-23 22:45 UTC):

| | Value |
| --- | --- |
| Vault total assets / srMUSD supply | 974.2709 MUSD / 1,114.3100 srMUSD |
| Share price (`previewRedeem(1e18)`) | 0.874324 MUSD |
| Cover MUSD not yet recognised (`coverUnrecognised`) | 118.6300 MUSD |
| `depositsPaused()` | `true` |
| Cohort (line 1, 22:00 UTC) | 114.3099 srMUSD, matures 2026-10-24 04:00 UTC |

VaultV2 recognises the 118.63 MUSD at no more than 200% a year of its total assets, which takes about three weeks at this size. New deposits on the testnet vault wait until then; withdrawals stay open. Once it is recognised, the share price is projected at about 0.970: 1,092.9 MUSD of assets over 1,114.31 srMUSD plus about 12.2 srMUSD of fee shares minted on the recognised MUSD. That projection is arithmetic, not an observation.

## Tests

### Foundry

```sh
cd contracts
forge test
# Ran 16 test suites: 197 tests passed, 0 failed, 1 skipped (198 total tests)
forge test --summary   # per-suite table
```

| Suite | Passed |
| --- | --- |
| `CreditVoterTest` | 34 |
| `SuretyPoolTest` | 32 |
| `VeBTCCreditLineTest` | 31 |
| `VoteAllocatorTest` | 22 |
| `VoteAllocatorLossTest` | 1 |
| `MezoMocksTest` | 21 |
| `OraclesTest` | 18 |
| `FixtureTest` | 7 |
| `LinearKinkIrmTest` | 6 |
| `LoanEscrowTest` | 5 |
| `EpochLibTest` | 4 |
| `DepositGateTest` | 2 |
| `LifecycleTest` (integration) | 3 |
| `AuditPoCTest` (review regressions) | 10 |
| `SuretyInvariants` (7 invariants, 256 runs × 64 calls) | 1 |
| `LiveMezoTest` (fork, opt-in) | 0, 1 skipped |

The invariants: `invariant_vaultAssetsBacked`, `invariant_lineAccounting`, `invariant_cohortConservation`, `invariant_coverNeverExceedsLoss`, `invariant_depositGate`, `invariant_tallyConservation`, `invariant_escrowsHoldTheirNFT`. Fuzzed unit tests run 512 times.

```sh
forge test --match-contract AuditPoCTest -vv        # the review regressions
SURETY_FORK=true forge test --match-contract LiveMezo  # against live Mezo mainnet state; SURETY_FORK_RPC overrides the RPC
```

### TypeScript

```sh
pnpm install
pnpm test
# @surety/sdk 53 passed, @surety/keeper 38 passed, @surety/mcp 8 passed: 99 in total
```

## Reproduce the lifecycle

The lifecycle script needs a deployment made with `STRESS=true` (the shock goes through `StressedPriceSource`) and an account holding testnet MUSD (1,000 to deposit, 250 for incentives, and enough to liquidate and bid), 0.004 BTC for the Morpho collateral plus gas, and two veBTC NFTs with voting power. The NFT ids are constants at the top of the script (`BALLOTS`, `LOAN_NFT`); change them to your own.

```sh
# 1. Deploy your own stress deployment (writes contracts/deployments/31611.json unless DEPLOYMENT_OUT is set)
cd contracts
STRESS=true DEPLOYMENT_OUT=deployments/mine.31611.json \
  forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast

# 2. Build the script and run the phases in order, from the repository root
cd ..
pnpm install && pnpm --filter @surety/keeper build:cycle
node keeper/dist/scripts/testnet-cycle.js --phase setup  --deployment contracts/deployments/mine.31611.json --env-file /path/outside/repo/.env
node keeper/dist/scripts/testnet-cycle.js --phase stress --deployment contracts/deployments/mine.31611.json --env-file /path/outside/repo/.env
node keeper/dist/scripts/testnet-cycle.js --phase settle --deployment contracts/deployments/mine.31611.json --env-file /path/outside/repo/.env
node keeper/dist/scripts/testnet-cycle.js --phase epoch --wait --deployment contracts/deployments/mine.31611.json --env-file /path/outside/repo/.env

# 3. Render the proof table from your file
node docs/proof-table.mjs contracts/deployments/mine.31611.json
```

Notes:

- The `.env` file holds `DEPLOYER_PRIVATE_KEY`; keep it outside the repository. The script never prints the key.
- Each phase reads chain state first and skips what is already done, so a phase can be re-run after a failure. `--dry-run` simulates every step and sends nothing.
- `setup` waits for a point in the epoch where votes and incentives can land in the same epoch. `stress` waits for the auction to decay to its floor (10 minutes on testnet). `epoch --wait` waits for the next hourly flip.
- Every transaction is simulated, then sent with a gas limit of the estimate plus 30%; Mezo's estimates can come in low.
