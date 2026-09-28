/*
  routes/itAssets.js — IT Asset Register (it-assets.html — a separate,
  not-yet-built task wires up the page; this is the API it will call).

  Replaces the static, hardcoded, read-only IT_ASSETS JSON that
  routes/mis.js still serves at GET /api/mis/it-assets (mis.html's
  "Assets" tab). That route is UNTOUCHED here on purpose — pointing MIS's
  read-only tab at this live data is explicitly a follow-up task, not this
  one (see this file's originating task notes). Until that follow-up
  lands, the two IT asset "views" in the app are independent: the old
  static snapshot MIS reads, and this new database-backed, editable,
  Excel-importable register IT itself now owns.

  GET    /api/it-assets                      → per-category row counts +
                                                last import info (header
                                                strip / overview)
  GET    /api/it-assets/:category             → list rows, ?q= search,
                                                ?limit=&offset= pagination
  POST   /api/it-assets/:category             → create one row
  PUT    /api/it-assets/:category/:id         → update one row
  DELETE /api/it-assets/:category/:id         → delete one row (hard —
                                                equipment inventory, not
                                                approval/financial history;
                                                no FK anywhere references
                                                it_assets.id)
  POST   /api/it-assets/import                → multipart upload (field
                                                "file", .xlsx only) of IT's
                                                monthly workbook; REPLACES
                                                each present category's full
                                                row set inside one
                                                transaction — see
                                                db/migrations/028_it_assets.sql
                                                for why whole-category
                                                replace, not upsert.

  ACCESS: config/itAssetsAccess.js — write is admin+it, read additionally
  covers management+md. See that file for why this is a small local config
  rather than an entry in forms/access-registry.js's shared maps.
*/

const express = require('express');
const multer  = require('multer');
const db      = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { validate, z } = require('../middleware/validate');
const { IT_ASSETS_READ_ROLES, IT_ASSETS_WRITE_ROLES } = require('../config/itAssetsAccess');
const { parseWorkbook, CATEGORIES, CATEGORY_KEYS } = require('../services/itAssetImport');

const router = express.Router();

const readOnly  = requireRole(...IT_ASSETS_READ_ROLES);
const writeOnly = requireRole(...IT_ASSETS_WRITE_ROLES);

// Human-readable display name, same fallback routes/amendments.js's
// actorName() uses — req.user.name is the JWT's full_name claim; a bare
// login username is a worse thing to show an HOD reading "who touched
// this row" than the person's actual name.
const actorName = req => req.user.name || req.user.username;

async function audit(client, req, action, category, details) {
  await client.query(
    `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [req.user.id, actorName(req), action, 'it-assets:' + category, String(details).slice(0, 4000), req.ip]
  );
}

/* Every JSONB field in every category is a free-text string (serials,
   model names, MAC/IP strings, remarks — see the migration's own doc
   comment on why this is JSONB, not typed columns). One permissive
   per-category body schema built from CATEGORIES' own column list, rather
   than nine hand-written zod objects that could drift from the parser's
   idea of what a category's fields are. z.record would accept ANY key;
   this instead only accepts the real ones and 400s on a typo, the same
   protection KPI_DEPTS gives kpi_monthly writes. */
const categoryBodySchemas = {};
for (const key of CATEGORY_KEYS) {
  const shape = {};
  for (const col of CATEGORIES[key].columns) {
    shape[col.key] = z.string().trim().max(500).nullable().optional();
  }
  categoryBodySchemas[key] = z.object(shape).strict('Unknown field for this category');
}

const categoryParam = z.object({ category: z.enum(CATEGORY_KEYS) });
const idParams       = z.object({ category: z.enum(CATEGORY_KEYS), id: z.coerce.number().int().positive() });
const listQuery      = z.object({
  q:      z.string().trim().max(120).optional(),
  limit:  z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/* ── Overview — counts per category + last import, for a header strip ──
   Cheap: one grouped count query plus one small "latest import per
   category" query, not a table scan of every row. */
router.get('/', requireAuth, readOnly, async (req, res, next) => {
  try {
    const [counts, imports] = await Promise.all([
      db.query(`SELECT category, COUNT(*)::int AS count FROM it_assets GROUP BY category`),
      db.query(`
        SELECT DISTINCT ON (category) category, imported_at, imported_by_name,
               source_filename, row_count, previous_row_count
        FROM it_asset_imports
        ORDER BY category, imported_at DESC
      `),
    ]);

    const countByCategory  = Object.fromEntries(counts.rows.map(r => [r.category, r.count]));
    const importByCategory = Object.fromEntries(imports.rows.map(r => [r.category, r]));

    res.json({
      categories: CATEGORY_KEYS.map(key => ({
        category:    key,
        label:       CATEGORIES[key].label,
        count:       countByCategory[key] || 0,
        lastImport:  importByCategory[key] || null,
      })),
    });
  } catch (err) { next(err); }
});

/* ── List (one category) ──────────────────────────────────────────────
   ?q= searches every text value in the row's JSONB data with one ILIKE
   against the whole blob cast to text — deliberately simple rather than
   an OR of per-field ILIKEs that would have to be kept in sync with each
   category's own field list. Bounded by limit/offset (default 100, max
   500) — the mistake RAID I-19 flagged against GET /api/quarry/tickets
   (an unbounded list that became a real 784KB-gzip payload on every page
   load) is not repeated here; several categories already carry 60-130+
   rows in the one sample workbook alone. */
router.get('/:category',
  requireAuth, readOnly,
  validate(categoryParam, 'params'), validate(listQuery, 'query'),
  async (req, res, next) => {
    try {
      const { category } = req.validated.params;
      const { q, limit, offset } = req.validated.query;

      const where  = ['category = $1'];
      const params = [category];
      if (q) {
        params.push('%' + q.toLowerCase() + '%');
        where.push(`LOWER(data::text) LIKE $${params.length}`);
      }

      const [{ rows }, { rows: [{ count }] }] = await Promise.all([
        db.query(
          `SELECT id, category, data, source, created_at, updated_at, updated_by_name
           FROM it_assets WHERE ${where.join(' AND ')}
           ORDER BY id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]),
        db.query(`SELECT COUNT(*)::int AS count FROM it_assets WHERE ${where.join(' AND ')}`, params),
      ]);

      res.json({ category, label: CATEGORIES[category].label, total: count, limit, offset, rows });
    } catch (err) { next(err); }
  });

