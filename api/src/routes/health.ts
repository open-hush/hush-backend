import type { FastifyPluginAsync } from 'fastify';

import { version } from '../version.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok', version }));
};
