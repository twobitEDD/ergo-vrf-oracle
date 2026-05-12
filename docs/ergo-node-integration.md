# ERGO Node Integration Notes

## Target model

1. Operators run small agents next to ERGO node/indexer access.
2. Agent watches for active rounds and submits entropy contributions.
3. Coordinator finalizes round and publishes seed metadata.
4. Consumers derive application-specific seed (`H(roundSeed || appId || nonce)`).

## Suggested integration work

- Add signed operator payload format
- Add indexer-backed round storage
- Add commit/reveal variant for stronger anti-front-running guarantees
