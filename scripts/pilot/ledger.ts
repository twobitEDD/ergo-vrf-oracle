import { createRequire } from "node:module";
import { ErgoBox } from "@fleet-sdk/core";
import { BLOCKCHAIN_PARAMETERS, execute, mockBlockchainStateContext } from "@fleet-sdk/mock-chain";
import type { EIP12UnsignedTransaction } from "@fleet-sdk/common";
import type { LedgerBox } from "../../src/pilot/tx.js";
import type { RoleKey } from "./keys.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ergoLib: any = createRequire(import.meta.url)("ergo-lib-wasm-nodejs");

export interface SubmitResult {
  ok: boolean;
  txId: string;
  outputs: LedgerBox[];
  bytes?: number;
  reason?: string;
}

export interface Ledger {
  readonly kind: "mock" | "testnet";
  /** HEIGHT a transaction built now is checked against. */
  height(): Promise<number>;
  waitForHeight(height: number): Promise<void>;
  unspentByTokenId(tokenId: string): Promise<LedgerBox[]>;
  unspentByErgoTree(ergoTree: string): Promise<LedgerBox[]>;
  submit(tx: EIP12UnsignedTransaction, signers: RoleKey[]): Promise<SubmitResult>;
  /** Inclusion height, or undefined if the tx was dropped. */
  waitConfirmed(txId: string): Promise<number | undefined>;
}

type TxJson = {
  inputs: Array<Record<string, unknown> & { boxId: string; extension: Record<string, string> }>;
  dataInputs: Array<Record<string, unknown> & { boxId: string }>;
  outputs: Array<{ ergoTree: string; value: string; creationHeight: number; assets: { tokenId: string; amount: string }[]; additionalRegisters: Record<string, string> }>;
};

function unsignedFor(tx: EIP12UnsignedTransaction) {
  const json = tx as unknown as TxJson;
  return ergoLib.UnsignedTransaction.from_json(
    JSON.stringify({
      inputs: json.inputs.map((i) => ({ boxId: i.boxId, extension: i.extension })),
      dataInputs: json.dataInputs.map((d) => ({ boxId: d.boxId })),
      outputs: json.outputs
    })
  );
}

