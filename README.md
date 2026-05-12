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

## Included docs

- `docs/api-design.md`
- `docs/technical-feasibility.md`
- `docs/ergo-node-integration.md`
