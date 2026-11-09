# Proof

Every public claim about Surety points to something that can be checked: a verified contract, a transaction, a test, or a calculation shown in full. [CLAIMS.md](CLAIMS.md) lists the claims with their evidence tier; this page holds the evidence.

## Verified contracts

### Mezo testnet (31611), v2

All 18 Surety contracts in [`contracts/deployments/31611.json`](../contracts/deployments/31611.json) are verified on Sourcify with an exact match (runtime bytecode and metadata). Checked on 2026-11-09. The deployment also uses Mezo's own testnet Morpho Blue ([`0xCe1d…5a73`](https://explorer.test.mezo.org/address/0xCe1da828cA15cb1FDAfa84C366A53C8106655a73)) and AdaptiveCurveIrm ([`0x0c97…7441`](https://explorer.test.mezo.org/address/0x0c97Fe017628636649ff374aD499529F91167441)), both verified on Mezo's explorer since May 2026, months before Surety's first deployment.

| Contract | Address | Sourcify | Explorer |
| --- | --- | --- | --- |
| Surety vault (VaultV2, srMUSD) | `0x52aD2746994a1BC318cDf09b81f7831fB9Af03b8` | [source](https://repo.sourcify.dev/31611/0x52aD2746994a1BC318cDf09b81f7831fB9Af03b8) | [explorer](https://explorer.test.mezo.org/address/0x52aD2746994a1BC318cDf09b81f7831fB9Af03b8) |
| MorphoMarketV1AdapterV2 | `0x6F31B144b51083FBbb8EA160F6f6772e37f4b79b` | [source](https://repo.sourcify.dev/31611/0x6F31B144b51083FBbb8EA160F6f6772e37f4b79b) | [explorer](https://explorer.test.mezo.org/address/0x6F31B144b51083FBbb8EA160F6f6772e37f4b79b) |
| SavingsAdapter | `0x28eDb116683608Db6722dd440627A16FC7Bd30E4` | [source](https://repo.sourcify.dev/31611/0x28eDb116683608Db6722dd440627A16FC7Bd30E4) | [explorer](https://explorer.test.mezo.org/address/0x28eDb116683608Db6722dd440627A16FC7Bd30E4) |
| CreditVoter | `0x16D36BECF7D25af55C1658f428e33Ff34388f255` | [source](https://repo.sourcify.dev/31611/0x16D36BECF7D25af55C1658f428e33Ff34388f255) | [explorer](https://explorer.test.mezo.org/address/0x16D36BECF7D25af55C1658f428e33Ff34388f255) |
| VoteAllocator | `0x69Ef3397c2ffb4B23A8Fd7154243aA9C215673c0` | [source](https://repo.sourcify.dev/31611/0x69Ef3397c2ffb4B23A8Fd7154243aA9C215673c0) | [explorer](https://explorer.test.mezo.org/address/0x69Ef3397c2ffb4B23A8Fd7154243aA9C215673c0) |
| SuretyPool | `0xc9Ca8a280d6c339c3169DEEEFB2e08FcB42AcDE0` | [source](https://repo.sourcify.dev/31611/0xc9Ca8a280d6c339c3169DEEEFB2e08FcB42AcDE0) | [explorer](https://explorer.test.mezo.org/address/0xc9Ca8a280d6c339c3169DEEEFB2e08FcB42AcDE0) |
| DepositGate | `0xfAa1c07591b596cB3aa5D6b8054AE3d6a7Fbd8C7` | [source](https://repo.sourcify.dev/31611/0xfAa1c07591b596cB3aa5D6b8054AE3d6a7Fbd8C7) | [explorer](https://explorer.test.mezo.org/address/0xfAa1c07591b596cB3aa5D6b8054AE3d6a7Fbd8C7) |
| VeBTCCreditLine | `0x390B074E003559Cc1868cac0D06A4364BdeDb6f1` | [source](https://repo.sourcify.dev/31611/0x390B074E003559Cc1868cac0D06A4364BdeDb6f1) | [explorer](https://explorer.test.mezo.org/address/0x390B074E003559Cc1868cac0D06A4364BdeDb6f1) |
| LoanEscrow implementation | `0x8d4A899372b543641468731B65f05CF74bA7ec6D` | [source](https://repo.sourcify.dev/31611/0x8d4A899372b543641468731B65f05CF74bA7ec6D) | [explorer](https://explorer.test.mezo.org/address/0x8d4A899372b543641468731B65f05CF74bA7ec6D) |
| LinearKinkIrm (veBTC line) | `0x5067524ECfFEa0A43c7eA49BBe4D73663E28a667` | [source](https://repo.sourcify.dev/31611/0x5067524ECfFEa0A43c7eA49BBe4D73663E28a667) | [explorer](https://explorer.test.mezo.org/address/0x5067524ECfFEa0A43c7eA49BBe4D73663E28a667) |
| ShareMarket | `0x226EA3452D4238fE7Ff5a5600B5bCd991082e51a` | [source](https://repo.sourcify.dev/31611/0x226EA3452D4238fE7Ff5a5600B5bCd991082e51a) | [explorer](https://explorer.test.mezo.org/address/0x226EA3452D4238fE7Ff5a5600B5bCd991082e51a) |
| MusdPeg | `0xd54D93aa56B080df424847142A1aaac59bB760AB` | [source](https://repo.sourcify.dev/31611/0xd54D93aa56B080df424847142A1aaac59bB760AB) | [explorer](https://explorer.test.mezo.org/address/0xd54D93aa56B080df424847142A1aaac59bB760AB) |
| StressedPegSource (the peg's testnet source) | `0xA6108bCb61a3F6C8A0D9869601368271DCA00E64` | [source](https://repo.sourcify.dev/31611/0xA6108bCb61a3F6C8A0D9869601368271DCA00E64) | [explorer](https://explorer.test.mezo.org/address/0xA6108bCb61a3F6C8A0D9869601368271DCA00E64) |
| BtcMusdPriceSource (lines' price) | `0x457D8E3190DD5E75f6C5023231E33B1D687fd183` | [source](https://repo.sourcify.dev/31611/0x457D8E3190DD5E75f6C5023231E33B1D687fd183) | [explorer](https://explorer.test.mezo.org/address/0x457D8E3190DD5E75f6C5023231E33B1D687fd183) |
| StressedPriceSource (BTC/USD) | `0x054AE6B3c0E06F13856Abf8c8c76E40f51CdcC08` | [source](https://repo.sourcify.dev/31611/0x054AE6B3c0E06F13856Abf8c8c76E40f51CdcC08) | [explorer](https://explorer.test.mezo.org/address/0x054AE6B3c0E06F13856Abf8c8c76E40f51CdcC08) |
| SkipPriceSource | `0x9F7Ce9D147920f2499840163858C23d1A165EFe8` | [source](https://repo.sourcify.dev/31611/0x9F7Ce9D147920f2499840163858C23d1A165EFe8) | [explorer](https://explorer.test.mezo.org/address/0x9F7Ce9D147920f2499840163858C23d1A165EFe8) |
| MorphoPriceOracle | `0xfC1F49bFdE8A69e8d893dF8e976401232e6600Cc` | [source](https://repo.sourcify.dev/31611/0xfC1F49bFdE8A69e8d893dF8e976401232e6600Cc) | [explorer](https://explorer.test.mezo.org/address/0xfC1F49bFdE8A69e8d893dF8e976401232e6600Cc) |
| Sponsor (starter kits) | `0x085c6e2a022363c8F8811C4242F32373055d9BA8` | [source](https://repo.sourcify.dev/31611/0x085c6e2a022363c8F8811C4242F32373055d9BA8) | [explorer](https://explorer.test.mezo.org/address/0x085c6e2a022363c8F8811C4242F32373055d9BA8) |

Mezo's Blockscout verifier currently lists no Solidity compiler versions, so no contract can be verified there for now:

```sh
curl -s https://api.explorer.test.mezo.org/api/v2/smart-contracts/verification/config | grep -o '"solidity_compiler_versions":\[[^]]*\]'
# "solidity_compiler_versions":[]      (the same on api.explorer.mezo.org, checked 2026-11-09)
```

### Configuration on chain, v2

Each line below can be run as is against the testnet RPC (`--rpc-url https://rpc.test.mezo.org`). Values were read on 2026-11-09.

| What | Call | Value |
| --- | --- | --- |
| The VoteAllocator is the vault's allocator, the deployer is not | `cast call 0x52aD2746994a1BC318cDf09b81f7831fB9Af03b8 "isAllocator(address)(bool)" 0x69Ef3397c2ffb4B23A8Fd7154243aA9C215673c0` (and `0x37D5…C282`) | `true` (`false`) |
| Performance fee is 10%, paid to the SuretyPool | `performanceFee()(uint96)`, `performanceFeeRecipient()(address)` on the vault | `1e17`, `0xc9Ca…cDE0` |
| Management fee is 0.20% a year, paid to the treasury | `managementFee()(uint96)`, `managementFeeRecipient()(address)` on the vault | `63419583` (0.002e18 / 31,536,000), `0x37D5…C282` |
| Idle MUSD parks in sMUSD | `liquidityAdapter()(address)` on the vault; `parking()(bool)` on the VoteAllocator | `0x28eD…30E4` (SavingsAdapter), `true` |
| The DepositGate is the receive-shares gate and lets the treasury through | `receiveSharesGate()(address)` on the vault; `treasury()(address)` on the gate | `0xfAa1…d8C7`, `0x37D5…C282` |
| Max rate is 200% a year | `maxRate()(uint64)` on the vault | `63419583967` |
| Forced-exit penalty is 1%, savings included | `forceDeallocatePenalty(address)(uint256)` for each adapter | `1e16` |
| Savings cap | `absoluteCap(bytes32)` for the savings adapter id | `1e27` |
| veBTC line parameters | `params()(uint16,uint16,uint16,uint16,uint16,uint32,uint32,uint16,uint16,uint16)` on the VeBTCCreditLine | `5000 4000 6500 300 8500 600 3600 25 2000 5000` |
| The line's fees go to the treasury, and its peg check is on | `treasury()(address)`, `pegCheck()(bool)` on the VeBTCCreditLine | `0x37D5…C282`, `true` |
| Peg thresholds | `minSources()`, `maxSpreadBps()`, `bandBps()`, `pegHealthy()(bool)` on the MusdPeg | `1`, `1000`, `300`, `true` |
| Premium cap | `maxPremiumBps()(uint16)` on the BtcMusdPriceSource | `300` |
| The allocator funds lines | `pegGateOpen()(bool)` on the VoteAllocator | `true` |
| ShareMarket fee | `feeBps()(uint16)`, `treasury()(address)` on the ShareMarket | `10`, `0x37D5…C282` |
| Starter kits | `kitsLeft()(uint256)`, `dailyLimit()(uint256)` on the Sponsor | `4`, `100` |
| Line listing is closed to instant adds; epochs and seasoning | `bootstrapEnded()(bool)`, `EPOCH_LENGTH()` on the CreditVoter; `SEASON()` on the SuretyPool | `true`, `3600`, `4` |

### Mezo testnet (31611), v1

All 14 contracts in [`contracts/deployments/v1/31611.json`](../contracts/deployments/v1/31611.json) are verified on Sourcify with an exact match (metadata and bytecode). Checked on 2026-10-24.

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

The v1 testnet deployment. Each line below can be run as is against the testnet RPC (`--rpc-url https://rpc.test.mezo.org`). Values were read on 2026-10-24.

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

The deployed bytecode differs from Mezo's because Surety compiles with its own settings (solc 0.8.28, optimizer at 200 runs; Mezo's VaultV2 was built with via-IR at 100,000 runs). Surety uses Mezo's own Morpho Blue and IRM on mainnet, and in v2 on testnet too; the vendored Morpho Blue was deployed only for the v1 testnet deployment.

### Mezo mainnet (31612)

Deployed 2026-10-25 from `contracts/deployments/v1/31612.json` (block 12755630); every contract below is an exact match on Sourcify (creation and runtime bytecode; the LoanEscrow implementation is runtime-only because it is created by the line's constructor). Morpho Blue and AdaptiveCurveIrm are Mezo's own deployments.

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

## Live lifecycle on testnet, v2

`keeper/scripts/testnet-cycle-v2.ts` ran Surety v2 end to end on the current testnet deployment ([`contracts/deployments/31611.json`](../contracts/deployments/31611.json)) on 2026-11-09, from 06:42 to 07:00 UTC. Each role sends from its own account and the deployer only funds them. Every account below belongs to the team:

| Role | Account |
| --- | --- |
| Lender | [`0x38c4F040E1A6b76AB5F6d56A45612a79C565604c`](https://explorer.test.mezo.org/address/0x38c4F040E1A6b76AB5F6d56A45612a79C565604c) |
| Borrower | [`0x5EbAD5e82EC5FE57792708741Fb7CAeCb5a7296C`](https://explorer.test.mezo.org/address/0x5EbAD5e82EC5FE57792708741Fb7CAeCb5a7296C) |
| Voter (veBTC #1711) | [`0x525f12EFb63D9373d7fd03E6eD93625C24930922`](https://explorer.test.mezo.org/address/0x525f12EFb63D9373d7fd03E6eD93625C24930922) |
| Sponsor (incentives, bribe) | [`0xa102BF713aD35F0B9A5b20CB75192F2f4a43274c`](https://explorer.test.mezo.org/address/0xa102BF713aD35F0B9A5b20CB75192F2f4a43274c) |
| Bidder | [`0xE5D77eAa62c9E11345d308A2F0388a33e81592d7`](https://explorer.test.mezo.org/address/0xE5D77eAa62c9E11345d308A2F0388a33e81592d7) |
| Share buyer | [`0xDB3cDA1EE42010fA2eb230fbD6d97E4409A56f4d`](https://explorer.test.mezo.org/address/0xDB3cDA1EE42010fA2eb230fbD6d97E4409A56f4d) |
| Keeper wallet (rebalance, stresses, auction start) | [`0xc69cb7b6d6238DDdF47323B0BC57E99BF040A87E`](https://explorer.test.mezo.org/address/0xc69cb7b6d6238DDdF47323B0BC57E99BF040A87E) |
| Starter-kit relayer | [`0x030E00FE424e98327332BC4f946975C4927c7DdC`](https://explorer.test.mezo.org/address/0x030E00FE424e98327332BC4f946975C4927c7DdC) |
| Starter-kit test wallet | [`0x7e87dc50afA869D03444cD3304A2FE28cCf5759a`](https://explorer.test.mezo.org/address/0x7e87dc50afA869D03444cD3304A2FE28cCf5759a) |

Key steps:

<!-- proof:key-steps-v2:start -->
- Lender deposit parks in sMUSD through the liquidity adapter: [0xe25a…51f8](https://explorer.test.mezo.org/tx/0xe25a1e53b909718a19de0b74823a81c6ad68a66b596f950c1f4006f49c8d51f8)
- Rebalance moves the capital from sMUSD to the lines by the votes: [0x5fe4…c5b2](https://explorer.test.mezo.org/tx/0x5fe4a449d6793cba4e511c7a1cd579e9220851c61be8f15a08d685afddbfc5b2)
- veBTC loan opened, origination fee to the treasury (`OriginationFeePaid`): [0x9f8d…99f9](https://explorer.test.mezo.org/tx/0x9f8decd8a5fa3e6944f3186d0d7f59f915627ee569558e4425da8858e2ea99f9)
- The loan's escrow votes the NFT on Mezo's PoolsVoter: [0x1a50…0430](https://explorer.test.mezo.org/tx/0x1a50ee48bfa2a189fab44bbdccf936f6f630c4fe994766e0ce4d575529720430)
- Depeg breaker: a borrow sent while MUSD reads $0.94 reverts on chain with `PegUnhealthy`: [0x6438…8e16](https://explorer.test.mezo.org/tx/0x6438e38d8cd1dfb4f522a6c72c25cf987e97e98201d2838d2f7a7942633f8e16)
- Auction bid above debt + fee: no shortfall, fee split to lenders, treasury and keeper (`LiquidationFeePaid`): [0x69ba…aae1](https://explorer.test.mezo.org/tx/0x69ba998d4a6071942e0c77873dd5f554ec04f2415ad806ff0ce720cc9652aae1)
- ShareMarket fill: a lender sells srMUSD at a discount, 10 bps to the treasury: [0x741e…de8a](https://explorer.test.mezo.org/tx/0x741e1b596a09c35b382c5ef245c16a168ea6eb725f86e09b2ceb2088ecbfde8a)
- Starter kit through the Sponsor's relayer (team test wallet): [0x823f…1477](https://explorer.test.mezo.org/tx/0x823f99fc7d1e6efb55facc06676708f48fc994ee111de45259847107e5321477)
- Auto-repay: the escrow's bribes and fees harvested into repayment after the Mezo flip: PENDING (not recorded yet)

<!-- proof:key-steps-v2:end -->

<!-- proof:lifecycle-v2:start -->
Rendered by `node docs/proof-table.mjs` from `contracts/deployments/31611.json`: 51 transactions recorded, 1 steps PENDING.

| # | Phase | Step | Transaction | Block |
| --- | --- | --- | --- | --- |
| 1 | fund | fund lender: 100 MUSD | [0x83f1…4863](https://explorer.test.mezo.org/tx/0x83f16f71df7203cc740b0782ec245b8ed6b380d42683de1b3743d7bdef994863) | 16667566 |
| 2 | fund | fund lender: 0.00002 BTC for gas | [0x5580…b629](https://explorer.test.mezo.org/tx/0x5580f91e2f376ebe5c7f64731eecee84ccf744ca5235d15c755fd341d243b629) | 16667568 |
| 3 | fund | fund borrower: 0.00502 BTC for two veBTC locks, Morpho collateral and gas | [0xc107…e719](https://explorer.test.mezo.org/tx/0xc107f7d774194b2595c668a53d526e7f47c1f451abef754c9002ca10bb8de719) | 16667570 |
| 4 | fund | fund voter: veBTC #1711 | [0xed09…041c](https://explorer.test.mezo.org/tx/0xed09c4b2f35de49243e43f15e48eaa4d5f48d99a4b4c702efd6c2cab3128041c) | 16667573 |
| 5 | fund | fund voter: 0.00002 BTC for gas | [0xb002…311d](https://explorer.test.mezo.org/tx/0xb0020759bc78b3cb6a6ae3ddbf82a25df778dd94bb52841a2744825e9c84311d) | 16667576 |
| 6 | fund | fund sponsor: 40 MUSD | [0x41c4…cf2e](https://explorer.test.mezo.org/tx/0x41c46f8edd8edd7cc47dcad65aeb88ff166c1cdc8b2eb735295f5472fe99cf2e) | 16667579 |
| 7 | fund | fund sponsor: 0.00002 BTC for gas | [0xe46e…6c7a](https://explorer.test.mezo.org/tx/0xe46e124eb99125b020bdb4f47799ece38366a53035cdd8788f60f97bf06d6c7a) | 16667580 |
| 8 | fund | fund bidder: 55 MUSD | [0xd607…81c1](https://explorer.test.mezo.org/tx/0xd6077343bcf64ecf0b96f55a99c3c728788823dec563d5d81c167ab6107281c1) | 16667582 |
| 9 | fund | fund bidder: 0.00002 BTC for gas | [0x228d…be89](https://explorer.test.mezo.org/tx/0x228db119fa9959e57fef6e755188a895248003f3f70be656e9f255b028e8be89) | 16667585 |
| 10 | fund | fund share buyer: 12 MUSD | [0x7002…2c2c](https://explorer.test.mezo.org/tx/0x700230bccbe8304ac079b3ec8936c436173f92221921e436c6010fc1034f2c2c) | 16667587 |
| 11 | fund | fund share buyer: 0.00002 BTC for gas | [0xd400…d428](https://explorer.test.mezo.org/tx/0xd4005ff473e6b0c99535d27bfc3b850f03bfdd76f0f5c9b45d63bae8e020d428) | 16667589 |
| 12 | fund | fund keeper wallet: 0.00002 BTC for gas | [0x210f…7b32](https://explorer.test.mezo.org/tx/0x210f1ed7a0d10edb89cd410224e148528ffc9066c46fbcc2e89b34e6dd997b32) | 16667592 |
| 13 | fund | fund starter-kit relayer: 0.00002 BTC for gas | [0x40bf…6854](https://explorer.test.mezo.org/tx/0x40bfc25e9144e41d55592e0f1f20b55b6be1eac8a2dc015fb7a1f64a4fc76854) | 16667594 |
| 14 | lend | lender: approve 100 MUSD to vault | [0x28a5…abcf](https://explorer.test.mezo.org/tx/0x28a5712021d7ff12e231414d47017e52547754ea1292b9508c542a95c0b1abcf) | 16667600 |
| 15 | lend | **lender: deposit 100 MUSD, parked in sMUSD** | [0xe25a…51f8](https://explorer.test.mezo.org/tx/0xe25a1e53b909718a19de0b74823a81c6ad68a66b596f950c1f4006f49c8d51f8) | 16667603 |
| 16 | vote | voter: vote #1711 30/70 (line 0 Morpho / line 1 veBTC) | [0xebb5…bab7](https://explorer.test.mezo.org/tx/0xebb5dac8dd85a29d509c91fd35b30168a660afc40cb22d038c35c11ddafcbab7) | 16667606 |
| 17 | vote | sponsor: approve 20 MUSD to SuretyPool | [0x0a68…de9d](https://explorer.test.mezo.org/tx/0x0a6853aaeab3d0aedcf23478c25eee36eb6800da92bd1fbee65bc5c584b5de9d) | 16667607 |
| 18 | vote | sponsor: incentive 10 MUSD to line 0 (BTC / MUSD (Morpho)) | [0xb192…a970](https://explorer.test.mezo.org/tx/0xb1925359eff8823ed6f0960bf4d15f0891feaa9791a823c7ce94071243d4a970) | 16667608 |
| 19 | vote | sponsor: incentive 10 MUSD to line 1 (veBTC credit line) | [0xca1f…fb84](https://explorer.test.mezo.org/tx/0xca1f20814f509079277fff556a676514cadb5c63dfa2641d1e7df8ff63cefb84) | 16667609 |
| 20 | vote | **keeper wallet: rebalance (epoch 06:00 UTC): sMUSD to the lines by the votes** | [0x5fe4…c5b2](https://explorer.test.mezo.org/tx/0x5fe4a449d6793cba4e511c7a1cd579e9220851c61be8f15a08d685afddbfc5b2) | 16667612 |
| 21 | loan | borrower: approve 0.003 BTC to veBTC | [0xb052…559d](https://explorer.test.mezo.org/tx/0xb052c1417edeb41e53932425c3abbbdee040063df0410eb4d1fad2b1b723559d) | 16667617 |
| 22 | loan | borrower: veBTC lock #1732 created (0.003 BTC, 28 days) for the escrow-vote loan | [0x61cc…7ef7](https://explorer.test.mezo.org/tx/0x61cc80cffd99e5c55b211345ebd0d5c564b1a1bf8dac737c5d3f6861eb797ef7) | 16667620 |
| 23 | loan | borrower: approve veBTC #1732 to credit line | [0x684f…8f27](https://explorer.test.mezo.org/tx/0x684f2cbcb302c2db8b3be88e6b0c55e5c2013d3bd0ee4d955897225635118f27) | 16667622 |
| 24 | loan | **borrower: veBTC loan #1 opened on #1732 (25 MUSD, LTV 11.26%; 0.0625 MUSD origination fee to the treasury)** | [0x9f8d…99f9](https://explorer.test.mezo.org/tx/0x9f8decd8a5fa3e6944f3186d0d7f59f915627ee569558e4425da8858e2ea99f9) | 16667626 |
| 25 | loan | borrower: auto-repay on for loan #1 (anyone may harvest its rewards into repayment) | [0x30a8…fc41](https://explorer.test.mezo.org/tx/0x30a85874117863e547421a90056a812bea381561e7200b8b8a87ddbf3e3efc41) | 16667628 |
| 26 | escrow | **borrower: escrow vote loan #1 (veBTC #1732) 100% on MUSD/mUSDC stable pool** | [0x1a50…0430](https://explorer.test.mezo.org/tx/0x1a50ee48bfa2a189fab44bbdccf936f6f630c4fe994766e0ce4d575529720430) | 16667636 |
| 27 | escrow | sponsor: approve 20 MUSD to MUSD/mUSDC bribe | [0x8461…58ca](https://explorer.test.mezo.org/tx/0x8461748b9ee875bd66163a8fa6159935edbde0ba39df1c3a72113a531b1158ca) | 16667640 |
| 28 | escrow | sponsor: bribe 20 MUSD on MUSD/mUSDC gauge (Mezo epoch 2026-11-05) | [0x203f…ad0f](https://explorer.test.mezo.org/tx/0x203fd6fb5dfb44df73c952b5e99dbb6dc7330876861018df679d445e0594ad0f) | 16667642 |
| 29 | morpho | borrower: approve 0.001 BTC to Morpho | [0x4890…8c44](https://explorer.test.mezo.org/tx/0x489064e85a4d42afa6a6667abbe0cd0749bbfdf2b5cd078c6dd11885bceb8c44) | 16667644 |
| 30 | morpho | borrower: Morpho supplyCollateral 0.001 BTC | [0xf9eb…589c](https://explorer.test.mezo.org/tx/0xf9eb091db4014a1cfb9f525e54ae5d2a9dec853cc27b33d72b1281ef4021589c) | 16667646 |
| 31 | morpho | borrower: Morpho borrow 25 MUSD (LTV 33.74%, LLTV 77.00%) | [0xcbb9…470c](https://explorer.test.mezo.org/tx/0xcbb985778ed1d8e71c4d7893dc172650048b30c31bbc755d852c35d69f4d470c) | 16667648 |
| 32 | peg | keeper wallet: peg override, MUSD at $0.94 for 10 min (StressedPegSource) | [0xbed9…e316](https://explorer.test.mezo.org/tx/0xbed9c4b242677a105923c898d371f34afe68777a660bee7df665a1ae770be316) | 16667653 |
| 33 | peg | **borrower: borrowMore 1 MUSD on loan #1 while MUSD is off its peg (refused on chain: PegUnhealthy) [reverted on chain]** | [0x6438…8e16](https://explorer.test.mezo.org/tx/0x6438e38d8cd1dfb4f522a6c72c25cf987e97e98201d2838d2f7a7942633f8e16) | 16667654 |
| 34 | peg | keeper wallet: peg override cleared, MUSD back at $1 | [0x2bd2…ac38](https://explorer.test.mezo.org/tx/0x2bd278fb0737d24b7684c9e7fd95df097984843630b3e17e8aa7e9997f7bac38) | 16667659 |
| 35 | liquidate | borrower: approve 0.001 BTC to veBTC | [0x0128…e673](https://explorer.test.mezo.org/tx/0x012893223f7c5ffde511dbc6d7f699aa5e3e1cbb56c46a7af655d981ddcae673) | 16667666 |
| 36 | liquidate | borrower: veBTC lock #1733 created (0.001 BTC, 28 days) for the auction loan | [0x0939…5077](https://explorer.test.mezo.org/tx/0x09396f68ea5c2758a2353ff63374abc7bfbb5113a576ae61be20a8b1de1a5077) | 16667671 |
| 37 | liquidate | borrower: approve veBTC #1733 to credit line | [0xb67d…c21d](https://explorer.test.mezo.org/tx/0xb67ded0cd14edf1fd28cf2076d8871a51e57167acf27e2a564655f7c7b8cc21d) | 16667675 |
| 38 | liquidate | borrower: veBTC loan #2 opened on #1733 (35 MUSD, LTV 47.20%; 0.0875 MUSD origination fee to the treasury), the loan the shock sends to auction | [0x539f…3265](https://explorer.test.mezo.org/tx/0x539f2e7a9d331870bc41cd1c99d86ea14d22b3fe18f52aeff8702e2317c03265) | 16667678 |
| 39 | liquidate | keeper wallet: shock −32.59% for 20 min (StressedPriceSource) | [0xb206…d00f](https://explorer.test.mezo.org/tx/0xb2066af885c361d1c7bbd1a378bef126eed673254386871c129c4cbcbde4d00f) | 16667696 |
| 40 | liquidate | keeper wallet: veBTC auction started (loan #2, LTV 69.95% at the shocked price) | [0x14d3…4643](https://explorer.test.mezo.org/tx/0x14d39883aa93586a82b2867b3bb4bdf51f5146361dc0c4092ee236a4a4344643) | 16667702 |
| 41 | liquidate | bidder: approve MUSD to credit line (bid) | [0xc6cc…4653](https://explorer.test.mezo.org/tx/0xc6cc327a2ddf8ea9f18c3aaa35e2f9bb2da7950f1616387e08a2a5ccddcf4653) | 16667776 |
| 42 | liquidate | **bidder: veBTC auction bid on loan #2 at 92.50% of collateral, above debt + fee (no shortfall)** | [0x69ba…aae1](https://explorer.test.mezo.org/tx/0x69ba998d4a6071942e0c77873dd5f554ec04f2415ad806ff0ce720cc9652aae1) | 16667778 |
| 43 | liquidate | keeper wallet: shock cleared (BTC back at its Skip price) | [0xb017…a632](https://explorer.test.mezo.org/tx/0xb0170f4d32937e189a191eddb15e8344d811daeca38d4acc603a7807baf1a632) | 16667781 |
| 44 | market | lender: approve 20 srMUSD to ShareMarket | [0xc2fd…dca2](https://explorer.test.mezo.org/tx/0xc2fdf55efc8de9b96c794b33fc9d7a34db60b887cf937a24d22c37d9f9f6dca2) | 16667789 |
| 45 | market | lender: list 20 srMUSD at 1.00% below the share price (listing #1) | [0x7021…af2f](https://explorer.test.mezo.org/tx/0x70219e3e4abba568bfbb11780a873b52207aca822593858c283c09002c23af2f) | 16667793 |
| 46 | market | share buyer: approve 9.9103 MUSD to ShareMarket | [0x6dee…a3b4](https://explorer.test.mezo.org/tx/0x6deed3b821447fe75e9201fdf1be19f6f39f2ddeafcb6c7a619efa253cf7a3b4) | 16667799 |
| 47 | market | **share buyer: fill 10 srMUSD of listing #1 for 9.9004 MUSD (fee 0.0099 MUSD to the treasury)** | [0x741e…de8a](https://explorer.test.mezo.org/tx/0x741e1b596a09c35b382c5ef245c16a168ea6eb725f86e09b2ceb2088ecbfde8a) | 16667801 |
| 48 | market | lender: cancel listing #1 (10 srMUSD back) | [0x9995…e828](https://explorer.test.mezo.org/tx/0x99951f4ae7ce88ea016493bc872c908eea30f51c11930cd20b4ee86b3a4ee828) | 16667807 |
| 49 | kit | **starter-kit relayer: starter kit #1 for team test wallet 0x7e87…759a (not an outside user)** | [0x823f…1477](https://explorer.test.mezo.org/tx/0x823f99fc7d1e6efb55facc06676708f48fc994ee111de45259847107e5321477) | 16667811 |
| 50 | epoch | Surety keeper: poke #1711 (epoch 07:00 UTC) | [0xc69a…fea1](https://explorer.test.mezo.org/tx/0xc69a97efa5e8874c166b0c1011a82f6e563266bf99e21922ba5514c2d78cfea1) | 16667830 |
| 51 | epoch | Surety keeper: rebalance (epoch 07:00 UTC) on the 06:00 tally: 0.84 MUSD of line interest, the lenders' part of the liquidation fee included, attributed to cohort 06:00 | [0x98e8…9301](https://explorer.test.mezo.org/tx/0x98e8c8207a98d16212b75c61013721707cd47b0847cdd5741797b296e3519301) | 16667832 |
| 52 | harvest | **harvest after the Mezo flip (Thu 2026-11-12 00:00 UTC) (not recorded yet)** | PENDING | — |

<!-- proof:lifecycle-v2:end -->

What the run shows, from its events:

- **lend.** The 100 MUSD deposit goes straight to sMUSD: VaultV2 allocates it to the SavingsAdapter, the vault's liquidity adapter, and leaves no idle MUSD.
- **vote.** #1711 (voting power 0.001045) votes 30% for line 0 (BTC / MUSD on Morpho) and 70% for line 1 (veBTC line); the sponsor posts 10 MUSD of incentives on each. The rebalance takes 108 MUSD (90% of 120) out of sMUSD: 32.40 to the Morpho market and 75.60 to the veBTC line. The 12.00 MUSD buffer stays parked in sMUSD.
- **loan.** 25 MUSD against a 0.003 BTC lock (221.86 MUSD at 73,953 MUSD/BTC), LTV 11.26%. `OriginationFeePaid` shows 0.0625 MUSD (25 bps) going to the treasury: the borrower receives 24.9375 and owes 25. Auto-repay is then switched on.
- **escrow.** The loan's escrow votes veBTC #1732 100% on the MUSD/mUSDC stable pool of Mezo's PoolsVoter, and the sponsor posts a 20 MUSD bribe on that gauge for the Mezo epoch of 2026-11-05. The escrow holds 0.41% of the gauge's votes, about 0.17 MUSD of the epoch's 40 MUSD of bribes at today's shares, claimable from the flip on 2026-11-12 00:00 UTC (the PENDING harvest row).
- **morpho.** 0.001 BTC posted on Mezo's own testnet Morpho (market `0xf0bb…e3ff`, LLTV 77%) and 25 MUSD borrowed at 33.7% LTV.
- **peg.** The stressed peg source reads $0.94: `pegHealthy()` turns false and the allocator's gate shuts, while BTC stays priced at BTC/USD (an unhealthy peg prices MUSD at exactly $1). A `borrowMore` sent anyway, with an explicit 500,000 gas limit, reverts on chain with `PegUnhealthy`. The override is then cleared and the peg reads healthy again.
- **liquidate.** A second loan of 35 MUSD at 47.2% LTV on a 0.001 BTC lock. The keeper wallet shocks BTC/USD by 32.59% (74,167 to 50,032), which puts this loan at 69.95% (the line auctions from 65%) while loan #1 only goes to 16.7% and the Morpho position to 50.0%, and starts the auction. After 300 s of decay the bidder pays 46.13 MUSD, about 92% of the 50.08 MUSD collateral, for a debt of 35.00: no shortfall, 10.08 MUSD of surplus to the borrower, and the 1.05 MUSD fee (3% of the debt) split by `LiquidationFeePaid` into 0.84 for lenders, 0.105 for the treasury and 0.105 for the keeper wallet that started the auction. The floor, 42.57 MUSD, would still have covered debt and fee (36.05): at the trigger the 85% floor keeps a fresh loan whole. Bad debt stays at zero, so deposits never paused.
- **market.** The lender lists 20 srMUSD at 1% below the share price. The share buyer fills 10 for 9.9004 MUSD (worth 10.0004): 9.8905 to the lender, 0.0099 (10 bps) to the treasury. The lender cancels the other 10.
- **savings.** No harvest was sent: testnet sMUSD paid no yield during the run (its yield index did not move), so the adapter had nothing to claim.
- **kit.** The Sponsor's relayer hands a team test wallet its starter kit: veBTC #1734 (0.001 BTC), 0.00005 BTC for gas and 50 MUSD. It is labelled as a team wallet, not an outside user.
- **epoch.** At the 07:00 UTC flip the keeper pokes #1711's ballot and rebalances on the closed 06:00 tally. The 0.84 MUSD the veBTC line earned, almost all of it the lenders' part of the liquidation fee, is attributed to cohort 06:00 (`InterestAttributed`, `FeesDistributed`).
- **harvest** (after 2026-11-12 00:00 UTC). With auto-repay on, anyone may `harvest` loan #1: the bribe MUSD repays the loan and the veBTC rebase compounds into the lock. The keeper harvests auto-repay loans as soon as their rewards are claimable; `--phase harvest` records that transaction, or sends the harvest itself.

Reproduce, from the repository root (the two `.env` files hold the keys; keep them outside the repository):

```sh
pnpm --filter @surety/keeper build:scripts
node keeper/dist/scripts/testnet-cycle-v2.js --phase all --env-file <.env> --roles-file <roles .env> [--dry-run]
node keeper/dist/scripts/testnet-cycle-v2.js --phase harvest --env-file <.env> --roles-file <roles .env>   # after the bribe's Mezo epoch
```

## Live lifecycle on testnet

`keeper/scripts/testnet-cycle.ts` ran Surety's whole lifecycle on the v1 testnet deployment ([`contracts/deployments/v1/31611.json`](../contracts/deployments/v1/31611.json)) from the deployer account [`0x37D5…C282`](https://explorer.test.mezo.org/address/0x37D5EDC6D74c9f6BfA98A2fed0A811B3B73AC282), with its veBTC NFTs #1711 and #1712. Every mined transaction is appended to `proof.txs` in the deployment file as `{ label, hash, block }`, and the table below is rendered from that file by [`docs/proof-table.mjs`](proof-table.mjs). Rows marked PENDING are steps the run has not recorded yet; re-render with `node docs/proof-table.mjs --write` once it has.

<!-- proof:lifecycle:start -->
Rendered by `node docs/proof-table.mjs` from `contracts/deployments/v1/31611.json`: 35 transactions recorded, 0 steps PENDING.

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
| 29 | other | approve 0.005 BTC to veBTC | [0xeac6…3464](https://explorer.test.mezo.org/tx/0xeac64333b00d3e22be580b23bf6e220529d1b2a38ab5b9969e9a74deb2983464) | 16664788 |
| 30 | other | veBTC lock #1731 created (0.005 BTC, 28 days) | [0xb17f…7952](https://explorer.test.mezo.org/tx/0xb17fbd2cfe5fd41b4c6590ab2665fbb6b217ec57706872188d8d4d2f9b5e7952) | 16664789 |
| 31 | other | approve veBTC #1731 to credit line | [0x8931…7751](https://explorer.test.mezo.org/tx/0x89311fa91f6b00a6209d7d0137d858402f836b49c17c2091f7153b59780b7751) | 16664792 |
| 32 | other | veBTC loan opened #1731 (10 MUSD) | [0x8252…cd22](https://explorer.test.mezo.org/tx/0x8252f377de96122cbbe1a4a37e840d03a9690e86fda156a8da13a0575675cd22) | 16664793 |
| 33 | other | escrow vote loan #2 (veBTC #1731) 100% on MUSD/mUSDC stable pool | [0x1b78…9612](https://explorer.test.mezo.org/tx/0x1b78236ede57063dedf03347ee23c1c4ccc3920f081495332b5d997f17c99612) | 16664795 |
| 34 | other | approve 20 MUSD to MUSD/mUSDC bribe | [0x7d89…f97a](https://explorer.test.mezo.org/tx/0x7d89d72590cd317b968d1191849b6bb83c14521de704355b3c7c0ddba0e9f97a) | 16664798 |
| 35 | other | bribe 20 MUSD on MUSD/mUSDC gauge (Mezo epoch 2026-11-05) | [0xef7a…919b](https://explorer.test.mezo.org/tx/0xef7ab6f4f99ef53b81d568de533ddd140711f8d86685113e787bb0a220a7919b) | 16664799 |

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

Counts at `23f8596`, run on 2026-11-09.

### Foundry

```sh
cd contracts
forge test
# Ran 36 test suites: 379 tests passed, 0 failed, 4 skipped (383 total tests)
forge test --summary   # per-suite table
```

| Suite | Passed |
| --- | --- |
| `VeBTCCreditLineTest` | 40 |
| `SuretyPoolTest` | 35 |
| `CreditVoterTest` | 34 |
| `PegTest` | 26 |
| `VoteAllocatorTest` | 22 |
| `MezoMocksTest` | 21 |
| `OraclesTest` | 21 |
| `ShareMarketTest` | 21 |
| `SavingsAdapterTest` | 17 |
| `SponsorTest` | 16 |
| `VoteAllocatorSavingsTest` | 11 |
| `HarvestTest` | 9 |
| `FixtureTest` | 7 |
| `LinearKinkIrmTest` | 6 |
| `LoanEscrowTest` | 5 |
| `DepositGateTest` | 4 |
| `EpochLibTest` | 4 |
| `ShareMarketFuzzTest` | 3 |
| `VoteAllocatorLossTest` | 1 |
| `LifecycleSavingsTest` (integration: `LifecycleTest`'s 3 with sMUSD parking, plus 2) | 5 |
| `LifecycleTest` (integration) | 3 |
| `ShareMarketSuretyTest` (integration) | 2 |
| `SponsorSuretyTest` (integration) | 1 |
| `DeployScriptTest` (the deploy script against local stand-ins for Mezo) | 7 |
| `AuditPoCTest` (v1 review regressions) | 10 |
| `AuditV2GateTest` (v2 review: 3 regressions, plus `SuretyPoolTest` re-run with the production fees) | 38 |
| `AuditV2GateLifecycleTest` (v2 review: 1 regression, plus `LifecycleTest` re-run) | 4 |
| `AuditV2LineTest` (v2 review regressions) | 2 |
| `AuditV2PegTest` (v2 review regression) | 1 |
| `SuretyInvariants` (9 invariants, 256 runs × 64 calls) | 1 |
| `SuretyInvariantsWithSavings` (the same 9 with sMUSD parking) | 1 |
| `LineInvariants` (6 invariants, 256 runs × 64 calls) | 1 |
| `LiveMezoTest`, `LivePegTest`, `LiveSavingsTest`, `AuditV2ForkTest` (fork, opt-in) | 0, 1 skipped each |

The system invariants: `invariant_vaultAssetsBacked`, `invariant_lineAccounting`, `invariant_cohortConservation`, `invariant_coverNeverExceedsLoss`, `invariant_depositGate`, `invariant_accrualStaysCheap`, `invariant_tallyConservation`, `invariant_escrowsHoldTheirNFT`, `invariant_savingsAccounting`. The line invariants: `invariant_booksBalance`, `invariant_cashMatchesLedger`, `invariant_feeConservation`, `invariant_badDebtIsShortfalls`, `invariant_noBorrowingWhileUnhealthy`, `invariant_escrowsHoldTheirNFT`. Any revert in a handler action fails the run. Fuzzed unit tests run 512 times.

```sh
forge test --match-contract 'AuditPoCTest|AuditV2'   # the review regressions
SURETY_FORK=true forge test --match-contract 'LiveMezo|LivePeg|LiveSavings|AuditV2Fork'
# against live Mezo mainnet state; SURETY_FORK_RPC overrides the RPC
# Ran 4 test suites: 18 tests passed, 0 failed, 0 skipped (18 total tests)
```

### TypeScript

```sh
pnpm install
pnpm test
# @surety/sdk 83 passed, @surety/keeper 56 passed, @surety/mcp 13 passed, web 21 passed: 173 in total
```

## Reproduce the lifecycle

The lifecycle script needs a deployment made with `STRESS=true` (the shock goes through `StressedPriceSource`) and an account holding testnet MUSD (1,000 to deposit, 250 for incentives, and enough to liquidate and bid), 0.004 BTC for the Morpho collateral plus gas, and two veBTC NFTs with voting power. The NFT ids are constants at the top of the script (`BALLOTS`, `LOAN_NFT`); change them to your own.

```sh
# 1. Deploy your own stress deployment (writes contracts/deployments/31611.json unless DEPLOYMENT_OUT is set)
cd contracts
STRESS=true RELAYER_ADDRESS=<starter-kit relayer> DEPLOYMENT_OUT=deployments/mine.31611.json \
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
