# migrations

Postgres migrations applied with [`sqlx-cli`](https://github.com/launchbadge/sqlx/tree/main/sqlx-cli).

## Apply

```bash
cargo install sqlx-cli --no-default-features --features postgres
sqlx migrate run --source migrations
```

## Create a new migration

```bash
sqlx migrate add --source migrations <description>
# Creates: migrations/<timestamp>_<description>.sql
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
