const explorerOutput = document.querySelector("#explorer-output");
const eventLog = document.querySelector("#event-log");

function logLine(message) {
  const timestamp = new Date().toISOString();
  eventLog.textContent = `[${timestamp}] ${message}\n${eventLog.textContent || ""}`;
}

function formatState(state) {
  return JSON.stringify(state, null, 2);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

async function refresh() {
  const state = await api("/api/state");
  explorerOutput.textContent = formatState(state);
}

document.querySelector("#operator-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/operators", {
    id: form.get("id"),
    rewardAddress: form.get("rewardAddress"),
    stakeAmount: Number(form.get("stakeAmount"))
  });
  logLine(`registered operator ${form.get("id")}`);
  await refresh();
});

document.querySelector("#round-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  await api("/api/rounds/start", {
    roundId: form.get("roundId"),
    rewardPool: Number(form.get("rewardPool")),
    entropyDomainTag: form.get("entropyDomainTag"),
    maxSubmissions: Number(form.get("maxSubmissions"))
  });
  logLine(`started round ${form.get("roundId")}`);
  await refresh();
});

document.querySelector("#submit-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const result = await api("/api/rounds/submit", {
    operatorId: form.get("operatorId"),
    entropyHex: form.get("entropyHex")
  });
  logLine(`submission ${result.status} from ${form.get("operatorId")}`);
  await refresh();
});

document.querySelector("#finalize-btn").addEventListener("click", async () => {
  await api("/api/rounds/finalize", {});
  logLine("finalized active round");
  await refresh();
});

refresh().catch((error) => {
  logLine(`initial load failed: ${error.message}`);
});
