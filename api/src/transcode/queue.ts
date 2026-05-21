import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { Kysely } from 'kysely';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyBaseLogger } from 'fastify';

import type { Database } from '../db/types.js';
import {
  deleteObject,
  getObjectStream,
  putObjectFromBuffer,
  type S3Config,
} from '../storage/s3.js';
import { transcodeToMp3 } from './ffmpeg.js';
import { readFile } from 'node:fs/promises';

export interface TranscodeDeps {
  db: Kysely<Database>;
  s3: S3Client;
  s3Config: S3Config;
  log: FastifyBaseLogger;
}

export interface TranscodeQueueOptions {
  maxConcurrency: number;
}

/**
 * In-process transcode queue. Caller pushes `audioId`s; the queue runs a bounded
 * number of jobs in parallel. Survives nothing — restart recovery is done at
 * boot by re-enqueueing rows whose `state='processing'`.
 */
export class TranscodeQueue {
  private inflight = 0;
  private pending: string[] = [];
  private closed = false;

  constructor(private readonly deps: TranscodeDeps, private readonly opts: TranscodeQueueOptions) {}

  enqueue(audioId: string): void {
    if (this.closed) return;
    this.pending.push(audioId);
    this.drain();
  }

  /** Re-enqueue every `processing` row owned by this instance. */
  async recoverOrphans(): Promise<number> {
    const rows = await this.deps.db
      .selectFrom('audios')
      .select('id')
      .where('state', '=', 'processing')
      .execute();
    for (const row of rows) this.enqueue(row.id);
    return rows.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.inflight > 0) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Test/observability hook. */
  get stats(): { inflight: number; pending: number } {
    return { inflight: this.inflight, pending: this.pending.length };
  }

  private drain(): void {
    while (this.inflight < this.opts.maxConcurrency && this.pending.length > 0) {
      const audioId = this.pending.shift()!;
      this.inflight += 1;
      this.runJob(audioId)
        .catch((err) => {
          this.deps.log.error({ err, audioId }, 'transcode job crashed');
        })
        .finally(() => {
          this.inflight -= 1;
          this.drain();
        });
    }
  }

  private async runJob(audioId: string): Promise<void> {
    const { db, s3, s3Config, log } = this.deps;

    const row = await db
      .selectFrom('audios')
      .select(['id', 'source_key'])
      .where('id', '=', audioId)
      .executeTakeFirst();

    if (!row) {
      log.warn({ audioId }, 'transcode job: audio row missing, skipping');
      return;
    }

    const work = await mkdtemp(join(tmpdir(), 'hush-job-'));
    const inputPath = join(work, 'source');

    try {
      log.info({ audioId, sourceKey: row.source_key }, 'transcode: downloading source');
      const stream = await getObjectStream(s3, s3Config, row.source_key);
      await pipeline(stream, createWriteStream(inputPath));

      log.info({ audioId }, 'transcode: running ffmpeg');
      const result = await transcodeToMp3(inputPath);

      const transcodedKey = `audio/${audioId}.mp3`;
      log.info({ audioId, transcodedKey, sizeBytes: result.sizeBytes }, 'transcode: uploading');
      const body = await readFile(result.outputPath);
      await putObjectFromBuffer(s3, s3Config, transcodedKey, body, { contentType: 'audio/mpeg' });

      await db
        .updateTable('audios')
        .set({
          state: 'ready',
          transcoded_key: transcodedKey,
          sha256: result.sha256Hex,
          size_bytes: result.sizeBytes,
          duration_ms: result.durationMs,
          ready_at: new Date(),
          updated_at: new Date(),
          failure_reason: null,
        })
        .where('id', '=', audioId)
        .execute();

      // Best-effort cleanup of the raw upload.
      try {
        await deleteObject(s3, s3Config, row.source_key);
      } catch (err) {
        log.warn({ err, audioId }, 'transcode: failed to delete source object');
      }

      log.info({ audioId }, 'transcode: ready');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error({ err, audioId }, 'transcode failed');
      await db
        .updateTable('audios')
        .set({ state: 'failed', failure_reason: reason.slice(0, 2000), updated_at: new Date() })
        .where('id', '=', audioId)
        .execute();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
