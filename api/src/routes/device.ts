import { randomBytes } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
  CardDownloadQuerySchema,
  CardDownloadSchema,
  DeviceEventsQuerySchema,
  DeviceEventsRequestSchema,
  DeviceRegisterRequestSchema,
  DeviceRegisterResponseSchema,
  DeviceSyncQuerySchema,
  DeviceSyncResponseSchema,
  ErrorSchema,
} from '../schemas.js';
import type { Database, DeviceState } from '../db/types.js';
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

// Columns every register response is built from. Kept in one place so the
// physical, idempotent-virtual and new-virtual paths return an identical shape.
const REGISTER_RETURNING = [
  'id',
  'serial',
  'owner_id',
  'name',
  'state',
  'firmware_version',
  'last_seen_at',
  'created_at',
] as const;

interface RegisterRow {
  id: string;
  serial: string;
  owner_id: string | null;
  name: string | null;
  state: DeviceState;
  firmware_version: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}

function deviceResponse(row: RegisterRow) {
  return {
    id: row.id,
    serial: row.serial,
    ownerId: row.owner_id,
    name: row.name,
    state: row.state,
    firmwareVersion: row.firmware_version,
    lastSeenAt: row.last_seen_at ? ISO(row.last_seen_at) : null,
    createdAt: ISO(row.created_at),
  };
}

// Claim codes only live while a device is `unclaimed`; an expired or missing one
// is rotated. A claimed/retired device carries no claim code.
function resolveClaimCode(
  state: DeviceState,
  current: string | null,
  expires: Date | null,
): { claimCode: string | null; claimExpires: Date | null } {
  if (state !== 'unclaimed') return { claimCode: null, claimExpires: null };
  if (!current || !expires || expires.getTime() <= Date.now()) {
    return {
      claimCode: newClaimCode(),
      claimExpires: new Date(Date.now() + CLAIM_CODE_TTL_SEC * 1000),
    };
  }
  return { claimCode: current, claimExpires: expires };
}

interface DeviceDeps {
  db: Kysely<Database>;
  s3?: S3Client | undefined;
  s3Config?: S3Config | undefined;
}

const SYNC_PRESIGN_TTL_SEC = Number(process.env.SYNC_PRESIGN_TTL_SEC ?? 1800);

