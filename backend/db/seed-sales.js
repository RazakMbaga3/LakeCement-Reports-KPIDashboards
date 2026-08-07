/*
  db/seed-sales.js — Sales territory roster seed

  Fills sales_territories (Division -> Zone -> Sales Officer hierarchy).
  Run after db/migrate.js has applied 006_sales.sql.

  Usage: node db/seed-sales.js

  ⚠ TERRITORIES below is a placeholder — replace with the real roster
  (divisions, their zones, each zone's Sales Officer, each division's
  Divisional Manager) before running this for real. officer_code must be
  a stable lowercase slug (letters/digits/underscore only) — it's used as
  a daily_reports JSONB key prefix (sp_<officer_code>_proj_total), so once
  officers start submitting projections against a code, don't change it;
  add a new row and mark the old one inactive instead.
*/

require('dotenv').config();
const db = require('./index');

const TERRITORIES = [
  // { officerCode: 'j_mwakalinga', salesOfficer: 'John Mwakalinga', zone: 'DAR-1',
  //   division: 'Division 1 — Dar es Salaam', divisionalManager: 'TBD', sortOrder: 10 },
];

/* officer_code is used as a daily_reports JSONB key prefix AND is
   rendered into an HTML attribute (forms/sales-projection-form.html) —
   the render side escapes it defensively, but enforcing the documented
   "safe slug" convention here too means it can never contain anything
   that would need escaping in the first place. */
const SAFE_OFFICER_CODE = /^[a-z0-9_]+$/;

async function seed() {
  if (!TERRITORIES.length) {
    console.log('⚠️  TERRITORIES is empty — edit db/seed-sales.js with the real roster before running.');
    process.exit(1);
  }

  const badCode = TERRITORIES.find(t => !SAFE_OFFICER_CODE.test(t.officerCode));
  if (badCode) {
    console.error(`❌ officerCode "${badCode.officerCode}" isn't a safe slug — use only lowercase letters, digits, underscore.`);
    process.exit(1);
  }

  console.log('🌱 Seeding sales territories...\n');
  for (const t of TERRITORIES) {
    try {
      await db.query(`
        INSERT INTO sales_territories (officer_code, sales_officer, zone, division, divisional_manager, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (officer_code) DO UPDATE SET
          sales_officer      = EXCLUDED.sales_officer,
          zone               = EXCLUDED.zone,
          division           = EXCLUDED.division,
          divisional_manager = EXCLUDED.divisional_manager,
          sort_order         = EXCLUDED.sort_order,
          active             = true,
          updated_at         = NOW()
      `, [t.officerCode, t.salesOfficer, t.zone, t.division, t.divisionalManager || null, t.sortOrder || 100]);
      console.log(`  ✅ ${t.officerCode.padEnd(20)} (${t.zone}, ${t.division})`);
    } catch (err) {
      console.error(`  ❌ ${t.officerCode}: ${err.message}`);
    }
  }

  console.log('\n✅ Sales territory seeding complete.');
  process.exit(0);
}

seed();
