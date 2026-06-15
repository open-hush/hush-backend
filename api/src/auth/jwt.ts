import fp from 'fastify-plugin';
import jwt, { type FastifyJWTOptions } from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import type { UserRole } from '../db/types.js';

export interface JwtUser {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
  jti: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireUser: (req: FastifyRequest) => Promise<void>;
    requireAdmin: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    user: JwtUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; role: UserRole; jti: string };
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

  // Admin-only gate. Verifies the token first (so a missing/invalid token is a
  // 401, not a 403), then enforces the role claim. Self-registered users carry
  // role 'user' and can never reach an admin route, which is the boundary that
  // keeps public onboarding from escalating into global admin access.
  app.decorate('requireAdmin', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('invalid or missing token');
    }
    if (req.user.role !== 'admin') {
      throw app.httpErrors.forbidden('admin privileges required');
    }
  });
};

export const jwtPlugin = fp(plugin, { name: 'hush-jwt' });

export function accessTtlSeconds(): number {
  return Number(process.env.JWT_ACCESS_TTL_SEC ?? 900);
}