export const deviceRoutes = (deps: DeviceDeps): FastifyPluginAsyncZod => async (app) => {
  const { db, s3, s3Config } = deps;

  const HMAC_HEADER_RE = /^HMAC\s+/i;

  // Dual-auth pre-handler for endpoints a user app can drive on a device's
  // behalf. A `deviceHmac` caller keeps the existing physical-device flow
  // untouched. A `userJwt` caller must pass `device_id` referencing a claimed
  // device they own; on success we set `req.device` so the handler downstream
  // is identical for both callers.
  const requireDeviceOrUser = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? '';
    if (HMAC_HEADER_RE.test(header)) {
      // Physical device flow — unchanged. requireDevice throws 401 on failure.
      await app.requireDevice(req);
      return;
    }

    // App-acting-as-device flow. requireUser throws 401 on a missing/invalid JWT.
    await app.requireUser(req);

    const { device_id: deviceId } = req.query as { device_id?: string };
    if (!deviceId) {
      return reply.code(400).send({
        code: 'device_id_required',
        message: 'device_id query parameter is required when authenticating as a user',
      });
    }

    const device = await db
      .selectFrom('devices')
      .select(['id', 'owner_id', 'state'])
      .where('id', '=', deviceId)
      .executeTakeFirst();

    // One 404 for every not-yours / not-usable case: wrong owner, unclaimed,
    // retired, or unknown id. We reuse the not-found response the rest of the
    // device API returns for an inaccessible device, so a user app cannot tell
    // which device ids exist and the contract stays consistent across endpoints.
    if (!device || device.state !== 'claimed' || device.owner_id !== req.user.sub) {
      return reply.code(404).send({
        code: 'device_not_found',
        message: 'device not found',
      });
    }

    req.device = { id: device.id };
  };

  // Dual-auth pre-handler for first-boot registration. A `deviceHmac` caller is
  // a physical device proving possession of its baked-in secret; `req.device` is
  // set and the existing flow runs unchanged. A `userJwt` caller is a user app
  // registering a virtual device; only `req.user` is set and the handler takes
  // the virtual branch. Unlike `requireDeviceOrUser` this does NOT require a
  // pre-existing device for the user path — the device is created on the fly.
  const requireDeviceOrUserForRegister = async (req: FastifyRequest): Promise<void> => {
    const header = req.headers.authorization ?? '';
    if (HMAC_HEADER_RE.test(header)) {
      await app.requireDevice(req);
      return;
    }
    await app.requireUser(req);
  };

  app.post(
    '/device/register',
    {
      preHandler: requireDeviceOrUserForRegister,
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
      const { serial, firmwareVersion, macAddress } = req.body;

      // ---- Physical device flow (deviceHmac): device pre-exists, resolved by
      // HMAC keyId. Behaviour is unchanged from the original handler.
      const deviceId = req.device?.id;
      if (deviceId) {
        const row = await db
          .selectFrom('devices')
          .select(['serial', 'state', 'mac_address', 'claim_code', 'claim_code_expires_at'])
          .where('id', '=', deviceId)
          .executeTakeFirst();

        if (!row) {
          return reply.code(401).send({ code: 'unauthorized', message: 'unknown device' });
        }
        if (row.serial !== serial) {
          return reply.code(422).send({ code: 'serial_mismatch', message: 'serial does not match' });
        }

        const { claimCode, claimExpires } = resolveClaimCode(
          row.state,
          row.claim_code,
          row.claim_code_expires_at,
        );

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
          .returning(REGISTER_RETURNING)
          .executeTakeFirstOrThrow();

        return reply.code(200).send({
          device: deviceResponse(updated),
          claimCode: claimCode ?? undefined,
        });
      }

      // ---- Virtual device flow (userJwt): the user app registers a
      // software-only device for itself.
      const userId = req.user?.sub;
      if (!userId) return reply.code(401).send({ code: 'unauthorized', message: 'unauthorized' });

      if (req.body.virtual !== true) {
        return reply.code(422).send({
          code: 'virtual_required',
          message: 'virtual must be true when registering as a user',
        });
      }

      // Idempotent on serial. We join `device_secrets` to tell a physical device
      // (it has a baked-in HMAC secret) apart from a virtual one. Returning the
      // record for a serial the caller cannot own — a physical device, or another
      // user's claimed device — would hand them a claim code for hardware they do
      // not possess, so those are hard conflicts.
      const existing = await db
        .selectFrom('devices')
        .leftJoin('device_secrets', 'device_secrets.device_id', 'devices.id')
        .select([
          'devices.id',
          'devices.serial',
          'devices.owner_id',
          'devices.name',
          'devices.state',
          'devices.firmware_version',
          'devices.mac_address',
          'devices.claim_code',
          'devices.claim_code_expires_at',
          'devices.last_seen_at',
          'devices.created_at',
          'device_secrets.device_id as secret_device_id',
        ])
        .where('devices.serial', '=', serial)
        .executeTakeFirst();

      if (existing) {
        const isPhysical = existing.secret_device_id !== null;
        const ownedByOther = existing.owner_id !== null && existing.owner_id !== userId;
        if (isPhysical || ownedByOther) {
          return reply.code(422).send({ code: 'serial_taken', message: 'serial already registered' });
        }

        const { claimCode, claimExpires } = resolveClaimCode(
          existing.state,
          existing.claim_code,
          existing.claim_code_expires_at,
        );

        const now = new Date();
        const updated = await db
          .updateTable('devices')
          .set({
            firmware_version: firmwareVersion,
            mac_address: macAddress ?? existing.mac_address,
            last_seen_at: now,
            updated_at: now,
            claim_code: claimCode,
            claim_code_expires_at: claimExpires,
          })
          .where('id', '=', existing.id)
          .returning(REGISTER_RETURNING)
          .executeTakeFirstOrThrow();

        return reply.code(200).send({
          device: deviceResponse(updated),
          claimCode: claimCode ?? undefined,
        });
      }

      // New virtual device: unclaimed, no owner, fresh claim code.
      const now = new Date();
      const claimCode = newClaimCode();
      const claimExpires = new Date(Date.now() + CLAIM_CODE_TTL_SEC * 1000);

      let created: RegisterRow;
      try {
        created = await db
          .insertInto('devices')
          .values({
            serial,
            owner_id: null,
            state: 'unclaimed',
            firmware_version: firmwareVersion,
            mac_address: macAddress ?? null,
            claim_code: claimCode,
            claim_code_expires_at: claimExpires,
            last_seen_at: now,
          })
          .returning(REGISTER_RETURNING)
          .executeTakeFirstOrThrow();
      } catch (err) {
        // Lost a race on the unique `serial` constraint between the select and
        // the insert. Treat it as the conflict it is rather than a 500.
        if ((err as { code?: string }).code === '23505') {
          return reply.code(422).send({ code: 'serial_taken', message: 'serial already registered' });
        }
        throw err;
      }

      return reply.code(200).send({
        device: deviceResponse(created),
        claimCode,
      });
    },
  );

  app.get(
    '/device/sync',
    {
      preHandler: requireDeviceOrUser,
      schema: {
        querystring: DeviceSyncQuerySchema,
        response: {
          200: DeviceSyncResponseSchema,
          304: z.null(),
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
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
        .catch((err) => req.log.warn({ err, deviceId }, 'sync: failed to update last_seen_at'));

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

  app.get(
    '/device/cards/:uid/download',
    {
      preHandler: requireDeviceOrUser,
      schema: {
        params: z.object({ uid: z.string().regex(/^[0-9a-f]{8,20}$/) }),
        querystring: CardDownloadQuerySchema,
        response: {
          200: CardDownloadSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
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
        .select(['owner_id', 'state'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (!device || device.state !== 'claimed' || !device.owner_id) {
        return reply.code(401).send({ code: 'unauthorized', message: 'device not claimed' });
      }

      const { uid } = req.params;
      const binding = await db
        .selectFrom('card_bindings')
        .select(['audio_id'])
        .where('device_id', '=', deviceId)
        .where('uid', '=', uid)
        .executeTakeFirst();
      if (!binding) {
        return reply.code(404).send({
          code: 'card_not_bound',
          message: 'No audio is bound to that card UID on this device.',
        });
      }

      // Ownership is implied by the binding (the card lives on the caller's
      // device), but we scope the lookup by owner anyway so a stale binding to
      // someone else's audio can never leak a presigned URL.
      const audio = await db
        .selectFrom('audios')
        .select(['id', 'state', 'sha256', 'size_bytes', 'transcoded_key'])
        .where('id', '=', binding.audio_id)
        .where('owner_id', '=', device.owner_id)
        .executeTakeFirst();

      // A missing audio (deleted out from under a stale binding) is, from the
      // consumer's point of view, the same "nothing to download here" as an
      // unbound card.
      if (!audio) {
        return reply.code(404).send({
          code: 'card_not_bound',
          message: 'No audio is bound to that card UID on this device.',
        });
      }

      if (audio.state !== 'ready' || !audio.transcoded_key || !audio.sha256) {
        return reply.code(409).send({
          code: 'audio_not_ready',
          message: 'The bound audio is not ready for download yet.',
          details: { state: audio.state },
        });
      }

      const url = await presignGet(s3, s3Config, audio.transcoded_key, {
        expiresInSec: SYNC_PRESIGN_TTL_SEC,
      });

      return reply.code(200).send({
        audioId: audio.id,
        downloadUrl: url.url,
        sha256: audio.sha256,
        ...(audio.size_bytes !== null ? { sizeBytes: audio.size_bytes } : {}),
        expiresAt: url.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/device/events',
    {
      preHandler: requireDeviceOrUser,
      schema: {
        querystring: DeviceEventsQuerySchema,
        body: DeviceEventsRequestSchema,
        response: { 202: z.null(), 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 422: ErrorSchema },
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
        .catch((err) => req.log.warn({ err, deviceId }, 'events: failed to update last_seen_at'));

      return reply.code(202).send(null);
    },
  );
};
