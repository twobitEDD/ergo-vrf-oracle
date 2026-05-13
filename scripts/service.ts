const mode = (process.env.VRF_SERVICE_MODE ?? "coordinator").trim().toLowerCase();

if (mode === "operator") {
  await import("./operator-client.js");
} else {
  await import("./demo-server.js");
}
