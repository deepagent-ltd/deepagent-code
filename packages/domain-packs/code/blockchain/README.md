# Blockchain & Smart Contracts (Solidity/EVM)

## Boundary

This pack governs smart-contract and blockchain engineering on EVM chains: Solidity contracts, the EVM execution and gas model, reentrancy and other on-chain attack surfaces, on-chain versus off-chain data placement, transaction signing and wallets, and contract upgrade and deployment patterns. The defining constraints are that deployed code is immutable, all state is public, and every operation costs gas paid by the caller.

## Out of Scope

It does not cover the underlying signature math (code.cryptography owns ECDSA/key handling), general application security beyond the chain (risk.security), or generic test-harness setup (code.testing). It also does not provide trading, token-economic, or financial advice. It assumes a development chain, compiler (solc/Foundry/Hardhat), and a funded test account exist.

## Default Posture

Treat every deployed contract as immutable public code holding real value that adversaries will attack for profit. Follow checks-effects-interactions, assume any external call can re-enter, distrust all external contracts and inputs, and remember on-chain data is never secret. A contract that passes happy-path tests is not safe; require adversarial tests, gas analysis, and review before any mainnet deployment, which this pack never performs automatically.

## Evidence Rules

Positive documents are indexed for max/ultra; skills may also list high. All positive documents use medium or strong evidence and must be checked against current repository evidence before use. Failure dossiers are diagnostic do-not-use signals and are excluded from index.json.

## Provenance

Domain-pack seed material; provenance_tag is domain_pack:code.blockchain.

## L3 Validation

Activation and retrieval smoke live in `evals/smoke/l3-smoke.json`; the quality report in `quality/l3-report.json`.