/* ── Import ────────────────────────────────────────────────────────────
   Registered BEFORE POST /:category on purpose: Express matches routes in
   declaration order, and '/:category' would otherwise swallow POST /import
   as if 'import' were a category name (and 400 it against the category
   enum) before this handler ever ran. A static path must be declared
   ahead of a parameterized one that could shadow it.

   Memory storage: the source workbook is well under 1MB (10 sheets,
   under 500 data rows total in the real sample), so buffering the whole
   upload in memory rather than to a temp file keeps this simple. 10MB
   cap and an .xlsx-only check are the guard against an oversized or
   wrong-type upload — this is a monthly, IT-only action, not a public
   endpoint, so the limits are generous rather than tight. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const okMime = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const okExt  = /\.xlsx$/i.test(file.originalname || '');
    if (!okMime && !okExt) return cb(new Error('Only .xlsx workbooks are accepted.'));
    cb(null, true);
  },
});

router.post('/import',
  requireAuth, writeOnly,
  (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded (expected multipart field "file").' });

      /* The multer filter only checks mimetype/extension, which a
         corrupted download or a mis-renamed file can satisfy while still
         not being a real xlsx (a zip archive) underneath — exceljs then
         throws while unzipping it. That is a bad-upload case exactly like
         "wrong file type", not a server fault, so it is caught here and
         answered with 400, rather than falling through to next(err) and
         the central handler's generic 500. */
      let parsed;
      try {
        parsed = await parseWorkbook(req.file.buffer);
      } catch {
        return res.status(400).json({
          error: 'This file could not be read as an Excel workbook — is it corrupted, or not really a .xlsx file?',
        });
      }
      if (!parsed.anyFound) {
        return res.status(400).json({
          error: 'None of the expected IT Asset Register sheets were found in this workbook — is this the right file?',
          missing: parsed.missing,
        });
      }

      /* Whole-category replace inside one transaction — see
         db/migrations/028_it_assets.sql for why re-import replaces rather
         than merges/upserts (no reliable natural key on most sheets). A
         category untouched by this upload (missing/unrecognized sheet)
         keeps its existing rows completely alone: no DELETE, no
         it_asset_imports row for it. */
      const summary = await db.withTransaction(async (client) => {
        const touched = [];
        for (const [category, { rows, sheetName }] of Object.entries(parsed.categories)) {
          const { rows: [{ count: previousCount }] } = await client.query(
            `SELECT COUNT(*)::int AS count FROM it_assets WHERE category = $1`, [category]);

          await client.query(`DELETE FROM it_assets WHERE category = $1`, [category]);

          if (rows.length) {
            const cols = ['category', 'data', 'source', 'updated_by', 'updated_by_name'];
            const values = [];
            const tuples = rows.map((r, i) => {
              const base = i * cols.length;
              values.push(category, JSON.stringify(r), 'import', req.user.id, actorName(req));
              return '(' + cols.map((_, j) => '$' + (base + j + 1)).join(',') + ')';
            });
            await client.query(
              `INSERT INTO it_assets (${cols.join(',')}) VALUES ${tuples.join(',')}`, values);
          }

          await client.query(
            `INSERT INTO it_asset_imports
               (category, imported_by, imported_by_name, source_filename, row_count, previous_row_count)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [category, req.user.id, actorName(req), req.file.originalname, rows.length, previousCount]);

          touched.push({
            category, label: CATEGORIES[category].label, sheetName,
            previousCount, newCount: rows.length,
          });
        }

        await audit(client, req, 'IT_ASSET_IMPORT', 'all',
          `${req.file.originalname}: ` +
          touched.map(t => `${t.category} ${t.previousCount}->${t.newCount}`).join(', ') +
          (parsed.missing.length ? `; not found: ${parsed.missing.map(m => m.category).join(', ')}` : ''));

        return touched;
      });

      res.json({ ok: true, filename: req.file.originalname, imported: summary, missing: parsed.missing });
    } catch (err) { next(err); }
  });

/* ── Create ────────────────────────────────────────────────────────── */
router.post('/:category',
  requireAuth, writeOnly,
  validate(categoryParam, 'params'),
  async (req, res, next) => {
    try {
      const { category } = req.validated.params;
      const bodyResult = categoryBodySchemas[category].safeParse(req.body);
      if (!bodyResult.success) {
        const issue = bodyResult.error.issues[0];
        return res.status(400).json({ error: `Invalid ${issue.path.join('.') || 'body'}: ${issue.message}` });
      }
      const data = Object.fromEntries(
        Object.entries(bodyResult.data).map(([k, v]) => [k, v === '' ? null : v]));

      const row = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO it_assets (category, data, source, updated_by, updated_by_name)
           VALUES ($1, $2, 'manual', $3, $4)
           RETURNING id, category, data, source, created_at, updated_at, updated_by_name`,
          [category, JSON.stringify(data), req.user.id, actorName(req)]);
        await audit(client, req, 'IT_ASSET_CREATE', category, `row ${rows[0].id} created: ${JSON.stringify(data).slice(0, 300)}`);
        return rows[0];
      });

      res.status(201).json(row);
    } catch (err) { next(err); }
  });

