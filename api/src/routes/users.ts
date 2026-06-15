import { randomUUID } from 'node:crypto';

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { FastifyReply } from 'fastify';

import {
  AuthTokensSchema,
  ChangePasswordRequestSchema,
  ErrorSchema,
  RefreshRequestSchema,
  UserLoginRequestSchema,
  UserRegisterRequestSchema,
  UserSchema,
} from '../schemas.js';
import type { Database, UserRole } from '../db/types.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { accessTtlSeconds } from '../auth/jwt.js';
import { generateRefreshToken, hashRefresh, refreshTtlSeconds } from '../auth/refresh.js';

const ISO = (d: Date | string): string =>
  (d instanceof Date ? d : new Date(d)).toISOString();

const REFRESH_COOKIE = 'hush_refresh';

function setRefreshCookie(reply: FastifyReply, token: string, ttlSec: number): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/v1/users/refresh',
    maxAge: ttlSec,
  });
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: '/v1/users/refresh' });
}

interface UsersDeps {
  db: Kysely<Database>;
}

export const usersRoutes = (deps: UsersDeps): FastifyPluginAsyncZod => async (app) => {
  const { db } = deps;

  async function issueTokens(
    userId: string,
    role: UserRole,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const jti = randomUUID();
    const accessToken = app.jwt.sign({ sub: userId, role, jti });

    const refreshToken = generateRefreshToken();
    const tokenHash = hashRefresh(refreshToken);
    const expiresAt = new Date(Date.now() + refreshTtlSeconds() * 1000);
    await db
      .insertInto('refresh_tokens')
      .values({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt })
      .execute();

    return { accessToken, refreshToken, expiresIn: accessTtlSeconds() };
  }

  // Public self-registration for end customers (OPE-18). Anyone can create an
  // account and is logged straight in (tokens + refresh cookie). The role is
  // hard-coded to 'user' and never read from the body: self-registration can
  // never mint an admin, which is the boundary against privilege escalation.
  // Admins are created only by the bootstrap seed.
  //
  // Operators who want the locked-down, invite-only posture set
  // DISABLE_PUBLIC_REGISTRATION=true and create accounts out of band.
  const publicRegistrationDisabled =
    (process.env.DISABLE_PUBLIC_REGISTRATION ?? '').toLowerCase() === 'true';

  app.post(
    '/users/register',
    {
      schema: {
        body: UserRegisterRequestSchema,
        response: { 201: AuthTokensSchema, 403: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) => {
      if (publicRegistrationDisabled) {
        return reply
          .code(403)
          .send({ code: 'registration_disabled', message: 'public registration is disabled' });
      }

      const { email, password, displayName } = req.body;

      const existing = await db
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (existing) {
        return reply.code(409).send({ code: 'email_taken', message: 'email already in use' });
      }

      const password_hash = await hashPassword(password);
      const inserted = await db
        .insertInto('users')
        .values({ email, password_hash, display_name: displayName ?? null, role: 'user' })
        .returning(['id', 'role'])
        .executeTakeFirstOrThrow();

      const tokens = await issueTokens(inserted.id, inserted.role);
      setRefreshCookie(reply, tokens.refreshToken, refreshTtlSeconds());
      return reply.code(201).send(tokens);
    },
  );

  app.post(
    '/users/login',
    {
      schema: {
        body: UserLoginRequestSchema,
        response: { 200: AuthTokensSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const row = await db
        .selectFrom('users')
        .select(['id', 'password_hash', 'role'])
        .where('email', '=', email)
        .executeTakeFirst();

      const ok = row ? await verifyPassword(row.password_hash, password) : false;
      if (!row || !ok) {
        return reply.code(401).send({ code: 'invalid_credentials', message: 'invalid credentials' });
      }

      const tokens = await issueTokens(row.id, row.role);
      setRefreshCookie(reply, tokens.refreshToken, refreshTtlSeconds());
      return reply.code(200).send(tokens);
    },
  );

  // Body becomes optional: browsers send the refresh via the SameSite=Strict
  // cookie; mobile clients keep posting it in the body.
  const RefreshBodySchema = RefreshRequestSchema.partial().optional();

  app.post(
    '/users/refresh',
    {
      schema: {
        body: RefreshBodySchema,
        response: { 200: AuthTokensSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const fromBody = req.body?.refreshToken;
      const fromCookie = req.cookies?.[REFRESH_COOKIE];
      const refreshToken = fromBody ?? fromCookie;
      if (!refreshToken) {
        return reply.code(401).send({ code: 'unauthorized', message: 'refresh token missing' });
      }
      const tokenHash = hashRefresh(refreshToken);

      const row = await db
        .selectFrom('refresh_tokens')
        .innerJoin('users', 'users.id', 'refresh_tokens.user_id')
        .select([
          'refresh_tokens.id as id',
          'refresh_tokens.user_id as user_id',
          'refresh_tokens.used_at as used_at',
          'refresh_tokens.revoked_at as revoked_at',
          'refresh_tokens.expires_at as expires_at',
          'users.role as role',
        ])
        .where('token_hash', '=', tokenHash)
        .executeTakeFirst();

      if (!row) {
        clearRefreshCookie(reply);
        return reply.code(401).send({ code: 'invalid_credentials', message: 'invalid refresh token' });
      }

      const expired = row.expires_at.getTime() <= Date.now();
      const replayed = !!row.used_at;
      const revoked = !!row.revoked_at;

      if (replayed || revoked) {
        await db
          .updateTable('refresh_tokens')
          .set({ revoked_at: new Date() })
          .where('user_id', '=', row.user_id)
          .where('revoked_at', 'is', null)
          .execute();
        clearRefreshCookie(reply);
        return reply.code(401).send({ code: 'invalid_credentials', message: 'refresh reuse detected' });
      }

      if (expired) {
        clearRefreshCookie(reply);
        return reply.code(401).send({ code: 'expired_token', message: 'refresh expired' });
      }

      await db
        .updateTable('refresh_tokens')
        .set({ used_at: new Date() })
        .where('id', '=', row.id)
        .execute();

      const tokens = await issueTokens(row.user_id, row.role);
      setRefreshCookie(reply, tokens.refreshToken, refreshTtlSeconds());
      return reply.code(200).send(tokens);
    },
  );

  app.get(
    '/users/me',
    {
      preHandler: app.requireUser,
      schema: { response: { 200: UserSchema, 401: ErrorSchema } },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const row = await db
        .selectFrom('users')
        .select(['id', 'email', 'display_name', 'role', 'created_at'])
        .where('id', '=', userId)
        .executeTakeFirst();

      if (!row) {
        return reply.code(401).send({ code: 'unauthorized', message: 'user not found' });
      }

      return reply.code(200).send({
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        createdAt: ISO(row.created_at),
      });
    },
  );

  app.patch(
    '/users/me/password',
    {
      preHandler: app.requireUser,
      schema: {
        body: ChangePasswordRequestSchema,
        response: { 200: AuthTokensSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const { currentPassword, newPassword } = req.body;

      const row = await db
        .selectFrom('users')
        .select(['password_hash', 'role'])
        .where('id', '=', userId)
        .executeTakeFirst();

      const ok = row ? await verifyPassword(row.password_hash, currentPassword) : false;
      if (!row || !ok) {
        return reply
          .code(401)
          .send({ code: 'invalid_credentials', message: 'current password is incorrect' });
      }

      const password_hash = await hashPassword(newPassword);
      await db
        .updateTable('users')
        .set({ password_hash, updated_at: new Date() })
        .where('id', '=', userId)
        .execute();

      // Revoke every outstanding refresh token: changing the password logs out
      // all other sessions. The caller gets a fresh pair below so its session
      // survives.
      await db
        .updateTable('refresh_tokens')
        .set({ revoked_at: new Date() })
        .where('user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .execute();

      const tokens = await issueTokens(userId, row.role);
      setRefreshCookie(reply, tokens.refreshToken, refreshTtlSeconds());
      return reply.code(200).send(tokens);
    },
  );
};

