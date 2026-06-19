import type { ConfigStatus } from '../schemas.js';

// External service configuration (OPE-21). Configuration is operator-owned and
// 12-factor: values live in the process environment and are read at boot. This
// module reports *whether* each variable is set and a few non-secret hints; it
// never reads or returns a secret value. Changing config is an out-of-band
// env edit + restart, not an API write.

interface VariableDef {
  name: string;
  /** Sensitive value — never surfaced as a hint, set or not. */
  secret: boolean;
  /** Counts toward the service's `configured` flag. */
  required: boolean;
  /**
   * When set and non-secret, expose the value as a hint under this key.
   * `mask` truncates the value so internal URLs are not echoed in full.
   */
  hint?: { key: string; mask?: boolean };
}

interface ServiceDef {
  service: 'email' | 'storage' | 'traces' | 'crash';
  label: string;
  variables: VariableDef[];
}

const SERVICES: ServiceDef[] = [
  {
    service: 'email',
    label: 'Email (Resend)',
    variables: [
      { name: 'RESEND_API_KEY', secret: true, required: true },
      { name: 'RESEND_FROM', secret: false, required: true, hint: { key: 'from' } },
    ],
  },
  {
    service: 'storage',
    label: 'Audio storage (S3 / MinIO / R2)',
    variables: [
      { name: 'S3_ENDPOINT', secret: false, required: true, hint: { key: 'endpoint', mask: true } },
      { name: 'S3_REGION', secret: false, required: false, hint: { key: 'region' } },
      { name: 'S3_BUCKET', secret: false, required: true, hint: { key: 'bucket' } },
      { name: 'S3_ACCESS_KEY', secret: true, required: true },
      { name: 'S3_SECRET_KEY', secret: true, required: true },
      { name: 'S3_USE_PATH_STYLE', secret: false, required: false, hint: { key: 'pathStyle' } },
    ],
  },
  {
    service: 'traces',
    label: 'Log traces (BetterStack)',
    variables: [
      { name: 'BETTERSTACK_API_KEY', secret: true, required: true },
      { name: 'BETTERSTACK_INGEST_URL', secret: false, required: false, hint: { key: 'ingestUrl' } },
    ],
  },
  {
    service: 'crash',
    label: 'Crash reporting (Sentry)',
    variables: [
      { name: 'SENTRY_DSN', secret: true, required: true },
      { name: 'SENTRY_ENVIRONMENT', secret: false, required: false, hint: { key: 'environment' } },
    ],
  },
];

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Truncate a non-secret value so full internal URLs are not echoed. */
function mask(value: string): string {
  const v = value.trim();
  return v.length <= 6 ? '***' : `${v.slice(0, 10)}***`;
}

export function buildConfigStatus(env: NodeJS.ProcessEnv = process.env): ConfigStatus {
  return {
    services: SERVICES.map((svc) => {
      const hints: Record<string, string> = {};
      const variables = svc.variables.map((def) => {
        const raw = env[def.name];
        const set = isSet(raw);
        if (set && def.hint && !def.secret) {
          hints[def.hint.key] = def.hint.mask ? mask(raw!) : raw!.trim();
        }
        return { name: def.name, set, secret: def.secret, required: def.required };
      });
      const configured = svc.variables
        .filter((d) => d.required)
        .every((d) => isSet(env[d.name]));
      return { service: svc.service, label: svc.label, configured, variables, hints };
    }),
  };
}