/* ── Update ────────────────────────────────────────────────────────── */
router.put('/:category/:id',
  requireAuth, writeOnly,
  validate(idParams, 'params'),
  async (req, res, next) => {
    try {
      const { category, id } = req.validated.params;
      const bodyResult = categoryBodySchemas[category].partial().safeParse(req.body);
      if (!bodyResult.success) {
        const issue = bodyResult.error.issues[0];
        return res.status(400).json({ error: `Invalid ${issue.path.join('.') || 'body'}: ${issue.message}` });
      }
      if (Object.keys(bodyResult.data).length === 0) {
        return res.status(400).json({ error: 'Nothing to update.' });
      }
      const patch = Object.fromEntries(
        Object.entries(bodyResult.data).map(([k, v]) => [k, v === '' ? null : v]));

      const row = await db.withTransaction(async (client) => {
        const { rows: [before] } = await client.query(
          `SELECT id, data FROM it_assets WHERE id = $1 AND category = $2`, [id, category]);
        if (!before) return null;

        const merged = { ...before.data, ...patch };
        const { rows } = await client.query(
          `UPDATE it_assets SET data = $1, updated_at = NOW(), updated_by = $2, updated_by_name = $3
           WHERE id = $4 AND category = $5
           RETURNING id, category, data, source, created_at, updated_at, updated_by_name`,
          [JSON.stringify(merged), req.user.id, actorName(req), id, category]);

        const changed = Object.keys(patch).filter(k => String(before.data[k] ?? '') !== String(merged[k] ?? ''));
        if (changed.length) {
          await audit(client, req, 'IT_ASSET_UPDATE', category,
            `row ${id}: ` + changed.map(k => `${k}: ${before.data[k] ?? '—'} -> ${merged[k] ?? '—'}`).join('; '));
        }
        return rows[0];
      });

      if (!row) return res.status(404).json({ error: 'No such row in this category.' });
      res.json(row);
    } catch (err) { next(err); }
  });

/* ── Delete ────────────────────────────────────────────────────────── */
router.delete('/:category/:id',
  requireAuth, writeOnly,
  validate(idParams, 'params'),
  async (req, res, next) => {
    try {
      const { category, id } = req.validated.params;

      const deleted = await db.withTransaction(async (client) => {
        const { rows } = await client.query(
          `DELETE FROM it_assets WHERE id = $1 AND category = $2 RETURNING id, data`, [id, category]);
        if (!rows[0]) return null;
        await audit(client, req, 'IT_ASSET_DELETE', category,
          `row ${id} deleted: ${JSON.stringify(rows[0].data).slice(0, 300)}`);
        return rows[0];
      });

      if (!deleted) return res.status(404).json({ error: 'No such row in this category.' });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

module.exports = router;
