# ERGO VRF-Style Oracle Feasibility Project

This project explores a practical path to deliver verifiable randomness for ERGO applications using many node operators who submit entropy and earn rewards.

## Project Structure

```text
ergo-vrf-oracle/
  demo-site/
  docs/
  scripts/
  src/
  test/
```

## Quick Start

```bash
npm install
npm run simulate
npm test
```

## Demo Explorer (Local)

```bash
npm install
npm run demo:dev
```

Open `http://127.0.0.1:4173`.

## Railway Deployment (Demo Server)

Deploy with:

1. Service root directory: repository root (if this is a standalone repo).
2. Build command: `npm install && npm run build`
3. Start command: `npm start`

Verification:

- `GET /healthz` -> `{ "ok": true }`
- `GET /api/state` -> state JSON

## Service Modes

The service now supports two runtime modes via `VRF_SERVICE_MODE`:

- `coordinator` (default): runs the oracle coordinator HTTP API (`scripts/demo-server.ts`)
- `operator`: runs an autonomous operator client loop (`scripts/operator-client.ts`)

This enables running one coordinator plus multiple operator instances as separate Railway services.

### Coordinator env

```bash
VRF_SERVICE_MODE=coordinator
PORT=4173
HOST=0.0.0.0
```

### Operator env

```bash
VRF_SERVICE_MODE=operator
VRF_ORACLE_URL=https://<your-coordinator-service>.up.railway.app
VRF_OPERATOR_ID=operator-a
VRF_OPERATOR_SECRET=replace-with-unique-secret
VRF_OPERATOR_REWARD_ADDRESS=9foperatora
VRF_OPERATOR_STAKE_AMOUNT=1000
VRF_OPERATOR_INTERVAL_MS=5000
VRF_OPERATOR_WHITELISTED=true
```

Operator behavior:

1. Idempotently registers with `POST /api/operators/ensure`
2. Polls `GET /api/rounds/active`
3. Submits deterministic entropy to active rounds once per round

## Coordinator API Additions

- `POST /api/operators/ensure` idempotent registration
- `GET /api/rounds/active` active round payload (or `null`)

## Included docs

- `docs/api-design.md`
- `docs/technical-feasibility.md`
- `docs/ergo-node-integration.md`
