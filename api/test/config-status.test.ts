import { describe, expect, it } from 'vitest';

import { buildConfigStatus } from '../src/config/status.js';
import { ConfigStatusSchema } from '../src/schemas.js';

const EMPTY: NodeJS.ProcessEnv = {};

function service(env: NodeJS.ProcessEnv, key: string) {
  const svc = buildConfigStatus(env).services.find((s) => s.service === key);
  if (!svc) throw new Error(`service ${key} missing`);
  return svc;
}

describe('buildConfigStatus', () => {
  it('produces output that matches the response schema', () => {
    expect(ConfigStatusSchema.safeParse(buildConfigStatus(EMPTY)).success).toBe(true);
  });

  it('reports the four services in a stable order', () => {
    expect(buildConfigStatus(EMPTY).services.map((s) => s.service)).toEqual([
      'email',
      'storage',
      'traces',
      'crash',
    ]);
  });

  it('marks a service unconfigured when required vars are missing', () => {
    const email = service(EMPTY, 'email');
    expect(email.configured).toBe(false);
    expect(email.variables.every((v) => v.set === false)).toBe(true);
  });

  it('marks a service configured only when every required var is set', () => {
    const partial = service({ RESEND_API_KEY: 'rk_live_x' }, 'email');
    // RESEND_FROM (required) is still missing.
    expect(partial.configured).toBe(false);

    const full = service({ RESEND_API_KEY: 'rk_live_x', RESEND_FROM: 'hi@hush.local' }, 'email');
    expect(full.configured).toBe(true);
  });

  it('ignores optional vars for the configured flag', () => {
    // storage is configured without S3_REGION / S3_USE_PATH_STYLE (both optional).
    const storage = service(
      {
        S3_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'hush-audio',
        S3_ACCESS_KEY: 'ak',
        S3_SECRET_KEY: 'sk',
      },
      'storage',
    );
    expect(storage.configured).toBe(true);
  });

  it('treats blank/whitespace values as not set', () => {
    const crash = service({ SENTRY_DSN: '   ' }, 'crash');
    expect(crash.variables.find((v) => v.name === 'SENTRY_DSN')?.set).toBe(false);
    expect(crash.configured).toBe(false);
  });

  it('never exposes a secret value as a hint', () => {
    const storage = service(
      {
        S3_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'hush-audio',
        S3_ACCESS_KEY: 'super-secret-access',
        S3_SECRET_KEY: 'super-secret-secret',
        S3_REGION: 'eu-west-1',
      },
      'storage',
    );
    const hintValues = Object.values(storage.hints ?? {}).join('|');
    expect(hintValues).not.toContain('super-secret-access');
    expect(hintValues).not.toContain('super-secret-secret');
    // Non-secret values surface as hints.
    expect(storage.hints?.region).toBe('eu-west-1');
    expect(storage.hints?.bucket).toBe('hush-audio');
  });

  it('masks the endpoint hint so internal URLs are not echoed in full', () => {
    const storage = service(
      {
        S3_ENDPOINT: 'http://internal-minio.cluster.local:9000',
        S3_BUCKET: 'hush-audio',
        S3_ACCESS_KEY: 'ak',
        S3_SECRET_KEY: 'sk',
      },
      'storage',
    );
    expect(storage.hints?.endpoint).toBe('http://int***');
    expect(storage.hints?.endpoint).not.toContain('cluster.local');
  });

  it('marks secret vars with secret=true and the rest with secret=false', () => {
    const storage = service(EMPTY, 'storage');
    const byName = Object.fromEntries(storage.variables.map((v) => [v.name, v.secret]));
    expect(byName.S3_ACCESS_KEY).toBe(true);
    expect(byName.S3_SECRET_KEY).toBe(true);
    expect(byName.S3_BUCKET).toBe(false);
    expect(byName.S3_ENDPOINT).toBe(false);
  });
});
