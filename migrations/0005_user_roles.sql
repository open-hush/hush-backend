-- User roles: explicit separation between platform admins and ordinary users.
--
-- Public self-registration (OPE-18) only ever creates 'user' rows, so the role
-- is the authorization boundary that keeps a self-registered customer from
-- gaining global admin privileges. The role is server-assigned and never taken
-- from the request body.

-- Up Migration

ALTER TABLE users
  ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin', 'user'));

-- Every account that exists before this migration was created either by the
-- bootstrap seed or by an operator from the dashboard — i.e. trusted accounts.
-- Promote them to 'admin' so existing installs keep their current access; only
-- accounts created from now on default to the non-privileged 'user' role.
UPDATE users SET role = 'admin';

CREATE INDEX users_role_idx ON users(role);

-- Down Migration

DROP INDEX IF EXISTS users_role_idx;
ALTER TABLE users DROP COLUMN IF EXISTS role;
