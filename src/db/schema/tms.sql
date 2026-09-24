-- Logistics / Transportation Management System
CREATE SCHEMA IF NOT EXISTS tms;

CREATE TABLE IF NOT EXISTS tms.carriers (
  carrier_code           TEXT PRIMARY KEY,         -- common code, e.g. UPS
  scac                   TEXT NOT NULL UNIQUE,     -- Standard Carrier Alpha Code used internally by TMS
  name                   TEXT NOT NULL,
  mode                   TEXT NOT NULL CHECK (mode IN ('PARCEL','LTL','FTL','AIR','OCEAN')),
  tracking_url_template  TEXT
);

CREATE SEQUENCE IF NOT EXISTS tms.shipment_seq START 200;
CREATE TABLE IF NOT EXISTS tms.shipments (
  shipment_id      TEXT PRIMARY KEY CHECK (shipment_id ~ '^SHP-[0-9]{8}-[0-9]{5}$'),
  asn_number       TEXT NOT NULL,
  supplier_code    TEXT NOT NULL,
  carrier_scac     TEXT NOT NULL REFERENCES tms.carriers(scac),
  tracking_id      TEXT,
  milestone        TEXT NOT NULL CHECK (milestone IN ('PLN','TND','ITR','DLV','EXC','CXL')),
  milestone_since  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  origin           JSONB NOT NULL,
  destination      JSONB NOT NULL,
  planned_ship_at  TIMESTAMPTZ NOT NULL,
  eta              TIMESTAMPTZ NOT NULL,
  contents         JSONB NOT NULL,          -- [{poNumber, poLine, quantity:{value,uom}, lotNumber}]
  handling_units   JSONB NOT NULL DEFAULT '[]'::jsonb,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_code, asn_number)
);
CREATE INDEX IF NOT EXISTS tms_shp_supplier_idx ON tms.shipments(supplier_code);
CREATE INDEX IF NOT EXISTS tms_shp_contents_idx ON tms.shipments USING GIN (contents jsonb_path_ops);

CREATE TABLE IF NOT EXISTS tms.tracking_events (
  event_id     SERIAL PRIMARY KEY,
  shipment_id  TEXT NOT NULL REFERENCES tms.shipments(shipment_id) ON DELETE CASCADE,
  event_code   TEXT NOT NULL,
  description  TEXT,
  location     TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tms_evt_shipment_idx ON tms.tracking_events(shipment_id, occurred_at);

CREATE TABLE IF NOT EXISTS tms.idempotency_keys (
  idem_key          TEXT NOT NULL,
  request_path      TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  status_code       INT NOT NULL,
  response_body     JSONB,
  response_headers  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idem_key, request_path)
);
