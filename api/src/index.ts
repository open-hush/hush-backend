import { createServer } from './server.js';

const server = await createServer({ bootstrapAdmin: true });

const host = process.env.HUSH_HOST ?? '0.0.0.0';
const port = Number(process.env.HUSH_PORT ?? 8080);

try {
  await server.listen({ host, port });
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: NodeJS.Signals) => {
  server.log.info({ signal }, 'shutting down');
  await server.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
