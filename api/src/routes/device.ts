import { randomBytes } from 'node:crypto';

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
  DeviceEventsRequestSchema,
  DeviceRegisterRequestSchema,
  DeviceRegisterResponseSchema,
  DeviceSyncQuerySchema,
  DeviceSyncResponseSchema,
  ErrorSchema,
} from '../schemas.js';
import type { Database } from '../db/types.js';
import { presignGet, type S3Config } from '../storage/s3.js';

const ISO = (d: Date | string): string =>
  (d instanceof Date ? d : new Date(d)).toISOString();

const CLAIM_CODE_TTL_SEC = 15 * 60;

function newClaimCode(): string {
  // 9 chars, base32-ish, ambiguous chars stripped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = randomBytes(9);
  let out = '';
  for (const b of buf) out += alphabet[b % alphabet.length];
  return out;
}

interface DeviceDeps {
  db: Kysely<Database>;
  s3?: S3Client | undefined;
  s3Config?: S3Config | undefined;
}

const SYNC_PRESIGN_TTL_SEC = Number(process.env.SYNC_PRESIGN_TTL_SEC ?? 1800);

export const deviceRoutes = (deps: DeviceDeps): FastifyPluginAsyncZod => async (app) => {
  const { db, s3, s3Config } = deps;

  app.post(
    '/device/register',
    {
      preHandler: app.requireDevice,
      schema: {
        body: DeviceRegisterRequestSchema,
        response: {
          200: DeviceRegisterResponseSchema,
          401: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const deviceId = req.device?.id;
      if (!deviceId) return reply.code(401).send({ code: 'unauthorized', message: 'unauthorized' });

      const { serial, firmwareVersion, macAddress } = req.body;

      const row = await db
        .selectFrom('devices')
        .select([
          'id',
          'serial',
          'owner_id',
          'name',
          'state',
          'firmware_version',
          'mac_address',
          'last_seen_at',
          'claim_code',
          'claim_code_expires_at',
          'created_at',
        ])
        .where('id', '=', deviceId)
        .executeTakeFirst();

      if (!row) {
        return reply.code(401).send({ code: 'unauthorized', message: 'unknown device' });
      }
      if (row.serial !== serial) {
        return reply.code(422).send({ code: 'serial_mismatch', message: 'serial does not match' });
      }

      let claimCode = row.claim_code;
      let claimExpires = row.claim_code_expires_at;
      if (row.state === 'unclaimed' && (!claimCode || !claimExpires || claimExpires.getTime() <= Date.now())) {
        claimCode = newClaimCode();
        claimExpires = new Date(Date.now() + CLAIM_CODE_TTL_SEC * 1000);
      } else if (row.state !== 'unclaimed') {
        claimCode = null;
        claimExpires = null;
      }

      const now = new Date();
      const updated = await db
        .updateTable('devices')
        .set({
          firmware_version: firmwareVersion,
          mac_address: macAddress ?? row.mac_address,
          last_seen_at: now,
          updated_at: now,
          claim_code: claimCode,
          claim_code_expires_at: claimExpires,
        })
        .where('id', '=', deviceId)
        .returning(['id', 'serial', 'owner_id', 'name', 'state', 'firmware_version', 'last_seen_at', 'created_at'])
        .executeTakeFirstOrThrow();

      return reply.code(200).send({
        device: {
          id: updated.id,
          serial: updated.serial,
          ownerId: updated.owner_id,
          name: updated.name,
          state: updated.state,
          firmwareVersion: updated.firmware_version,
          lastSeenAt: updated.last_seen_at ? ISO(updated.last_seen_at) : null,
          createdAt: ISO(updated.created_at),
        },
        claimCode: claimCode ?? undefined,
      });
    },
  );

  app.get(
    '/device/sync',
    {
      preHandler: app.requireDevice,
      schema: {
        querystring: DeviceSyncQuerySchema,
        response: {
          200: DeviceSyncResponseSchema,
          304: z.null(),
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      if (!s3 || !s3Config) {
        throw app.httpErrors.serviceUnavailable('storage not configured');
      }
      const deviceId = req.device?.id;
      if (!deviceId) return reply.code(401).send({ code: 'unauthorized', message: 'unauthorized' });

      const device = await db
        .selectFrom('devices')
        .select(['id', 'owner_id', 'state', 'updated_at'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (!device || device.state !== 'claimed' || !device.owner_id) {
        return reply.code(401).send({ code: 'unauthorized', message: 'device not claimed' });
      }

      // Make sure a config row exists (defensive — claim creates one).
      const config =
        (await db
          .selectFrom('device_configs')
          .select(['light_sleep_after_sec', 'deep_sleep_after_sec', 'volume_max', 'led_brightness', 'updated_at'])
          .where('device_id', '=', deviceId)
          .executeTakeFirst()) ??
        (await db
          .insertInto('device_configs')
          .values({ device_id: deviceId })
          .returning(['light_sleep_after_sec', 'deep_sleep_after_sec', 'volume_max', 'led_brightness', 'updated_at'])
          .executeTakeFirstOrThrow());

      const cardRows = await db
        .selectFrom('card_bindings')
        .select(['uid', 'audio_id', 'bound_at', 'updated_at'])
        .where('device_id', '=', deviceId)
        .execute();

      const audioRows = await db
        .selectFrom('audios')
        .select(['id', 'sha256', 'size_bytes', 'transcoded_key', 'updated_at', 'ready_at'])
        .where('owner_id', '=', device.owner_id)
        .where('state', '=', 'ready')
        .execute();

      // 304 short-circuit: if `since` is at-or-after every modification timestamp.
      if (req.query.since) {
        const since = new Date(req.query.since);
        const newest = Math.max(
          device.updated_at?.getTime() ?? 0,
          config.updated_at?.getTime() ?? 0,
          ...cardRows.map((r) => r.updated_at?.getTime() ?? 0),
          ...audioRows.map((r) => Math.max(r.updated_at?.getTime() ?? 0, r.ready_at?.getTime() ?? 0)),
        );
        if (since.getTime() >= newest) {
          return reply.code(304).send(null);
        }
      }

      const audio = await Promise.all(
        audioRows
          .filter((r): r is typeof r & { sha256: string; transcoded_key: string } =>
            !!r.sha256 && !!r.transcoded_key,
          )
          .map(async (r) => {
            const url = await presignGet(s3, s3Config, r.transcoded_key, {
              expiresInSec: SYNC_PRESIGN_TTL_SEC,
            });
            return {
              id: r.id,
              sha256: r.sha256,
              ...(r.size_bytes !== null ? { sizeBytes: r.size_bytes } : {}),
              downloadUrl: url.url,
              expiresAt: url.expiresAt.toISOString(),
            };
          }),
      );

      // Touch last_seen_at; non-critical, best-effort.
      const now = new Date();
      db.updateTable('devices')
        .set({ last_seen_at: now })
        .where('id', '=', deviceId)
        .execute()
        .catch((err) => app.log.warn({ err, deviceId }, 'sync: failed to update last_seen_at'));

      return reply.code(200).send({
        serverTime: now.toISOString(),
        config: {
          lightSleepAfterSec: config.light_sleep_after_sec,
          deepSleepAfterSec: config.deep_sleep_after_sec,
          volumeMax: config.volume_max,
          ...(config.led_brightness !== null ? { ledBrightness: config.led_brightness } : {}),
        },
        cards: cardRows.map((c) => ({
          uid: c.uid,
          audioId: c.audio_id,
          boundAt: ISO(c.bound_at),
        })),
        audio,
      });
    },
  );

  app.post(
    '/device/events',
    {
      preHandler: app.requireDevice,
      schema: {
        body: DeviceEventsRequestSchema,
        response: { 202: z.null(), 401: ErrorSchema, 422: ErrorSchema },
      },
    },
    async (req, reply) => {
      const deviceId = req.device?.id;
      if (!deviceId) return reply.code(401).send({ code: 'unauthorized', message: 'unauthorized' });

      const rows = req.body.events.map((e) => ({
        event_id: e.eventId,
        device_id: deviceId,
        ts: new Date(e.ts),
        type: e.type,
        payload: e.payload ?? null,
      }));

      await db
        .insertInto('device_events')
        .values(rows)
        .onConflict((oc) => oc.column('event_id').doNothing())
        .execute();

      // Touch last_seen_at. Non-critical.
      db.updateTable('devices')
        .set({ last_seen_at: new Date() })
        .where('id', '=', deviceId)
        .execute()
        .catch((err) => app.log.warn({ err, deviceId }, 'events: failed to update last_seen_at'));

      return reply.code(202).send(null);
    },
  );
};
