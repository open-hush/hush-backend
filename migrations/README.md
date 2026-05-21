# migrations

Postgres migrations as plain `.sql` files, applied with [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/).

```bash
# From hush-backend/api/
pnpm exec node-pg-migrate --migrations-dir ../migrations up

# Create a new migration
pnpm exec node-pg-migrate --migrations-dir ../migrations create <description>
```

## Conventions

- One concern per migration. Don't combine "add table" with "backfill data".
- Numeric prefix: `0001_initial_schema.sql`, `0002_devices.sql`, ….
- Reversible when it's cheap to be so; irreversible migrations need a comment explaining why.
- Backfills that may exceed a few seconds get their own migration so DDL stays separate.

## Status

> TODO(phase-1): `0001_initial_schema.sql` with users + refresh_tokens.
> TODO(phase-1): `0002_devices.sql` with devices + device_secrets.
> TODO(phase-2): `0003_audio.sql` with audios.
> TODO(phase-3): `0004_cards_and_events.sql` with card_bindings + device_events.
