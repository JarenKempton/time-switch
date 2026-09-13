import { createHash, createHmac } from "node:crypto";

const baseUrl = process.env.BASE_URL?.replace(/\/$/, "");
const deviceId = process.env.DEVICE_ID ?? "desk-panel";
const secret = process.env.DEVICE_HMAC_SECRET;
const path = "/device/v1/health";
const body = "{}";

if (!baseUrl) throw new Error("BASE_URL is required.");
if (!secret || secret.length < 32) {
  throw new Error("DEVICE_HMAC_SECRET must contain at least 32 characters.");
}

const timestamp = Math.floor(Date.now() / 1000).toString();
const bodyHash = createHash("sha256").update(body).digest("hex");
const canonical = [timestamp, "POST", path, bodyHash].join("\n");
const signature = createHmac("sha256", secret).update(canonical).digest("hex");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 15_000);

try {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-time-switch-device": deviceId,
      "x-time-switch-signature": `v1=${signature}`,
      "x-time-switch-timestamp": timestamp,
    },
    body,
    signal: controller.signal,
  });
  const payload = await response.json().catch(() => null);
  if (
    !response.ok ||
    payload?.data?.ok !== true ||
    payload?.data?.service !== "time-switch" ||
    payload?.data?.storage !== "ready"
  ) {
    throw new Error(
      `Smoke test failed with HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      service: payload.data.service,
      storage: payload.data.storage,
      workerVersion: response.headers.get("x-worker-version"),
      requestId: response.headers.get("x-request-id"),
    }),
  );
} finally {
  clearTimeout(timeout);
}
