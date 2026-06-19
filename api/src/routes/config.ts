import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { ConfigStatusSchema, ErrorSchema } from '../schemas.js';
import { buildConfigStatus } from '../config/status.js';

// Admin-only, read-only view of external service configuration (OPE-21).
// requireAdmin returns 401 for a missing/invalid token and 403 for an
// authenticated non-admin, mirroring the other admin routes. The handler only
// inspects which env vars are set — it never reads or returns a secret value.
export const configRoutes = (): FastifyPluginAsyncZod => async (app) => {
  app.get(
    '/config',
    {
      preHandler: app.requireAdmin,
      schema: {
        response: { 200: ConfigStatusSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (_req, reply) => reply.code(200).send(buildConfigStatus()),
  );
};
