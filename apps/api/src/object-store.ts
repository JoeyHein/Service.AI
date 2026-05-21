/**
 * Photo / object storage adapter (TASK-CJ-07).
 *
 * ObjectStore — presigned-URL interface for DO Spaces / S3-compatible
 * stores. Dev + test impls return fake URLs so no network / no real
 * bucket is needed. Production wires @aws-sdk/s3-request-presigner
 * behind the DO_SPACES_* env vars.
 */

export interface PresignedUpload {
  /** HTTP PUT URL the browser uploads bytes to. */
  uploadUrl: string;
  /** Opaque key persisted to job_photos.storage_key. */
  storageKey: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

export interface ObjectStore {
  /**
   * Generate a short-lived PUT URL + the storage key the client must
   * send with any subsequent "finalise" call. Implementations must
   * scope the URL to the given content-type.
   */
  getUploadUrl(key: string, contentType: string): Promise<PresignedUpload>;
  /**
   * Generate a short-lived GET URL for reading the object. Used by the
   * web UI to render photo galleries. Never persist these — always
   * re-fetch on demand.
   */
  getDownloadUrl(key: string): Promise<string>;
  /**
   * Server-side upload of bytes already held by the API (e.g. a base64
   * door image POSTed by the door-designer widget). Returns the storage
   * key. Prefer presigned `getUploadUrl` for browser-direct uploads;
   * this is for payloads that arrive at the server.
   */
  putObject(key: string, body: Uint8Array, contentType: string): Promise<string>;
}

const DEFAULT_EXPIRY_SECONDS = 15 * 60;

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i;
const MAX_IMAGE_BYTES = 5_000_000;

/**
 * Decode a door-designer image (a `data:image/...;base64,...` URL, or a bare
 * base64 PNG) and store it server-side. Returns the storage key, or null when
 * the input is missing/oversized/unparseable — image capture is best-effort,
 * never blocks lead intake.
 */
export async function storeDoorImage(
  store: ObjectStore,
  key: string,
  doorImage: string | undefined,
): Promise<string | null> {
  if (!doorImage) return null;
  const m = DATA_URL_RE.exec(doorImage);
  const contentType = m ? m[1]! : 'image/png';
  const base64 = m ? m[2]! : doorImage;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  try {
    return await store.putObject(key, bytes, contentType);
  } catch {
    return null;
  }
}

/**
 * In-memory dev stub. Records issued keys so tests can assert, but
 * never opens a socket. Upload + download URLs are fake placeholders
 * recognisably prefixed with stub://.
 */
export function stubObjectStore(): ObjectStore {
  return {
    async getUploadUrl(key, contentType) {
      const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_SECONDS * 1000).toISOString();
      return {
        uploadUrl: `stub://upload/${encodeURIComponent(key)}?content-type=${encodeURIComponent(contentType)}`,
        storageKey: key,
        expiresAt,
      };
    },
    async getDownloadUrl(key) {
      return `stub://download/${encodeURIComponent(key)}`;
    },
    async putObject(key) {
      // No socket in dev/test — echo the key back so callers can persist it.
      return key;
    },
  };
}

/**
 * Production impl. Dynamic-import the AWS SDK so the dep is only
 * loaded when a real bucket is configured — matches the pattern used
 * by googlePlacesClient. bucket + endpoint + region + credentials come
 * from env vars resolved at call time; the factory binds them once.
 */
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional override for the expiry; defaults to 15 minutes. */
  expirySeconds?: number;
}

export async function s3ObjectStore(cfg: S3Config): Promise<ObjectStore> {
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import(
    '@aws-sdk/client-s3'
  );
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const expiresIn = cfg.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  return {
    async getUploadUrl(key, contentType) {
      const cmd = new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        ContentType: contentType,
      });
      const url = await getSignedUrl(client, cmd, { expiresIn });
      return {
        uploadUrl: url,
        storageKey: key,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    },
    async getDownloadUrl(key) {
      const cmd = new GetObjectCommand({ Bucket: cfg.bucket, Key: key });
      return getSignedUrl(client, cmd, { expiresIn });
    },
    async putObject(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
      return key;
    },
  };
}
