import { ApiError, ok } from "./http";

/** Logos live in the LOGOS R2 bucket and are served back through /logos/. */
export const LOGO_PATH_PREFIX = "/logos/";
const MAX_LOGO_BYTES = 1_000_000;
const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export interface LogoObject {
  key: string;
  url: string;
  size: number;
  contentType: string | null;
  uploadedAt: string;
}

function describe(object: R2Object): LogoObject {
  return {
    key: object.key,
    url: `${LOGO_PATH_PREFIX}${encodeURIComponent(object.key)}`,
    size: object.size,
    contentType: object.httpMetadata?.contentType ?? null,
    uploadedAt: object.uploaded.toISOString(),
  };
}

function safeBaseName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "").toLowerCase();
  return stem.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "logo";
}

export async function listLogos(bucket: R2Bucket): Promise<Response> {
  const listed = await bucket.list({
    limit: 200,
    include: ["httpMetadata"],
  });
  return ok(listed.objects.map(describe));
}

export async function uploadLogo(
  bucket: R2Bucket,
  request: Request,
): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    throw new ApiError(400, "missing_file", 'Attach an image as "file".');
  const extension = EXTENSIONS[file.type];
  if (!extension)
    throw new ApiError(
      415,
      "unsupported_image",
      "Logos must be PNG, JPEG, WebP, or SVG.",
    );
  if (file.size === 0 || file.size > MAX_LOGO_BYTES)
    throw new ApiError(
      413,
      "image_too_large",
      "Logos must be 1 MB or smaller.",
    );
  const key = `${safeBaseName(file.name)}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  const stored = await bucket.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });
  return ok(describe(stored), { status: 201 });
}

export async function deleteLogo(
  bucket: R2Bucket,
  key: string,
): Promise<Response> {
  const existing = await bucket.head(key);
  if (!existing)
    throw new ApiError(404, "logo_not_found", "That logo is not in storage.");
  await bucket.delete(key);
  return ok({ key });
}

export async function serveLogo(
  bucket: R2Bucket,
  key: string,
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object)
    throw new ApiError(404, "logo_not_found", "That logo is not in storage.");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=86400");
  if (!headers.has("content-type"))
    headers.set("content-type", "application/octet-stream");
  return new Response(object.body, { headers });
}
