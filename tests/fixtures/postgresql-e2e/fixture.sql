CREATE ROLE ks23_scan LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ks23_scan IN DATABASE ks23_e2e SET default_transaction_read_only = on;
ALTER ROLE ks23_scan IN DATABASE ks23_e2e SET statement_timeout = '5s';
ALTER ROLE ks23_scan IN DATABASE ks23_e2e SET lock_timeout = '1s';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE ks23_e2e FROM PUBLIC;
CREATE SCHEMA ks23_app AUTHORIZATION ks23_owner;
CREATE SCHEMA ks23_outside AUTHORIZATION ks23_owner;

CREATE TABLE ks23_app.accounts (
  account_id bigint NOT NULL,
  external_ref text NOT NULL,
  region_code text NOT NULL,
  CONSTRAINT ks23_accounts_pk PRIMARY KEY (account_id),
  CONSTRAINT ks23_accounts_external_ref_uq UNIQUE (external_ref),
  CONSTRAINT ks23_accounts_region_ck CHECK (region_code IN ('EU', 'NA'))
);

CREATE TABLE ks23_app.orders (
  order_id bigint NOT NULL,
  account_id bigint NOT NULL,
  order_code text NOT NULL,
  total_cents integer NOT NULL,
  state text NOT NULL,
  row_canary text,
  CONSTRAINT ks23_orders_pk PRIMARY KEY (order_id),
  CONSTRAINT ks23_orders_order_code_uq UNIQUE (order_code),
  CONSTRAINT ks23_orders_account_fk FOREIGN KEY (account_id) REFERENCES ks23_app.accounts(account_id),
  CONSTRAINT ks23_orders_total_ck CHECK (total_cents >= 0),
  CONSTRAINT ks23_orders_state_ck CHECK (state IN ('OPEN', 'CLOSED'))
);

CREATE TABLE ks23_app.staging_events (
  event_id bigint NOT NULL,
  account_id bigint,
  payload text,
  recorded_on date NOT NULL
);

ALTER TABLE ks23_app.staging_events
  ADD CONSTRAINT ks23_staging_payload_ck
  CHECK (payload IS NULL OR char_length(payload) <= 64) NOT VALID;

CREATE UNIQUE INDEX ks23_staging_event_positive_uix
  ON ks23_app.staging_events(event_id) WHERE event_id > 0;

CREATE TABLE ks23_outside.secret_decoy (
  decoy_id bigint PRIMARY KEY,
  decoy_value text NOT NULL
);

INSERT INTO ks23_app.accounts VALUES (1, 'SYNTH-ACCOUNT-1', 'EU');
INSERT INTO ks23_app.orders VALUES (10, 1, 'SYNTH-ORDER-10', 1250, 'OPEN', 'KS23_RAW_ROW_CANARY_17F2C3');
INSERT INTO ks23_app.staging_events VALUES (100, 1, 'synthetic-event', DATE '2026-01-01');
INSERT INTO ks23_outside.secret_decoy VALUES (900, 'KS23_OUTSIDE_DECOY_91A7B4');

GRANT CONNECT ON DATABASE ks23_e2e TO ks23_scan;
GRANT USAGE ON SCHEMA ks23_app TO ks23_scan;
GRANT SELECT ON ALL TABLES IN SCHEMA ks23_app TO ks23_scan;
REVOKE ALL ON SCHEMA ks23_outside FROM ks23_scan;
REVOKE CREATE ON SCHEMA public, ks23_app, ks23_outside FROM ks23_scan;
