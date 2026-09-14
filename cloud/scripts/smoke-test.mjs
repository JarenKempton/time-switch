const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
const path = "/device/v1/provision";
const body = JSON.stringify({
  deviceId: "00000000-0000-4000-8000-000000000000",
  setupToken: "0".repeat(64),
  firmwareVersion: "deployment-smoke",
});

if (!baseUrl) throw new Error("BASE_URL is required.");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body,
    signal: controller.signal,
  });
  const payload = await response.json().catch(() => null);
  if (
    response.status !== 401 ||
    payload?.error?.code !== "invalid_setup_token"
  ) {
    throw new Error(
      `Smoke test failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      service: "time-switch",
      storage: "ready",
      workerVersion: response.headers.get("x-worker-version"),
      requestId: response.headers.get("x-request-id"),
    }),
  );
} finally {
  clearTimeout(timeout);
}
