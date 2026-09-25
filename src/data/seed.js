'use strict';

/**
 * Seeds all three backends. Safe to re-run: every insert is ON CONFLICT DO NOTHING
 * and child rows are only inserted when their parent was newly created.
 *
 *   node src/data/seed.js            migrate + insert missing seed rows
 *   node src/data/seed.js --reset    DROP schemas, re-create, re-seed (demo reset)
 */
const config = require('../config');
const { getPool, withTransaction, closeAll } = require('../shared/db');
const { migrateService, dropService } = require('../db/migrate');

const data = {
  erp: require('./erp.json'),
  srm: require('./srm.json'),
  tms: require('./tms.json'),
};

async function seedErp(c) {
  const d = data.erp;
  for (const o of d.purchasing_orgs) {
    await c.query(
      `INSERT INTO erp.purchasing_orgs (code, name, company_code) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [o.code, o.name, o.company_code]
    );
  }
  for (const p of d.plants) {
    await c.query(
      `INSERT INTO erp.plants (plant_code, site_code, name, street, city, region, postal_code, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [p.plant_code, p.site_code, p.name, p.street, p.city, p.region, p.postal_code, p.country]
    );
  }
  for (const po of d.purchase_orders) {
    const r = await c.query(
      `INSERT INTO erp.purchase_orders (po_number, vendor_id, purch_org, doc_date, currency, status_code, delivery_date,
          plant, incoterms, payment_terms, buyer_name, revision, created_at, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING RETURNING po_number`,
      [po.po_number, po.vendor_id, po.purch_org, po.doc_date, po.currency, po.status_code, po.delivery_date, po.plant,
        po.incoterms, po.payment_terms, po.buyer_name, po.revision, po.created_at, po.changed_at]
    );
    if (!r.rowCount) continue;
    for (const it of po.items) {
      await c.query(
        `INSERT INTO erp.po_items (po_number, item_no, material, short_text, quantity, uom, net_price, price_unit,
            confirmed_qty, confirmed_date, shipped_qty, reject_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [po.po_number, it.item_no, it.material, it.short_text, it.quantity, it.uom, it.net_price,
          it.confirmed_qty || 0, it.confirmed_date || null, it.shipped_qty || 0, it.reject_reason || null]
      );
    }
  }
  for (const cf of d.confirmations) {
    await c.query(
      `INSERT INTO erp.confirmations (confirmation_no, po_number, po_revision, conf_category, vendor_reference, note, status, items, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [cf.confirmation_no, cf.po_number, cf.po_revision, cf.conf_category, cf.vendor_reference, cf.note, cf.status,
        JSON.stringify(cf.items), cf.posted_at]
    );
  }
  for (const dl of d.inbound_deliveries) {
    await c.query(
      `INSERT INTO erp.inbound_deliveries (delivery_no, vendor_id, asn_reference, items, status, posted_at, reversed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [dl.delivery_no, dl.vendor_id, dl.asn_reference, JSON.stringify(dl.items), dl.status, dl.posted_at, dl.reversed_at || null]
    );
  }
}

async function seedSrm(c) {
  const d = data.srm;
  for (const s of d.suppliers) {
    await c.query(
      `INSERT INTO srm.suppliers (supplier_code, erp_vendor_number, legal_name, trading_name, status, status_reason, tier,
          risk_rating, country, duns, portal_enabled, asn_enabled, onboarded_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [s.supplier_code, s.erp_vendor_number, s.legal_name, s.trading_name, s.status, s.status_reason, s.tier,
        s.risk_rating, s.country, s.duns, s.portal_enabled, s.asn_enabled, s.onboarded_on]
    );
  }
  for (const ct of d.contacts) {
    await c.query(
      `INSERT INTO srm.supplier_contacts (contact_id, supplier_code, role, full_name, email, phone)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [ct.contact_id, ct.supplier_code, ct.role, ct.full_name, ct.email, ct.phone]
    );
  }
  for (const st of d.sites) {
    await c.query(
      `INSERT INTO srm.supplier_sites (site_code, supplier_code, site_type, name, address_line1, city, region, postal_code, country, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [st.site_code, st.supplier_code, st.site_type, st.name, st.address_line1, st.city, st.region, st.postal_code,
        st.country, st.active]
    );
  }
  for (const e of d.entitlements) {
    await c.query(
      `INSERT INTO srm.consumer_entitlements (consumer_id, display_name, consumer_type, supplier_codes, scopes, active, cost_center, contact_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [e.consumer_id, e.display_name, e.consumer_type, e.supplier_codes, e.scopes, e.active, e.cost_center, e.contact_email]
    );
  }
}

async function seedTms(c) {
  const d = data.tms;
  for (const cr of d.carriers) {
    await c.query(
      `INSERT INTO tms.carriers (carrier_code, scac, name, mode, tracking_url_template) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [cr.carrier_code, cr.scac, cr.name, cr.mode, cr.tracking_url_template]
    );
  }
  for (const s of d.shipments) {
    const r = await c.query(
      `INSERT INTO tms.shipments (shipment_id, asn_number, supplier_code, carrier_scac, tracking_id, milestone, milestone_since,
          origin, destination, planned_ship_at, eta, contents, handling_units, cancel_reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING RETURNING shipment_id`,
      [s.shipment_id, s.asn_number, s.supplier_code, s.carrier_scac, s.tracking_id, s.milestone, s.milestone_since,
        JSON.stringify(s.origin), JSON.stringify(s.destination), s.planned_ship_at, s.eta, JSON.stringify(s.contents),
        JSON.stringify(s.handling_units), s.cancel_reason || null, s.created_at, s.updated_at]
    );
    if (!r.rowCount) continue;
    for (const ev of s.events) {
      await c.query(
        `INSERT INTO tms.tracking_events (shipment_id, event_code, description, location, occurred_at, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [s.shipment_id, ev.event_code, ev.description, ev.location, ev.occurred_at]
      );
    }
  }
}

const seeders = { erp: seedErp, srm: seedSrm, tms: seedTms };
const countSql = {
  erp: 'SELECT COUNT(*)::int AS n FROM erp.purchase_orders',
  srm: 'SELECT COUNT(*)::int AS n FROM srm.suppliers',
  tms: 'SELECT COUNT(*)::int AS n FROM tms.carriers',
};

async function seedService(name) {
  const pool = getPool(config.services[name].databaseUrl);
  await withTransaction(pool, (client) => seeders[name](client));
  console.log(`[seed] ${name} seeded`);
}

/** Used at server start (AUTO_SEED=true): seeds only services whose tables are empty. */
async function seedIfEmpty(names = config.enabledServices) {
  for (const name of names) {
    const pool = getPool(config.services[name].databaseUrl);
    const { rows } = await pool.query(countSql[name]);
    if (rows[0].n === 0) await seedService(name);
  }
}

module.exports = { seedService, seedIfEmpty };

if (require.main === module) {
  const reset = process.argv.includes('--reset') || process.argv.includes('--clear');
  const names = Object.keys(config.services);
  (async () => {
    for (const name of names) {
      if (reset) {
        await dropService(name);
        console.log(`[seed] ${name} schema dropped`);
      }
      await migrateService(name);
      await seedService(name);
    }
    console.log(reset ? '[seed] reset complete' : '[seed] complete (existing rows left untouched)');
  })()
    .catch((err) => {
      console.error('[seed] failed:', err.message);
      if (err.code === 'ECONNREFUSED') {
        console.error('        Is Postgres running? Try: bash scripts/start-postgres.sh');
      }
      process.exitCode = 1;
    })
    .finally(closeAll);
}
