-- ERP Purchasing (SAP-flavoured system of record)
CREATE SCHEMA IF NOT EXISTS erp;

CREATE TABLE IF NOT EXISTS erp.purchasing_orgs (
  code          TEXT PRIMARY KEY,               -- e.g. AMUS
  name          TEXT NOT NULL,                  -- e.g. Acme-US
  company_code  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS erp.plants (
  plant_code    TEXT PRIMARY KEY,               -- e.g. 1101
  site_code     TEXT NOT NULL UNIQUE,           -- enterprise site code, e.g. US-AUBURN-HILLS
  name          TEXT NOT NULL,
  street        TEXT,
  city          TEXT,
  region        TEXT,
  postal_code   TEXT,
  country       CHAR(2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS erp.purchase_orders (
  po_number      TEXT PRIMARY KEY CHECK (po_number ~ '^[0-9]{10}$'),
  vendor_id      TEXT NOT NULL CHECK (vendor_id ~ '^[0-9]{10}$'),   -- ERP vendor number, NOT the SRM supplier code
  purch_org      TEXT NOT NULL REFERENCES erp.purchasing_orgs(code),
  doc_date       DATE NOT NULL,
  currency       CHAR(3) NOT NULL,
  status_code    TEXT NOT NULL DEFAULT '01',                      -- see erp.status_codes
  delivery_date  DATE NOT NULL,
  plant          TEXT NOT NULL REFERENCES erp.plants(plant_code),
  incoterms      TEXT,
  payment_terms  TEXT,
  buyer_name     TEXT,
  revision       INT NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS erp_po_vendor_idx ON erp.purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS erp_po_changed_idx ON erp.purchase_orders(changed_at);

CREATE TABLE IF NOT EXISTS erp.po_items (
  po_number       TEXT NOT NULL REFERENCES erp.purchase_orders(po_number) ON DELETE CASCADE,
  item_no         TEXT NOT NULL CHECK (item_no ~ '^[0-9]{5}$'),     -- '00010' == line 10
  material        TEXT NOT NULL,
  short_text      TEXT NOT NULL,
  quantity        NUMERIC(15,3) NOT NULL CHECK (quantity > 0),
  uom             TEXT NOT NULL,
  net_price       NUMERIC(15,2) NOT NULL DEFAULT 0,
  price_unit      INT NOT NULL DEFAULT 1,
  confirmed_qty   NUMERIC(15,3) NOT NULL DEFAULT 0,
  confirmed_date  DATE,
  shipped_qty     NUMERIC(15,3) NOT NULL DEFAULT 0,
  reject_reason   TEXT,
  PRIMARY KEY (po_number, item_no)
);

CREATE SEQUENCE IF NOT EXISTS erp.confirmation_seq START 7100000101;
CREATE TABLE IF NOT EXISTS erp.confirmations (
  confirmation_no   TEXT PRIMARY KEY,
  po_number         TEXT NOT NULL REFERENCES erp.purchase_orders(po_number) ON DELETE CASCADE,
  po_revision       INT NOT NULL,
  conf_category     TEXT NOT NULL CHECK (conf_category IN ('AB','AC','RJ')),
  vendor_reference  TEXT,
  note              TEXT,
  status            TEXT NOT NULL CHECK (status IN ('POSTED','IN_REVIEW')),
  items             JSONB NOT NULL,
  posted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (po_number, po_revision)
);

CREATE SEQUENCE IF NOT EXISTS erp.delivery_seq START 180000201;
CREATE TABLE IF NOT EXISTS erp.inbound_deliveries (
  delivery_no     TEXT PRIMARY KEY,
  vendor_id       TEXT NOT NULL,
  asn_reference   TEXT NOT NULL,
  items           JSONB NOT NULL,                 -- [{po_number,item_no,quantity}]
  status          TEXT NOT NULL CHECK (status IN ('POSTED','REVERSED')),
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reversed_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS erp_delivery_asn_uq
  ON erp.inbound_deliveries(vendor_id, asn_reference) WHERE status = 'POSTED';

CREATE TABLE IF NOT EXISTS erp.idempotency_keys (
  idem_key          TEXT NOT NULL,
  request_path      TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  status_code       INT NOT NULL,
  response_body     JSONB,
  response_headers  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idem_key, request_path)
);
