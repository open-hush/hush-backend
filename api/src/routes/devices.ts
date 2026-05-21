import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import {
  CardBindingListSchema,
  CardBindingRequestSchema,
  CardBindingSchema,
  DeviceClaimRequestSchema,
  DeviceListQuerySchema,
  DeviceListSchema,
  DeviceSchema,
  ErrorSchema,
} from '../schemas.js';
import type { Database } from '../db/types.js';
import { decodeCursor, encodeCursor } from '../util/cursor.js';

const ISO = (d: Date | string): string =>
  (d instanceof Date ? d : new Date(d)).toISOString();

const PARAM_DEVICE_ID = z.object({ id: z.string().uuid() });
const DEVICES_PAGE_SIZE = 50;

function deviceToApi(row: {
  id: string;
  serial: string;
  owner_id: string | null;
  name: string | null;
  state: 'unclaimed' | 'claimed' | 'retired';
  firmware_version: string | null;
  last_seen_at: Date | null;
  created_at: Date;
}) {
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

interface DevicesDeps {
  db: Kysely<Database>;
}

export const devicesRoutes = (deps: DevicesDeps): FastifyPluginAsyncZod => async (app) => {
  const { db } = deps;

  app.get(
    '/devices',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: DeviceListQuerySchema,
        response: { 200: DeviceListSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;

      let q = db
        .selectFrom('devices')
        .select([
          'id', 'serial', 'owner_id', 'name', 'state',
          'firmware_version', 'last_seen_at', 'created_at',
        ])
        .where('owner_id', '=', userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(DEVICES_PAGE_SIZE + 1);

      if (cursor) {
        const ts = new Date(cursor.createdAt);
        q = q.where((eb) =>
          eb.or([
            eb('created_at', '<', ts),
            eb.and([eb('created_at', '=', ts), eb('id', '<', cursor.id)]),
          ]),
        );
      }

      const rows = await q.execute();
      const hasMore = rows.length > DEVICES_PAGE_SIZE;
      const page = hasMore ? rows.slice(0, DEVICES_PAGE_SIZE) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor({ createdAt: ISO(last.created_at), id: last.id })
          : undefined;

      return reply.code(200).send({
        items: page.map(deviceToApi),
        ...(nextCursor ? { nextCursor } : {}),
      });
    },
  );

  app.get(
    '/devices/:id',
    {
      preHandler: app.requireUser,
      schema: {
        params: PARAM_DEVICE_ID,
        response: { 200: DeviceSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const row = await db
        .selectFrom('devices')
        .select([
          'id', 'serial', 'owner_id', 'name', 'state',
          'firmware_version', 'last_seen_at', 'created_at',
        ])
        .where('id', '=', req.params.id)
        .where('owner_id', '=', userId)
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ code: 'not_found', message: 'device not found' });
      return reply.code(200).send(deviceToApi(row));
    },
  );

  app.get(
    '/devices/:id/cards',
    {
      preHandler: app.requireUser,
      schema: {
        params: PARAM_DEVICE_ID,
        response: { 200: CardBindingListSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const device = await db
        .selectFrom('devices')
        .select(['id', 'owner_id'])
        .where('id', '=', req.params.id)
        .executeTakeFirst();
      if (!device || device.owner_id !== userId) {
        return reply.code(404).send({ code: 'not_found', message: 'device not found' });
      }

      const rows = await db
        .selectFrom('card_bindings')
        .select(['uid', 'audio_id', 'bound_at'])
        .where('device_id', '=', req.params.id)
        .orderBy('uid', 'asc')
        .execute();

      return reply.code(200).send({
        items: rows.map((r) => ({ uid: r.uid, audioId: r.audio_id, boundAt: ISO(r.bound_at) })),
      });
    },
  );

  app.post(
    '/devices/:id/claim',
    {
      preHandler: app.requireUser,
      schema: {
        params: PARAM_DEVICE_ID,
        body: DeviceClaimRequestSchema,
        response: {
          200: DeviceSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const { id } = req.params;
      const { claimCode, name } = req.body;

      const row = await db
        .selectFrom('devices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ code: 'not_found', message: 'device not found' });

      if (row.state === 'claimed') {
        return reply.code(409).send({ code: 'device_already_claimed', message: 'device already claimed' });
      }
      if (row.state !== 'unclaimed') {
        return reply.code(409).send({ code: 'device_unavailable', message: `device state is ${row.state}` });
      }

      const codeOk = row.claim_code && row.claim_code === claimCode;
      const notExpired = row.claim_code_expires_at && row.claim_code_expires_at.getTime() > Date.now();
      if (!codeOk || !notExpired) {
        return reply.code(401).send({ code: 'invalid_claim_code', message: 'invalid or expired claim code' });
      }

      const now = new Date();
      const updated = await db.transaction().execute(async (tx) => {
        const dev = await tx
          .updateTable('devices')
          .set({
            owner_id: userId,
            name: name ?? row.name,
            state: 'claimed',
            claim_code: null,
            claim_code_expires_at: null,
            updated_at: now,
          })
          .where('id', '=', id)
          .where('state', '=', 'unclaimed')
          .returning([
            'id', 'serial', 'owner_id', 'name', 'state',
            'firmware_version', 'last_seen_at', 'created_at',
          ])
          .executeTakeFirstOrThrow();

        // Bootstrap default config row if missing.
        await tx
          .insertInto('device_configs')
          .values({ device_id: id })
          .onConflict((oc) => oc.column('device_id').doNothing())
          .execute();

        return dev;
      });

      return reply.code(200).send({
        id: updated.id,
        serial: updated.serial,
        ownerId: updated.owner_id,
        name: updated.name,
        state: updated.state,
        firmwareVersion: updated.firmware_version,
        lastSeenAt: updated.last_seen_at ? ISO(updated.last_seen_at) : null,
        createdAt: ISO(updated.created_at),
      });
    },
  );

  app.post(
    '/devices/:id/cards',
    {
      preHandler: app.requireUser,
      schema: {
        params: PARAM_DEVICE_ID,
        body: CardBindingRequestSchema,
        response: {
          200: CardBindingSchema,
          401: ErrorSchema,
          404: ErrorSchema,
          422: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const { id: deviceId } = req.params;
      const { uid, audioId } = req.body;

      const device = await db
        .selectFrom('devices')
        .select(['id', 'owner_id'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (!device || device.owner_id !== userId) {
        return reply.code(404).send({ code: 'not_found', message: 'device not found' });
      }

      const audio = await db
        .selectFrom('audios')
        .select(['id'])
        .where('id', '=', audioId)
        .where('owner_id', '=', userId)
        .executeTakeFirst();
      if (!audio) {
        return reply.code(422).send({ code: 'audio_not_owned', message: 'audio not owned by user' });
      }

      const now = new Date();
      const binding = await db
        .insertInto('card_bindings')
        .values({ device_id: deviceId, uid, audio_id: audioId })
        .onConflict((oc) =>
          oc.columns(['device_id', 'uid']).doUpdateSet({ audio_id: audioId, updated_at: now }),
        )
        .returning(['uid', 'audio_id', 'bound_at'])
        .executeTakeFirstOrThrow();

      return reply.code(200).send({
        uid: binding.uid,
        audioId: binding.audio_id,
        boundAt: ISO(binding.bound_at),
      });
    },
  );

  app.delete(
    '/devices/:id/cards/:uid',
    {
      preHandler: app.requireUser,
      schema: {
        params: z.object({
          id: z.string().uuid(),
          uid: z.string().regex(/^[0-9a-f]{8,20}$/),
        }),
        response: { 204: z.null(), 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const { id: deviceId, uid } = req.params;

      const device = await db
        .selectFrom('devices')
        .select(['id', 'owner_id'])
        .where('id', '=', deviceId)
        .executeTakeFirst();
      if (!device || device.owner_id !== userId) {
        return reply.code(404).send({ code: 'not_found', message: 'device not found' });
      }

      const result = await db
        .deleteFrom('card_bindings')
        .where('device_id', '=', deviceId)
        .where('uid', '=', uid)
        .executeTakeFirst();

      if (result.numDeletedRows === 0n) {
        return reply.code(404).send({ code: 'not_found', message: 'binding not found' });
      }

      return reply.code(204).send(null);
    },
  );
};
