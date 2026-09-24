-- Supplier Relationship Management / Supplier Master
CREATE SCHEMA IF NOT EXISTS srm;

CREATE TABLE IF NOT EXISTS srm.suppliers (
  supplier_code      TEXT PRIMARY KEY CHECK (supplier_code ~ '^SUP-[0-9]{6}$'),
  erp_vendor_number  TEXT NOT NULL UNIQUE,
  legal_name         TEXT NOT NULL,
  trading_name       TEXT,
  status             TEXT NOT NULL CHECK (status IN ('ACTIVE','ON_HOLD','BLOCKED')),
  status_reason      TEXT,
  tier               TEXT NOT NULL CHECK (tier IN ('STRATEGIC','PREFERRED','APPROVED','CONDITIONAL')),
  risk_rating        TEXT NOT NULL CHECK (risk_rating IN ('LOW','MEDIUM','HIGH')),
  country            CHAR(2) NOT NULL,
  duns               TEXT,
  portal_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  asn_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  onboarded_on       DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS srm.supplier_contacts (
  contact_id     TEXT PRIMARY KEY,
  supplier_code  TEXT NOT NULL REFERENCES srm.suppliers(supplier_code) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('PRIMARY','LOGISTICS','QUALITY','FINANCE')),
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS srm.supplier_sites (
  site_code      TEXT PRIMARY KEY,
  supplier_code  TEXT NOT NULL REFERENCES srm.suppliers(supplier_code) ON DELETE CASCADE,
  site_type      TEXT NOT NULL CHECK (site_type IN ('SHIP_FROM','REMIT_TO','MANUFACTURING')),
  name           TEXT NOT NULL,
  address_line1  TEXT,
  city           TEXT,
  region         TEXT,
  postal_code    TEXT,
  country        CHAR(2) NOT NULL,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS srm.consumer_entitlements (
  consumer_id     TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  consumer_type   TEXT NOT NULL CHECK (consumer_type IN ('supplier-partner','internal-application','operations-support')),
  supplier_codes  TEXT[] NOT NULL,          -- '*' = all suppliers
  scopes          TEXT[] NOT NULL,          -- supplier-orders.read / supplier-orders.write
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  cost_center     TEXT,
  contact_email   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
