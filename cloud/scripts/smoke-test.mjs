const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
const path = "/device/v1/provision";
const attempts = Number(process.env.SMOKE_ATTEMPTS ?? 10);
const retryDelayMs = Number(process.env.SMOKE_RETRY_DELAY_MS ?? 3_000);
const body = JSON.stringify({
  deviceId: "00000000-0000-4000-8000-000000000000",
  setupToken: "0".repeat(64),
  firmwareVersion: "deployment-smoke",
});

if (!baseUrl) throw new Error("BASE_URL is required.");
let lastFailure = "No response received.";
let result = null;

for (let attempt = 1; attempt <= attempts; attempt += 1) {
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
      response.status === 401 &&
      payload?.error?.code === "invalid_setup_token"
    ) {
      result = {
        ok: true,
        service: "time-switch",
        storage: "ready",
        attempts: attempt,
        workerVersion: response.headers.get("x-worker-version"),
        requestId: response.headers.get("x-request-id"),
      };
      break;
    }
    lastFailure = `HTTP ${response.status} with code ${payload?.error?.code ?? "unknown"}`;
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  if (attempt < attempts)
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
}

if (!result)
  throw new Error(
    `Smoke test failed after ${attempts} attempts: ${lastFailure}`,
  );
console.log(JSON.stringify(result));
