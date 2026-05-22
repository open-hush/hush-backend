import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

export function readS3Config(env: NodeJS.ProcessEnv = process.env): S3Config {
  const cfg = {
    endpoint: env.S3_ENDPOINT ?? '',
    region: env.S3_REGION ?? 'us-east-1',
    bucket: env.S3_BUCKET ?? '',
    accessKey: env.S3_ACCESS_KEY ?? '',
    secretKey: env.S3_SECRET_KEY ?? '',
    pathStyle: (env.S3_USE_PATH_STYLE ?? 'true').toLowerCase() === 'true',
  };
  for (const [k, v] of Object.entries(cfg)) {
    if (k !== 'pathStyle' && !v) throw new Error(`missing S3 config: ${k}`);
  }
  return cfg;
}

export function createS3Client(cfg: S3Config): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    forcePathStyle: cfg.pathStyle,
  });
}

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  expiresAt: Date;
  headers: Record<string, string>;
}

export async function presignPut(
  client: S3Client,
  cfg: S3Config,
  key: string,
  opts: { contentType: string; expiresInSec: number },
): Promise<PresignedUpload> {
  const cmd = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: opts.contentType,
  });
  const url = await getSignedUrl(client, cmd, { expiresIn: opts.expiresInSec });
  return {
    url,
    method: 'PUT',
    expiresAt: new Date(Date.now() + opts.expiresInSec * 1000),
    headers: { 'Content-Type': opts.contentType },
  };
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export async function presignGet(
  client: S3Client,
  cfg: S3Config,
  key: string,
  opts: { expiresInSec: number },
): Promise<PresignedDownload> {
  const cmd = new GetObjectCommand({ Bucket: cfg.bucket, Key: key });
  const url = await getSignedUrl(client, cmd, { expiresIn: opts.expiresInSec });
  return { url, expiresAt: new Date(Date.now() + opts.expiresInSec * 1000) };
}

export interface ObjectHead {
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
}

export async function headObject(
  client: S3Client,
  cfg: S3Config,
  key: string,
): Promise<ObjectHead | null> {
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
    return {
      contentLength: Number(res.ContentLength ?? 0),
      contentType: res.ContentType,
      etag: res.ETag?.replace(/^"|"$/g, ''),
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export async function getObjectStream(
  client: S3Client,
  cfg: S3Config,
  key: string,
): Promise<Readable> {
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`empty body for ${key}`);
  return body as Readable;
}

export async function putObjectFromBuffer(
  client: S3Client,
  cfg: S3Config,
  key: string,
  body: Buffer,
  opts: { contentType: string },
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      ContentLength: body.length,
    }),
  );
}

export async function deleteObject(
  client: S3Client,
  cfg: S3Config,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
}

export async function headBucket(client: S3Client, cfg: S3Config): Promise<void> {
  await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}

export type { ObjectIdentifier };
