import fp from 'fastify-plugin';
import jwt, { type FastifyJWTOptions } from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

export interface JwtUser {
  sub: string;
  iat: number;
  exp: number;
  jti: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    user: JwtUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; jti: string };
    user: JwtUser;
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const secret = process.env.JWT_SIGNING_KEY;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SIGNING_KEY must be set and at least 32 chars');
  }
  const accessTtl = Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);

  const opts: FastifyJWTOptions = {
    secret,
    sign: { algorithm: 'HS256', expiresIn: accessTtl },
    verify: { algorithms: ['HS256'] },
  };
  await app.register(jwt, opts);

  app.decorate('requireUser', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('invalid or missing token');
    }
  });
};

export const jwtPlugin = fp(plugin, { name: 'hush-jwt' });

export function accessTtlSeconds(): number {
  return Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);
}