/** Output boxes of `tx`. The id of an unsigned tx is the id it will have once signed. */
export function outputsOf(tx: EIP12UnsignedTransaction): { txId: string; outputs: LedgerBox[] } {
  const txId: string = unsignedFor(tx).id().to_str();
  const outputs = (tx as unknown as TxJson).outputs.map(
    (o, i) =>
      new ErgoBox(
        {
          ergoTree: o.ergoTree,
          value: BigInt(o.value),
          creationHeight: o.creationHeight,
          assets: o.assets.map((a) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
          additionalRegisters: o.additionalRegisters
        },
        txId,
        i
      ).toPlainObject("EIP-12") as unknown as Record<string, unknown>
  );
  return { txId, outputs: outputs.map(normalizeBox) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeBox(raw: any): LedgerBox {
  return {
    boxId: raw.boxId,
    transactionId: raw.transactionId,
    index: raw.index,
    ergoTree: raw.ergoTree,
    creationHeight: raw.creationHeight,
    value: BigInt(raw.value),
    assets: (raw.assets ?? []).map((a: { tokenId: string; amount: string | number }) => ({ tokenId: a.tokenId, amount: BigInt(a.amount) })),
    additionalRegisters: raw.additionalRegisters ?? {}
  };
}

function boxJson(box: Record<string, unknown>) {
  const b = box as unknown as LedgerBox;
  return JSON.stringify({
    boxId: b.boxId,
    transactionId: b.transactionId,
    index: b.index,
    ergoTree: b.ergoTree,
    creationHeight: b.creationHeight,
    value: String(b.value),
    assets: b.assets.map((a) => ({ tokenId: a.tokenId, amount: String(a.amount) })),
    additionalRegisters: b.additionalRegisters
  });
}

/** In-memory ledger on the Fleet mock chain. Height only moves when told to. */
export class MockLedger implements Ledger {
  readonly kind = "mock" as const;
  private utxos = new Map<string, LedgerBox>();
  private confirmedAt = new Map<string, number>();

  constructor(private tip: number) {}

  seed(boxes: LedgerBox[]): void {
    for (const b of boxes) this.utxos.set(b.boxId, b);
  }

  async height(): Promise<number> {
    return this.tip;
  }

  async waitForHeight(height: number): Promise<void> {
    if (height > this.tip) this.tip = height;
  }

  async unspentByTokenId(tokenId: string): Promise<LedgerBox[]> {
    return [...this.utxos.values()].filter((b) => b.assets.some((a) => a.tokenId === tokenId));
  }

  async unspentByErgoTree(ergoTree: string): Promise<LedgerBox[]> {
    return [...this.utxos.values()].filter((b) => b.ergoTree === ergoTree);
  }

  async submit(tx: EIP12UnsignedTransaction, signers: RoleKey[]): Promise<SubmitResult> {
    const { txId, outputs } = outputsOf(tx);
    const json = tx as unknown as TxJson;
    const missing = json.inputs.find((i) => !this.utxos.has(i.boxId));
    if (missing) return { ok: false, txId, outputs: [], reason: `input ${missing.boxId} already spent` };
    const context = mockBlockchainStateContext({ headers: { quantity: 10, fromHeight: this.tip } });
    const result = execute(tx, signers.map((s) => s.hd), { context, parameters: BLOCKCHAIN_PARAMETERS });
    if (!result.success) return { ok: false, txId, outputs: [], reason: String(result.reason?.message ?? result.reason) };
    for (const i of json.inputs) this.utxos.delete(i.boxId);
    for (const o of outputs) this.utxos.set(o.boxId, o);
    this.confirmedAt.set(txId, this.tip);
    return { ok: true, txId, outputs };
  }

  async waitConfirmed(txId: string): Promise<number | undefined> {
    return this.confirmedAt.get(txId);
  }
}

/**
 * Ergo node ledger (needs the node's extra index for /blockchain lookups). Keeps a local overlay of
 * what this process spent and created, so dependent steps can be chained before blocks confirm them.
 */
export class NodeLedger implements Ledger {
  readonly kind = "testnet" as const;
  private spent = new Set<string>();
  private created = new Map<string, LedgerBox>();
  private pending = new Map<string, { inputs: string[]; outputs: string[] }>();

  constructor(private nodeUrl: string) {}

  private async get(path: string) {
    const res = await fetch(`${this.nodeUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  }

  private async post(path: string, body: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${this.nodeUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: res.status, text: await res.text() };
  }

  private async headers() {
    return this.get("/blocks/lastHeaders/10") as Promise<Array<{ height: number }>>;
  }

  async height(): Promise<number> {
    return (await this.headers())[0]!.height;
  }

  async waitForHeight(height: number): Promise<void> {
    while ((await this.height()) < height) {
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  private overlay(fromNode: LedgerBox[], match: (b: LedgerBox) => boolean): LedgerBox[] {
    const all = new Map<string, LedgerBox>();
    for (const b of fromNode) all.set(b.boxId, b);
    for (const b of this.created.values()) if (match(b)) all.set(b.boxId, b);
    return [...all.values()].filter((b) => !this.spent.has(b.boxId));
  }

  async unspentByTokenId(tokenId: string): Promise<LedgerBox[]> {
    const res = (await this.get(`/blockchain/box/unspent/byTokenId/${tokenId}?offset=0&limit=100`)) as { items?: unknown[] } | unknown[];
    const items = Array.isArray(res) ? res : (res.items ?? []);
    return this.overlay(items.map(normalizeBox), (b) => b.assets.some((a) => a.tokenId === tokenId));
  }

  async unspentByErgoTree(ergoTree: string): Promise<LedgerBox[]> {
    const res = await this.post(`/blockchain/box/unspent/byErgoTree?offset=0&limit=200`, JSON.stringify(ergoTree));
    if (res.status !== 200) throw new Error(`byErgoTree → ${res.status}: ${res.text.slice(0, 200)}`);
    const parsed = JSON.parse(res.text) as { items?: unknown[] } | unknown[];
    const items = Array.isArray(parsed) ? parsed : (parsed.items ?? []);
    return this.overlay(items.map(normalizeBox), (b) => b.ergoTree === ergoTree);
  }

  async submit(tx: EIP12UnsignedTransaction, signers: RoleKey[]): Promise<SubmitResult> {
    const { txId, outputs } = outputsOf(tx);
    const json = tx as unknown as TxJson;
    try {
      const headers = await this.headers();
      const ctx = new ergoLib.ErgoStateContext(
        ergoLib.PreHeader.from_block_header(ergoLib.BlockHeader.from_json(JSON.stringify(headers[0]))),
        ergoLib.BlockHeaders.from_json(headers),
        ergoLib.Parameters.default_parameters()
      );
      const secrets = new ergoLib.SecretKeys();
      for (const s of signers) secrets.add(ergoLib.SecretKey.dlog_from_bytes(Buffer.from(s.secretHex, "hex")));
      const signed = ergoLib.Wallet.from_secrets(secrets).sign_transaction(
        ctx,
        unsignedFor(tx),
        ergoLib.ErgoBoxes.from_boxes_json(json.inputs.map(boxJson)),
        json.dataInputs.length ? ergoLib.ErgoBoxes.from_boxes_json(json.dataInputs.map(boxJson)) : ergoLib.ErgoBoxes.empty()
      );
      const body = signed.to_json();
      const bytes = signed.sigma_serialize_bytes().length;
      const sent = await this.post("/transactions", body);
      if (sent.status !== 200) return { ok: false, txId, outputs: [], bytes, reason: `node ${sent.status}: ${sent.text.slice(0, 400)}` };
      for (const i of json.inputs) this.spent.add(i.boxId);
      for (const o of outputs) this.created.set(o.boxId, o);
      this.pending.set(txId, { inputs: json.inputs.map((i) => i.boxId), outputs: outputs.map((o) => o.boxId) });
      return { ok: true, txId, outputs, bytes };
    } catch (error) {
      return { ok: false, txId, outputs: [], reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async waitConfirmed(txId: string, timeoutMs = 20 * 60_000): Promise<number | undefined> {
    const started = Date.now();
    let missing = 0;
    while (Date.now() - started < timeoutMs) {
      const tx = await fetch(`${this.nodeUrl}/blockchain/transaction/byId/${txId}`);
      if (tx.ok) {
        this.pending.delete(txId);
        return ((await tx.json()) as { inclusionHeight: number }).inclusionHeight;
      }
      const inPool = await fetch(`${this.nodeUrl}/transactions/unconfirmed/byTransactionId/${txId}`);
      missing = inPool.ok ? 0 : missing + 1;
      if (missing >= 6) break;
      await new Promise((r) => setTimeout(r, 10_000));
    }
    // Dropped: undo the overlay so its inputs are usable again and its outputs are forgotten.
    const p = this.pending.get(txId);
    if (p) {
      for (const id of p.inputs) this.spent.delete(id);
      for (const id of p.outputs) this.created.delete(id);
      this.pending.delete(txId);
    }
    return undefined;
  }
}
