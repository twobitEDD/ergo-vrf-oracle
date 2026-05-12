# API Design (Demo)

## Endpoints

- `GET /healthz`
  - Returns `{ "ok": true }`.
- `GET /api/state`
  - Returns operators, rounds, and active round metadata.
- `POST /api/operators`
  - Body: `{ id, rewardAddress, stakeAmount, reputationScore?, isWhitelisted? }`
- `POST /api/rounds/start`
  - Body: `{ roundId, rewardPool, entropyDomainTag, maxSubmissions }`
- `POST /api/rounds/submit`
  - Body: `{ operatorId, entropyHex }`
- `POST /api/rounds/finalize`
  - Finalizes active round and returns explorer view.
