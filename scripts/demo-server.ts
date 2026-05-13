import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { OracleDemoService } from "../src/demoService.js";

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "0.0.0.0";
const STATIC_ROOT = resolve(process.cwd(), "demo-site");

const demoService = new OracleDemoService();

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function sendJson(response: ServerResponse<IncomingMessage>, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function parseJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

async function serveStatic(pathname: string, response: ServerResponse<IncomingMessage>): Promise<boolean> {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(STATIC_ROOT, normalized);
  try {
    const file = await readFile(fullPath);
    const contentType = MIME_TYPES[extname(fullPath)] ?? "application/octet-stream";
    response.statusCode = 200;
    response.setHeader("content-type", contentType);
    response.end(file);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (request, response) => {
  try {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, demoService.getState());
      return;
    }

    if (method === "GET" && url.pathname === "/api/rounds/active") {
      sendJson(response, 200, { activeRound: demoService.getActiveRound() });
      return;
    }

    if (method === "POST" && url.pathname === "/api/operators/ensure") {
      const body = await parseJsonBody<{
        id: string;
        rewardAddress: string;
        stakeAmount: string | number;
        reputationScore?: number;
        isWhitelisted?: boolean;
      }>(request);
      const ensured = demoService.ensureOperator({
        id: body.id,
        rewardAddress: body.rewardAddress,
        stakeAmount: BigInt(body.stakeAmount),
        reputationScore: body.reputationScore,
        isWhitelisted: body.isWhitelisted
      });
      sendJson(response, ensured.created ? 201 : 200, {
        created: ensured.created,
        operator: {
          ...ensured.operator,
          stakeAmount: ensured.operator.stakeAmount.toString()
        }
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/operators") {
      const body = await parseJsonBody<{
        id: string;
        rewardAddress: string;
        stakeAmount: string | number;
        reputationScore?: number;
        isWhitelisted?: boolean;
      }>(request);
      const operator = demoService.registerOperator({
        id: body.id,
        rewardAddress: body.rewardAddress,
        stakeAmount: BigInt(body.stakeAmount),
        reputationScore: body.reputationScore,
        isWhitelisted: body.isWhitelisted
      });
      sendJson(response, 201, {
        ...operator,
        stakeAmount: operator.stakeAmount.toString()
      });
      return;
    }

    if (method === "POST" && url.pathname === "/api/rounds/start") {
      const body = await parseJsonBody<{
        roundId: string;
        rewardPool: string | number;
        entropyDomainTag: string;
        maxSubmissions: number;
      }>(request);
      const round = demoService.startRound({
        roundId: body.roundId,
        rewardPool: BigInt(body.rewardPool),
        entropyDomainTag: body.entropyDomainTag,
        maxSubmissions: body.maxSubmissions
      });
      sendJson(response, 201, round);
      return;
    }

    if (method === "POST" && url.pathname === "/api/rounds/submit") {
      const body = await parseJsonBody<{ operatorId: string; entropyHex: string }>(request);
      const submission = demoService.submitEntropy(body.operatorId, body.entropyHex);
      sendJson(response, 200, submission);
      return;
    }

    if (method === "POST" && url.pathname === "/api/rounds/finalize") {
      const finalized = demoService.finalizeRound();
      sendJson(response, 200, finalized);
      return;
    }

    const served = await serveStatic(url.pathname, response);
    if (served) {
      return;
    }

    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "unknown error"
    });
  }
});

server.listen(PORT, HOST, () => {
  // Useful for local runs and deployment logs.
  console.log(`Demo server running at http://${HOST}:${PORT}`);
});
