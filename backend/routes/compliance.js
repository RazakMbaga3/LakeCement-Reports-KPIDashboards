/*
  routes/compliance.js — the Compliance Master API (compliance.html).

  Everything a department needs to keep its statutory obligations current:
  the register, the dashboard summary, each record's periods / reviews /
  documents & versions / reminders / history, the workbook import, and the
  reminder settings. Status is never stored — every read decorates rows with
  services/complianceStatus.js, so the dashboard, the register, the emails
  and the KPI suggestion can never disagree about what is overdue.

  ACCESS (config/complianceAccess.js): a department reads and maintains its
  own obligations only; md / management / admin read everything; md and
  admin hold the reminder settings; admin alone imports. A record outside
  the caller's scope answers 404, not 403 — its existence is not leaked.

  Static paths are declared BEFORE /items/:id. The IT register shipped with
  exactly that shadowing bug (POST /import swallowed by /:category).
*/
const crypto  = require('crypto');
const express = require('express');
const multer  = require('multer');
const ExcelJS = require('exceljs');
const db      = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validate, z, zDate } = require('../middleware/validate');
const A  = require('../config/complianceAccess');
const { OWNER_ROLES, roleLabel, KPI_DEPT_ROLE } = require('../config/complianceDepartments');
const S  = require('../services/complianceStatus');
const D  = require('../services/complianceData');
const { parseComplianceWorkbook, planImport, commitImport } = require('../services/complianceImport');
const { mailConfigured, makeTransport } = require('../services/mailer');

const router = express.Router();
router.use(requireAuth);

const actorName = req => req.user.name || req.user.username;
const actor = req => ({ id: req.user.id, name: actorName(req) });
const today = () => S.todayIn();

async function audit(q, req, action, details) {
  await q.query(
    `INSERT INTO audit_log (user_id, username, action, form_type, details, ip_address) VALUES ($1,$2,$3,'compliance',$4,$5)`,
    [req.user.id, actorName(req), action, String(details).slice(0, 4000), req.ip]);
}
async function history(q, req, itemId, action, changes, note) {
  await q.query(
    `INSERT INTO compliance_history (item_id, actor_id, actor_name, action, changes, note) VALUES ($1,$2,$3,$4,$5,$6)`,
    [itemId, req.user.id, actorName(req), action, changes ? JSON.stringify(changes) : null, note || null]);
}

/* Decorated items in the caller's scope. */
async function scopedItems(req, opts = {}) {
  const settings = await D.loadSettings(db);
  const items = await D.loadItems(db, { scope: A.scopeRole(req.user), includeArchived: !!opts.includeArchived });
  const t = opts.today || today();
  D.simulatePeriods(items, t, settings);
  D.decorate(items, t, settings);
  return { items, settings, today: t };
}

/* One item, with req.can set; 404 when missing OR out of scope. */
async function loadOne(req, res, id) {
  const settings = await D.loadSettings(db);
  const items = await D.loadItems(db, { ids: [id], includeArchived: true });
  const it = items[0];
  if (!it || !A.complianceAccess(req.user, it).read) { res.status(404).json({ error: 'Compliance record not found.' }); return null; }
  D.simulatePeriods(items, today(), settings);
  D.decorate(items, today(), settings);
  req.can = A.complianceAccess(req.user, it);
  return it;
}
const deny = (res, what) => res.status(403).json({ error: `You do not have permission to ${what} on this record.` });
const idParam = z.object({ id: z.coerce.number().int().positive() });

/* Postgres CHECK / FK violations are bad input, not server faults. */
function dbInputError(err, res) {
  if (err && (err.code === '23514' || err.code === '23502' || err.code === '22007' || err.code === '22008' || err.code === '23503')) {
    res.status(400).json({ error: 'That combination of values is not valid for this record (' + (err.constraint || err.code) + ').' });
    return true;
  }
  return false;
}

/* ── Uploads ──────────────────────────────────────────────────────────────
   Documents are kept in Postgres (migration 038 explains why). The type is
   checked by extension AND by the file's first bytes, and the stored
   content type comes from that check, never from what the browser claimed.
   At most two uploads are buffered at once (a 10 MB file costs ~30 MB
   transiently — node-postgres hex-encodes bytea), so a burst cannot push
   the process toward pm2's 300 MB restart. */
const MAX_DOC_BYTES = Math.min(10, Math.max(1, +(process.env.COMPLIANCE_DOC_MAX_MB || 10))) * 1024 * 1024;
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOC_BYTES, files: 1 } });
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
let uploadsInFlight = 0;

const DOC_TYPES = [
  { ext: /\.pdf$/i,  mime: 'application/pdf', magic: b => b.slice(0, 5).toString('latin1') === '%PDF-' },
  { ext: /\.png$/i,  mime: 'image/png',       magic: b => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: /\.jpe?g$/i, mime: 'image/jpeg',     magic: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: /\.docx$/i, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: b => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  { ext: /\.xlsx$/i, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: b => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
];
function classifyDoc(file) {
  const t = DOC_TYPES.find(d => d.ext.test(file.originalname || ''));
  if (!t) return { error: 'Only PDF, JPG, PNG, DOCX or XLSX files can be attached.' };
  if (!t.magic(file.buffer)) return { error: 'This file is not what its name says it is — the contents do not match the extension.' };
  return { mime: t.mime };
}
function withUpload(mw, optional) {
  return (req, res, next) => {
    if (uploadsInFlight >= 2) return res.status(503).json({ error: 'Another document is uploading — please try again in a moment.' });
    uploadsInFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; uploadsInFlight--; } };
    res.on('finish', release); res.on('close', release);
    mw(req, res, (err) => {
      if (err) {
        release();
        const msg = err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${MAX_DOC_BYTES / 1048576} MB.` : (err.message || 'Upload failed.');
        return res.status(400).json({ error: msg });
      }
      if (!optional && !req.file) { release(); return res.status(400).json({ error: 'No file was attached (expected field "file").' }); }
      next();
    });
  };
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function storeDocument(client, req, item, file, meta) {
  const kind = classifyDoc(file);
  if (kind.error) { const e = new Error(kind.error); e.status = 400; throw e; }
  const hash = sha256(file.buffer);
  await client.query(
    `INSERT INTO compliance_blobs (sha256, size_bytes, bytes) VALUES ($1,$2,$3) ON CONFLICT (sha256) DO NOTHING`,
    [hash, file.buffer.length, file.buffer]);
  await client.query('SELECT id FROM compliance_items WHERE id = $1 FOR UPDATE', [item.id]);
  const { rows: [{ v }] } = await client.query('SELECT COALESCE(MAX(version_no), 0) + 1 AS v FROM compliance_documents WHERE item_id = $1', [item.id]);
  const name = String(file.originalname || 'document').replace(/[\\/\r\n"]/g, '_').slice(0, 255);
  const { rows: [doc] } = await client.query(
    `INSERT INTO compliance_documents (item_id, period_id, assessment_id, version_no, doc_type, file_name, mime_type, size_bytes,
       blob_sha256, valid_from, valid_to, reference_no, note, uploaded_by, uploaded_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id, version_no, doc_type, file_name, mime_type, size_bytes, valid_from, valid_to, reference_no, note, uploaded_by_name, uploaded_at`,
    [item.id, meta.period_id || null, meta.assessment_id || null, v, meta.doc_type || 'certificate', name, kind.mime,
      file.buffer.length, hash, meta.valid_from || null, meta.valid_to || null, meta.reference_no || null, meta.note || null,
      req.user.id, actorName(req)]);
  return doc;
}

/* ═══ Capabilities, summary, counts ═════════════════════════════════════ */
router.get('/me', async (req, res, next) => {
  try {
    const caps = A.capabilities(req.user);
    const { rows } = await db.query('SELECT id FROM compliance_contacts WHERE user_id = $1', [req.user.id]);
    res.json(Object.assign(caps, {
      contactId: rows.length ? rows[0].id : null,
      departments: OWNER_ROLES.map(r => ({ role: r, label: roleLabel(r) })),
      today: today(),
    }));
  } catch (err) { next(err); }
});

const listFilters = z.object({
  timeframe: z.enum(['all', 'month', 'quarter', 'year', 'next30', 'next90', 'custom']).default('all'),
  from: zDate.optional(), to: zDate.optional(),
  carryOverdue: z.enum(['0', '1']).optional(),
  dept: z.string().max(30).optional(), kind: z.enum(['validity', 'recurring', 'condition']).optional(),
  entity: z.enum(['LCL', 'BRL', 'UCL']).optional(), agency: z.string().max(200).optional(),
  status: z.enum(['active', 'due', 'overdue', 'undated', 'inactive', 'archived']).optional(),
  section: z.string().max(60).optional(), group: z.coerce.number().int().positive().optional(),
  verified: z.enum(['yes', 'no']).optional(), flag: z.enum(['renewal', 'nodoc', 'noperson']).optional(),
  mine: z.enum(['1']).optional(), q: z.string().max(120).optional(),
  groupBy: z.enum(['department', 'section']).optional(),
  sort: z.enum(['deadline', 'title', 'department', 'status']).default('deadline'),
  limit: z.coerce.number().int().min(1).max(500).default(500), offset: z.coerce.number().int().min(0).default(0),
});
function filtersFrom(req) {
  const f = Object.assign({}, req.validated.query);
  f.carryOverdue = f.carryOverdue !== '0';
  if (f.mine) f.mine = req.user.id;
  return f;
}

router.get('/summary', validate(listFilters, 'query'), async (req, res, next) => {
  try {
    const { items, today: t } = await scopedItems(req, { includeArchived: false });
    const f = filtersFrom(req);
    const filtered = D.filterItems(items, f, t);
    const sum = D.summarize(filtered, { groupBy: f.groupBy });
    const [lastImport, mail] = await Promise.all([
      db.query(`SELECT at, by_name, file_name FROM compliance_imports ORDER BY at DESC LIMIT 1`),
      db.query(`SELECT
          COUNT(*) FILTER (WHERE n.status = 'held_unverified')::int AS held,
          COUNT(*) FILTER (WHERE n.status IN ('failed','gave_up') AND n.updated_at > NOW() - INTERVAL '7 days')::int AS failed7d,
          COUNT(*) FILTER (WHERE n.status = 'sent' AND n.sent_at > NOW() - INTERVAL '7 days')::int AS sent7d,
          COUNT(*) FILTER (WHERE n.status = 'skipped_no_email')::int AS noEmail
        FROM compliance_notifications n
        ${A.scopeRole(req.user) ? 'JOIN compliance_items i ON i.id = n.item_id AND i.owner_role = $1' : ''}`,
      A.scopeRole(req.user) ? [A.scopeRole(req.user)] : []),
    ]);
    const [from, to] = D.timeframeRange(f.timeframe, t, f.from, f.to);
    res.json(Object.assign(sum, {
      today: t, scope: A.scopeRole(req.user), range: { from, to, carryOverdue: f.carryOverdue },
      lastImport: lastImport.rows[0] || null, reminders: mail.rows[0],
      agencies: [...new Set(items.map(i => i.agency).filter(Boolean))].sort(),
      sections: [...new Set(items.map(i => i.section_label).filter(Boolean))].sort(),
    }));
  } catch (err) { next(err); }
});

router.get('/counts', async (req, res, next) => {
  try {
    const { items } = await scopedItems(req);
    const live = items.filter(i => !['inactive', 'archived'].includes(i.computed.status));
    const mine = live.filter(i => i.direct.concat(i.second).some(p => p.userId === req.user.id));
    res.json({
      due: live.filter(i => i.computed.status === 'due').length,
      overdue: live.filter(i => i.computed.status === 'overdue').length,
      unverified: live.filter(i => !i.verified_at).length,
      mine: mine.filter(i => ['due', 'overdue'].includes(i.computed.status)).length,
    });
  } catch (err) { next(err); }
});

/* ═══ Register ══════════════════════════════════════════════════════════ */
const SORTS = {
  deadline: (a, b) => S.STATUS_ORDER.indexOf(a.computed.status) - S.STATUS_ORDER.indexOf(b.computed.status)
    || String(a.computed.deadline || '9999').localeCompare(String(b.computed.deadline || '9999')) || a.title.localeCompare(b.title),
  title: (a, b) => a.title.localeCompare(b.title),
  department: (a, b) => roleLabel(a.owner_role).localeCompare(roleLabel(b.owner_role)) || a.title.localeCompare(b.title),
  status: (a, b) => S.STATUS_ORDER.indexOf(a.computed.status) - S.STATUS_ORDER.indexOf(b.computed.status) || a.title.localeCompare(b.title),
};

router.get('/items', validate(listFilters, 'query'), async (req, res, next) => {
  try {
    const f = filtersFrom(req);
    const { items, today: t } = await scopedItems(req, { includeArchived: f.status === 'archived' });
    const filtered = D.filterItems(items, f, t).sort(SORTS[f.sort]);
    res.json({
      total: filtered.length, limit: f.limit, offset: f.offset, today: t,
      rows: filtered.slice(f.offset, f.offset + f.limit).map(D.present),
    });
  } catch (err) { next(err); }
});

router.get('/items/export.xlsx', validate(listFilters, 'query'), async (req, res, next) => {
  try {
    const f = filtersFrom(req);
    const { items, today: t } = await scopedItems(req, { includeArchived: f.status === 'archived' });
    const rows = D.filterItems(items, f, t).sort(SORTS.department);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Lake Cement MIS — Compliance Master';
    const ws = wb.addWorksheet('Compliance Register', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Department', key: 'dept', width: 22 }, { header: 'Section (workbook)', key: 'section', width: 20 },
      { header: 'Obligation', key: 'title', width: 48 }, { header: 'Agency', key: 'agency', width: 30 },
      { header: 'Kind', key: 'kind', width: 11 }, { header: 'Reference', key: 'ref', width: 16 },
      { header: 'Valid from', key: 'vf', width: 12 }, { header: 'Deadline', key: 'deadline', width: 12 },
      { header: 'Status', key: 'status', width: 12 }, { header: 'Days left', key: 'days', width: 10 },
      { header: 'Detail', key: 'reason', width: 36 }, { header: 'Responsible person', key: 'direct', width: 22 },
      { header: 'Supervisor', key: 'second', width: 22 }, { header: 'Renewal in progress', key: 'renewal', width: 12 },
      { header: 'Verified', key: 'verified', width: 10 }, { header: 'Documents', key: 'docs', width: 10 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF173158' } };
    for (const it of rows) {
      ws.addRow({
        dept: roleLabel(it.owner_role), section: it.section_label, title: it.title, agency: it.agency, kind: it.kind,
        ref: it.reference_no, vf: it.valid_from, deadline: it.computed.deadline, status: S.STATUS_LABEL[it.computed.status],
        days: it.computed.daysLeft, reason: it.computed.reason, direct: it.direct.map(p => p.name).join(', '),
        second: it.second.map(p => p.name).join(', '), renewal: it.renewal_in_progress ? 'Yes' : '',
        verified: it.verified_at ? 'Yes' : 'No', docs: it.docCount || 0,
      });
    }
    ws.autoFilter = { from: 'A1', to: 'P1' };
    const note = wb.addWorksheet('About');
    note.addRow([`Exported ${t} from the Lake Cement MIS Compliance Master. Status is computed from the dates on the day of export.`]);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="compliance-register-${t}.xlsx"`);
    res.setHeader('Cache-Control', 'private, no-store');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

router.get('/groups', async (req, res, next) => {
  try {
    const { items } = await scopedItems(req);
    const byGroup = new Map();
    for (const it of items) {
      if (!it.group_id) continue;
      if (!byGroup.has(it.group_id)) byGroup.set(it.group_id, []);
      byGroup.get(it.group_id).push(it);
    }
    if (!byGroup.size) return res.json({ groups: [] });
    const { rows } = await db.query('SELECT id, kind, code, title, owner_role, entity, attrs FROM compliance_groups WHERE id = ANY($1) ORDER BY kind, code', [[...byGroup.keys()]]);
    res.json({ groups: rows.map(g => Object.assign(g, { items: byGroup.get(g.id).sort(SORTS.deadline).map(D.present) })) });
  } catch (err) { next(err); }
});

/* ── Item body ──────────────────────────────────────────────────────── */
const nullableDate = zDate.nullable().optional();
const nullableStr = (n) => z.string().trim().max(n).nullable().optional().transform(v => (v === '' ? null : v));
const itemFields = {
  kind: z.enum(['validity', 'recurring', 'condition']).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  description: nullableStr(4000), agency: nullableStr(200), reference_no: nullableStr(100),
  custodian: nullableStr(30), frequency_label: nullableStr(120), section_label: nullableStr(60),
  criticality: z.enum(['high', 'normal', 'low']).optional(),
  entity: z.enum(['LCL', 'BRL', 'UCL']).optional(),
  valid_from: nullableDate, valid_to: nullableDate, no_expiry: z.boolean().optional(),
  rec_unit: z.enum(['month', 'quarter', 'half', 'year', 'years', 'on_demand']).nullable().optional(),
  rec_interval: z.coerce.number().int().min(1).max(20).optional(),
  rec_due_day: z.coerce.number().int().min(1).max(31).nullable().optional(),
  rec_due_month: z.coerce.number().int().min(1).max(12).nullable().optional(),
  rec_anchor_date: nullableDate, track_from: nullableDate,
  review_interval_months: z.coerce.number().int().min(1).max(120).nullable().optional(),
  next_review_on: nullableDate,
  lead_days_1: z.coerce.number().int().min(0).max(365).nullable().optional(),
  lead_days_2: z.coerce.number().int().min(0).max(365).nullable().optional(),
  lead_days_3: z.coerce.number().int().min(0).max(365).nullable().optional(),
  reminders_enabled: z.boolean().optional(),
  fee_amount: z.coerce.number().min(0).max(1e15).nullable().optional(),
  fee_currency: z.enum(['TZS', 'USD', 'EUR', 'KES', 'UGX']).nullable().optional(),
  remarks: nullableStr(4000),
};
const EDITABLE = Object.keys(itemFields);
const patchBody = z.object(Object.assign({}, itemFields, { expectedUpdatedAt: z.string().min(10) })).strict();
const createBody = z.object(Object.assign({}, itemFields, {
  kind: z.enum(['validity', 'recurring', 'condition']),
  title: z.string().trim().min(2).max(200),
  owner_role: z.string().optional(),
  direct: z.array(z.coerce.number().int().positive()).max(5).optional(),
  second: z.array(z.coerce.number().int().positive()).max(5).optional(),
})).strict();

function checkKindRules(v) {
  if (v.kind === 'recurring' && !v.rec_unit) return 'A recurring obligation needs a frequency (monthly, quarterly…).';
  if (v.no_expiry && v.valid_to) return 'An item with no expiry cannot also have a Valid To date.';
  if (v.valid_from && v.valid_to && v.valid_to < v.valid_from) return 'Valid To is before Valid From.';
  const l = [v.lead_days_1, v.lead_days_2, v.lead_days_3];
  if (l[0] != null && l[1] != null && l[1] > l[0]) return 'The supervisor reminder must not come before the responsible-person reminder.';
  if (l[1] != null && l[2] != null && l[2] > l[1]) return 'The Head reminder must not come before the supervisor reminder.';
  return null;
}

async function setResponsibles(client, itemId, direct, second) {
  await client.query('DELETE FROM compliance_item_responsibles WHERE item_id = $1', [itemId]);
  const ids = [...new Set([...(direct || []), ...(second || [])])];
  if (ids.length) {
    const { rows } = await client.query('SELECT id FROM compliance_contacts WHERE id = ANY($1)', [ids]);
    if (rows.length !== ids.length) { const e = new Error('One of the chosen people does not exist.'); e.status = 400; throw e; }
  }
  for (const [tier, list] of [[1, direct || []], [2, second || []]]) {
    for (let i = 0; i < list.length; i++) {
      await client.query('INSERT INTO compliance_item_responsibles (item_id, tier, contact_id, position) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [itemId, tier, list[i], i]);
    }
  }
}

async function respondItem(res, req, id, status = 200) {
  const it = await loadOne(req, res, id);
  if (it) res.status(status).json({ item: D.present(it), can: req.can });
}

router.post('/items', validate(createBody), async (req, res, next) => {
  try {
    const caps = A.capabilities(req.user);
    if (!caps.canCreate) return res.status(403).json({ error: 'Only a senior officer or HOD of a department (or an administrator) can add obligations.' });
    const b = req.validated.body;
    const owner = req.user.role === 'admin' ? b.owner_role : req.user.role;
    if (!OWNER_ROLES.includes(owner)) return res.status(400).json({ error: 'Choose the department that owns this obligation.' });
    const rule = checkKindRules(b);
    if (rule) return res.status(400).json({ error: rule });
    if (b.kind === 'recurring' && !b.track_from) b.track_from = today();
    const cols = EDITABLE.filter(k => b[k] !== undefined && k !== 'kind' && k !== 'title');
    const canVerify = A.complianceAccess(req.user, { owner_role: owner }).verify;
    const id = await db.withTransaction(async (client) => {
      const names = ['kind', 'title', 'owner_role', ...cols, 'source', 'created_by', 'created_by_name', 'updated_by', 'updated_by_name', 'user_edited_at', 'verified_at', 'verified_by', 'verified_by_name'];
      const vals = [b.kind, b.title, owner, ...cols.map(k => b[k]), 'manual', req.user.id, actorName(req), req.user.id, actorName(req),
        new Date(), canVerify ? new Date() : null, canVerify ? req.user.id : null, canVerify ? actorName(req) : null];
      const { rows: [r] } = await client.query(
        `INSERT INTO compliance_items (${names.join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, vals);
      await setResponsibles(client, r.id, b.direct, b.second);
      await history(client, req, r.id, 'created', null, canVerify ? 'Created and verified by the owning department' : null);
      await audit(client, req, 'COMPLIANCE_CREATE', `#${r.id} ${b.title}`);
      return r.id;
    });
    await rollPeriods([id]);
    await respondItem(res, req, id, 201);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (dbInputError(err, res)) return;
    next(err);
  }
});

/* Roll recurring periods forward for these items right away, so a save is
   reflected in the next deadline without waiting for the daily job. */
async function rollPeriods(ids) {
  const settings = await D.loadSettings(db);
  const items = await D.loadItems(db, { ids, includeArchived: true });
  await db.withTransaction(async (client) => {
    await D.ensurePeriods(client, items, today(), settings);
    D.decorate(items, today(), settings);
    await D.refreshNextDue(client, items);
  });
}

/* Static item paths — before /items/:id. */
const batchIds = z.object({ ids: z.array(z.coerce.number().int().positive()).min(1).max(200) });
router.post('/items/batch-verify', validate(batchIds), async (req, res, next) => {
  try {
    const ids = [...new Set(req.validated.body.ids)];
    const items = await D.loadItems(db, { ids });
    if (items.length !== ids.length) return res.status(404).json({ error: 'One or more records were not found.' });
    const blocked = items.filter(it => !A.complianceAccess(req.user, it).verify);
    if (blocked.length) return res.status(403).json({ error: `You cannot verify ${blocked.length} of these records (only a senior officer or HOD of the owning department can).` });
    await db.withTransaction(async (client) => {
      for (const it of items) {
        await client.query('UPDATE compliance_items SET verified_at = NOW(), verified_by = $2, verified_by_name = $3 WHERE id = $1', [it.id, req.user.id, actorName(req)]);
        await history(client, req, it.id, 'verified', null, 'Batch verify');
      }
      await audit(client, req, 'COMPLIANCE_VERIFY', `batch ${ids.length}: ${ids.join(',')}`);
    });
    res.json({ ok: true, verified: ids.length });
  } catch (err) { next(err); }
});

router.post('/items/batch-renew', withUpload(docUpload.single('file'), true), async (req, res, next) => {
  try {
    let ids;
    try { ids = JSON.parse(req.body.ids || '[]'); } catch { ids = null; }
    const v = z.object({
      ids: z.array(z.coerce.number().int().positive()).min(1).max(50),
      valid_from: zDate.optional(), valid_to: zDate,
      reference_no: z.string().trim().max(100).optional(), note: z.string().trim().max(2000).optional(),
    }).safeParse({ ids, valid_from: req.body.valid_from || undefined, valid_to: req.body.valid_to, reference_no: req.body.reference_no || undefined, note: req.body.note || undefined });
    if (!v.success) return res.status(400).json({ error: 'Choose the records and give the new Valid To date (YYYY-MM-DD).' });
    const b = v.data;
    if (b.valid_from && b.valid_from > b.valid_to) return res.status(400).json({ error: 'Valid To is before Valid From.' });
    const uniq = [...new Set(b.ids)];
    const items = await D.loadItems(db, { ids: uniq });
    if (items.length !== uniq.length) return res.status(404).json({ error: 'One or more records were not found.' });
    if (items.some(it => !A.complianceAccess(req.user, it).act)) return res.status(403).json({ error: 'You can only renew your own department\'s records.' });
    if (items.some(it => it.kind !== 'validity')) return res.status(400).json({ error: 'Batch renewal is for licences and certificates (records with a validity period).' });
    const result = await db.withTransaction(async (client) => {
      const docs = [];
      for (const it of items) {
        if (req.file) docs.push(await storeDocument(client, req, it, req.file, { doc_type: 'certificate', valid_from: b.valid_from, valid_to: b.valid_to, reference_no: b.reference_no, note: b.note }));
        await client.query(
          `UPDATE compliance_items SET valid_from = COALESCE($2, valid_from), valid_to = $3, no_expiry = false,
                  reference_no = COALESCE($4, reference_no), renewal_in_progress = false, renewal_note = NULL, renewal_started_on = NULL,
                  user_edited_at = NOW(), updated_at = NOW(), updated_by = $5, updated_by_name = $6 WHERE id = $1`,
          [it.id, b.valid_from || null, b.valid_to, b.reference_no || null, req.user.id, actorName(req)]);
        await history(client, req, it.id, 'renewed', { valid_from: [it.valid_from, b.valid_from || it.valid_from], valid_to: [it.valid_to, b.valid_to] }, `Batch renewal of ${uniq.length} records${req.file ? ` — ${req.file.originalname}` : ''}`);
      }
      await audit(client, req, 'COMPLIANCE_BATCH_RENEW', `${uniq.length} records to ${b.valid_to}: ${uniq.join(',')}`);
      return docs;
    });
    res.json({ ok: true, renewed: uniq.length, documents: result.length });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/* ═══ One record ════════════════════════════════════════════════════════ */
router.get('/items/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    const [periods, assessments] = await Promise.all([
      db.query(`SELECT p.*, (SELECT json_agg(json_build_object('id', d.id, 'file_name', d.file_name, 'version_no', d.version_no) ORDER BY d.id)
                  FROM compliance_documents d WHERE d.period_id = p.id AND d.retracted_at IS NULL) AS documents
                  FROM compliance_periods p WHERE p.item_id = $1 ORDER BY p.due_on DESC LIMIT 36`, [it.id]),
      db.query(`SELECT * FROM compliance_assessments WHERE item_id = $1 ORDER BY COALESCE(assessed_on, created_at::date) DESC, id DESC LIMIT 50`, [it.id]),
    ]);
    const item = D.present(it);
    item.source_raw = it.source_raw || null;
    item.source_sheet = it.source_sheet; item.source_row = it.source_row;
    res.json({ item, can: req.can, periods: periods.rows, assessments: assessments.rows });
  } catch (err) { next(err); }
});

router.patch('/items/:id', validate(idParam, 'params'), validate(patchBody), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.edit) return deny(res, 'edit');
    const b = req.validated.body;
    const merged = Object.assign({}, it, b);
    const rule = checkKindRules(merged);
    if (rule) return res.status(400).json({ error: rule });
    const changes = {};
    const sets = [];
    const vals = [it.id, b.expectedUpdatedAt];
    for (const k of EDITABLE) {
      if (b[k] === undefined) continue;
      const before = it[k] instanceof Date ? it[k].toISOString() : it[k];
      if (String(before ?? '') === String(b[k] ?? '')) continue;
      changes[k] = [before ?? null, b[k] ?? null];
      vals.push(b[k]);
      sets.push(`${k} = $${vals.length}`);
    }
    if (merged.kind === 'recurring' && !merged.track_from && b.track_from === undefined) { vals.push(today()); sets.push(`track_from = $${vals.length}`); }
    if (!sets.length) return respondItem(res, req, it.id);
    vals.push(req.user.id, actorName(req));
    const ok = await db.withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE compliance_items SET ${sets.join(', ')}, user_edited_at = NOW(), updated_at = NOW(),
                updated_by = $${vals.length - 1}, updated_by_name = $${vals.length}
          WHERE id = $1 AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $2::timestamptz) RETURNING id`, vals);
      if (!r.rows.length) return false;
      await history(client, req, it.id, 'edited', changes);
      await audit(client, req, 'COMPLIANCE_EDIT', `#${it.id} ${Object.keys(changes).join(', ')}`);
      return true;
    });
    if (!ok) return res.status(409).json({ error: 'Someone else changed this record while you were editing. Reload it and apply your change again.' });
    await rollPeriods([it.id]);
    await respondItem(res, req, it.id);
  } catch (err) {
    if (dbInputError(err, res)) return;
    next(err);
  }
});

router.post('/items/:id/verify', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.verify) return res.status(403).json({ error: 'Only a senior officer or HOD of the owning department can verify a record (an administrator cannot attest a department\'s facts).' });
    await db.withTransaction(async (client) => {
      await client.query('UPDATE compliance_items SET verified_at = NOW(), verified_by = $2, verified_by_name = $3 WHERE id = $1', [it.id, req.user.id, actorName(req)]);
      await history(client, req, it.id, 'verified');
      await audit(client, req, 'COMPLIANCE_VERIFY', `#${it.id}`);
    });
    await respondItem(res, req, it.id);
  } catch (err) { next(err); }
});

const lifecycleBody = z.object({ lifecycle: z.enum(['active', 'inactive', 'archived']), reason: z.string().trim().max(500).optional() });
router.post('/items/:id/lifecycle', validate(idParam, 'params'), validate(lifecycleBody), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.archive) return res.status(403).json({ error: 'Only the HOD of the owning department (or an administrator) can deactivate, archive or restore a record.' });
    const { lifecycle, reason } = req.validated.body;
    if (lifecycle !== 'active' && (!reason || reason.length < 5)) return res.status(400).json({ error: 'Say why (at least 5 characters) — it is shown on the record.' });
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE compliance_items SET lifecycle = $2, inactive_reason = $3, user_edited_at = NOW(), updated_at = NOW(), updated_by = $4, updated_by_name = $5 WHERE id = $1`,
        [it.id, lifecycle, lifecycle === 'active' ? null : reason, req.user.id, actorName(req)]);
      await history(client, req, it.id, lifecycle === 'active' ? 'reactivated' : lifecycle, { lifecycle: [it.lifecycle, lifecycle] }, reason);
      await audit(client, req, 'COMPLIANCE_LIFECYCLE', `#${it.id} ${it.lifecycle}->${lifecycle}: ${reason || ''}`);
    });
    await respondItem(res, req, it.id);
  } catch (err) { next(err); }
});

router.post('/items/:id/transfer', validate(idParam, 'params'), validate(z.object({ owner_role: z.string(), reason: z.string().trim().min(5).max(500) })), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.transfer) return res.status(403).json({ error: 'Only the HOD of the owning department (or an administrator) can move a record to another department.' });
    const { owner_role, reason } = req.validated.body;
    if (!OWNER_ROLES.includes(owner_role) || owner_role === it.owner_role) return res.status(400).json({ error: 'Choose a different department.' });
    await db.withTransaction(async (client) => {
      // The receiving department has not confirmed the record yet.
      await client.query(`UPDATE compliance_items SET owner_role = $2, verified_at = NULL, verified_by = NULL, verified_by_name = NULL,
                          user_edited_at = NOW(), updated_at = NOW(), updated_by = $3, updated_by_name = $4 WHERE id = $1`,
        [it.id, owner_role, req.user.id, actorName(req)]);
      await history(client, req, it.id, 'transferred', { owner_role: [it.owner_role, owner_role] }, reason);
      await audit(client, req, 'COMPLIANCE_TRANSFER', `#${it.id} ${it.owner_role}->${owner_role}: ${reason}`);
    });
    res.json({ ok: true, owner_role, department: roleLabel(owner_role) });
  } catch (err) { next(err); }
});

router.post('/items/:id/renewal', validate(idParam, 'params'), validate(z.object({ in_progress: z.boolean(), note: z.string().trim().max(500).optional() })), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.act) return deny(res, 'record a renewal');
    const { in_progress, note } = req.validated.body;
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE compliance_items SET renewal_in_progress = $2, renewal_note = $3, renewal_started_on = $4,
                          updated_at = NOW(), updated_by = $5, updated_by_name = $6 WHERE id = $1`,
        [it.id, in_progress, in_progress ? (note || null) : null, in_progress ? (it.renewal_started_on || today()) : null, req.user.id, actorName(req)]);
      await history(client, req, it.id, in_progress ? 'renewal_started' : 'renewal_cleared', null, note);
      await audit(client, req, 'COMPLIANCE_RENEWAL', `#${it.id} ${in_progress ? 'in progress' : 'cleared'} ${note || ''}`);
    });
    await respondItem(res, req, it.id);
  } catch (err) { next(err); }
});

router.put('/items/:id/responsibles', validate(idParam, 'params'),
  validate(z.object({ direct: z.array(z.coerce.number().int().positive()).max(5), second: z.array(z.coerce.number().int().positive()).max(5) })),
  async (req, res, next) => {
    try {
      const it = await loadOne(req, res, req.validated.params.id);
      if (!it) return;
      if (!req.can.edit) return deny(res, 'change the responsible people');
      const { direct, second } = req.validated.body;
      await db.withTransaction(async (client) => {
        await setResponsibles(client, it.id, direct, second);
        await client.query('UPDATE compliance_items SET user_edited_at = NOW(), updated_at = NOW(), updated_by = $2, updated_by_name = $3 WHERE id = $1', [it.id, req.user.id, actorName(req)]);
        await history(client, req, it.id, 'responsibles', { direct: [it.direct.map(p => p.name), direct], second: [it.second.map(p => p.name), second] });
      });
      await respondItem(res, req, it.id);
    } catch (err) {
      if (err.status === 400) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

/* ── Periods (recurring filings / payments) ──────────────────────────── */
const pidParams = z.object({ id: z.coerce.number().int().positive(), pid: z.coerce.number().int().positive() });
async function loadPeriod(req, res) {
  const { id, pid } = req.validated.params;
  const it = await loadOne(req, res, id);
  if (!it) return {};
  const { rows } = await db.query('SELECT * FROM compliance_periods WHERE id = $1 AND item_id = $2', [pid, id]);
  if (!rows.length) { res.status(404).json({ error: 'That period was not found on this record.' }); return {}; }
  return { it, period: rows[0] };
}

router.post('/items/:id/periods', validate(idParam, 'params'), validate(z.object({ due_on: zDate, note: z.string().trim().max(500).optional() })), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.act) return deny(res, 'add an instance');
    if (it.kind !== 'recurring') return res.status(400).json({ error: 'Only recurring obligations have instances.' });
    const { due_on, note } = req.validated.body;
    await db.withTransaction(async (client) => {
      const { rows: [{ n }] } = await client.query(`SELECT COUNT(*)::int + 1 AS n FROM compliance_periods WHERE item_id = $1 AND period_key LIKE 'adhoc-%'`, [it.id]);
      await client.query(`INSERT INTO compliance_periods (item_id, period_key, due_on, note, source) VALUES ($1,$2,$3,$4,'manual')`, [it.id, `adhoc-${n}`, due_on, note || null]);
      await history(client, req, it.id, 'instance_added', null, `Due ${due_on}${note ? ' — ' + note : ''}`);
    });
    await respondItem(res, req, it.id, 201);
  } catch (err) { next(err); }
});

router.post('/items/:id/periods/:pid/done', validate(pidParams, 'params'), withUpload(docUpload.single('file'), true), async (req, res, next) => {
  try {
    const { it, period } = await loadPeriod(req, res);
    if (!it) return;
    if (!req.can.act) return deny(res, 'record a filing');
    const v = z.object({
      done_on: zDate, reference: z.string().trim().max(100).optional(),
      amount: z.coerce.number().min(0).max(1e15).optional(), currency: z.enum(['TZS', 'USD', 'EUR', 'KES', 'UGX']).optional(),
      note: z.string().trim().max(2000).optional(),
    }).safeParse(Object.fromEntries(Object.entries(req.body || {}).filter(([, x]) => x !== '' && x != null)));
    if (!v.success) return res.status(400).json({ error: 'Give the date it was filed / paid (YYYY-MM-DD).' });
    if (v.data.done_on > today()) return res.status(400).json({ error: 'The filing date cannot be in the future.' });
    await db.withTransaction(async (client) => {
      let doc = null;
      if (req.file) doc = await storeDocument(client, req, it, req.file, { doc_type: 'receipt', period_id: period.id, note: v.data.note, reference_no: v.data.reference });
      await client.query(`UPDATE compliance_periods SET status = 'done', done_on = $2, done_by = $3, done_by_name = $4, reference = $5,
                          amount = $6, currency = $7, note = COALESCE($8, note), updated_at = NOW() WHERE id = $1`,
        [period.id, v.data.done_on, req.user.id, actorName(req), v.data.reference || null, v.data.amount ?? null, v.data.currency || null, v.data.note || null]);
      await history(client, req, it.id, 'filed', { period: period.period_key, done_on: v.data.done_on }, doc ? `Evidence: ${doc.file_name}` : null);
      await audit(client, req, 'COMPLIANCE_FILED', `#${it.id} ${period.period_key} on ${v.data.done_on}`);
    });
    await rollPeriods([it.id]);
    await respondItem(res, req, it.id);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/items/:id/periods/:pid/reopen', validate(pidParams, 'params'), async (req, res, next) => {
  try {
    const { it, period } = await loadPeriod(req, res);
    if (!it) return;
    if (!req.can.edit) return deny(res, 'reopen an instance');
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE compliance_periods SET status = 'open', done_on = NULL, done_by = NULL, done_by_name = NULL, waived_reason = NULL, updated_at = NOW() WHERE id = $1`, [period.id]);
      await history(client, req, it.id, 'instance_reopened', { period: period.period_key });
    });
    await respondItem(res, req, it.id);
  } catch (err) { next(err); }
});

router.post('/items/:id/periods/:pid/waive', validate(pidParams, 'params'), validate(z.object({ reason: z.string().trim().min(5).max(500) })), async (req, res, next) => {
  try {
    const { it, period } = await loadPeriod(req, res);
    if (!it) return;
    if (!req.can.edit) return deny(res, 'waive an instance');
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE compliance_periods SET status = 'waived', waived_reason = $2, updated_at = NOW() WHERE id = $1`, [period.id, req.validated.body.reason]);
      await history(client, req, it.id, 'instance_waived', { period: period.period_key }, req.validated.body.reason);
      await audit(client, req, 'COMPLIANCE_WAIVE', `#${it.id} ${period.period_key}: ${req.validated.body.reason}`);
    });
    await rollPeriods([it.id]);
    await respondItem(res, req, it.id);
  } catch (err) { next(err); }
});

/* ── Assessments (standing conditions) ───────────────────────────────── */
router.post('/items/:id/assessments', validate(idParam, 'params'), withUpload(docUpload.single('file'), true), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.act) return deny(res, 'record a review');
    if (it.kind !== 'condition') return res.status(400).json({ error: 'Reviews are recorded on standing conditions.' });
    const v = z.object({
      result: z.enum(['complied', 'partial', 'not_complied', 'not_applicable']), assessed_on: zDate,
      note: z.string().trim().max(2000).optional(), next_review_on: zDate.optional(),
    }).safeParse(Object.fromEntries(Object.entries(req.body || {}).filter(([, x]) => x !== '' && x != null)));
    if (!v.success) return res.status(400).json({ error: 'Give the result and the date of the review.' });
    const b = v.data;
    if (b.assessed_on > today()) return res.status(400).json({ error: 'The review date cannot be in the future.' });
    const next = b.next_review_on || S.addMonths(b.assessed_on, it.review_interval_months || 3);
    await db.withTransaction(async (client) => {
      const { rows: [a] } = await client.query(
        `INSERT INTO compliance_assessments (item_id, assessed_on, result, note, source, assessed_by, assessed_by_name)
         VALUES ($1,$2,$3,$4,'manual',$5,$6) RETURNING id`, [it.id, b.assessed_on, b.result, b.note || null, req.user.id, actorName(req)]);
      if (req.file) await storeDocument(client, req, it, req.file, { doc_type: 'evidence', assessment_id: a.id, note: b.note });
      await client.query(`UPDATE compliance_items SET condition_result = $2, condition_assessed_on = $3, next_review_on = $4,
                          updated_at = NOW(), updated_by = $5, updated_by_name = $6 WHERE id = $1`,
        [it.id, b.result, b.assessed_on, next, req.user.id, actorName(req)]);
      await history(client, req, it.id, 'reviewed', { result: [it.condition_result, b.result], next_review_on: [it.next_review_on, next] }, b.note);
      await audit(client, req, 'COMPLIANCE_REVIEW', `#${it.id} ${b.result} on ${b.assessed_on}`);
    });
    await respondItem(res, req, it.id);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/* ── Documents & versions ────────────────────────────────────────────── */
router.get('/items/:id/documents', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    const { rows } = await db.query(
      `SELECT d.id, d.version_no, d.doc_type, d.file_name, d.mime_type, d.size_bytes, d.valid_from, d.valid_to, d.reference_no, d.note,
              d.uploaded_by, d.uploaded_by_name, d.uploaded_at, d.retracted_at, d.retracted_by_name, d.retracted_reason,
              p.period_key
         FROM compliance_documents d LEFT JOIN compliance_periods p ON p.id = d.period_id
        WHERE d.item_id = $1 ORDER BY d.version_no DESC`, [it.id]);
    res.json({ documents: rows.map(r => Object.assign(r, { canRetract: !r.retracted_at && (req.can.retractAny || (r.uploaded_by === req.user.id && Date.now() - new Date(r.uploaded_at) < 864e5)) })) });
  } catch (err) { next(err); }
});

router.post('/items/:id/documents', validate(idParam, 'params'), withUpload(docUpload.single('file'), false), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    if (!req.can.act) return deny(res, 'upload a document');
    const v = z.object({
      doc_type: z.enum(['certificate', 'receipt', 'application', 'evidence', 'other']).default('certificate'),
      valid_from: zDate.optional(), valid_to: zDate.optional(), no_expiry: z.enum(['true', 'false']).optional(),
      reference_no: z.string().trim().max(100).optional(), note: z.string().trim().max(2000).optional(),
      apply: z.enum(['true', 'false']).optional(),
    }).safeParse(Object.fromEntries(Object.entries(req.body || {}).filter(([, x]) => x !== '' && x != null)));
    if (!v.success) return res.status(400).json({ error: 'Check the document details — dates must be YYYY-MM-DD.' });
    const b = v.data;
    // A renewed certificate on a licence carries its new dates, and they
    // become the record's dates: uploading the certificate IS the renewal.
    const renews = it.kind === 'validity' && b.doc_type === 'certificate' && b.apply !== 'false';
    if (renews && !b.valid_to && b.no_expiry !== 'true') return res.status(400).json({ error: 'Give the new certificate\'s Valid To date (or tick "no expiry") — it becomes the record\'s expiry date.' });
    if (b.valid_from && b.valid_to && b.valid_from > b.valid_to) return res.status(400).json({ error: 'Valid To is before Valid From.' });
    const doc = await db.withTransaction(async (client) => {
      const d = await storeDocument(client, req, it, req.file, b);
      if (renews) {
        await client.query(
          `UPDATE compliance_items SET valid_from = COALESCE($2, valid_from), valid_to = $3, no_expiry = $4,
                  reference_no = COALESCE($5, reference_no), renewal_in_progress = false, renewal_note = NULL, renewal_started_on = NULL,
                  user_edited_at = NOW(), updated_at = NOW(), updated_by = $6, updated_by_name = $7 WHERE id = $1`,
          [it.id, b.valid_from || null, b.no_expiry === 'true' ? null : b.valid_to, b.no_expiry === 'true', b.reference_no || null, req.user.id, actorName(req)]);
        await history(client, req, it.id, 'renewed', { valid_to: [it.valid_to, b.no_expiry === 'true' ? null : b.valid_to] }, `Version ${d.version_no}: ${d.file_name}`);
      } else {
        await history(client, req, it.id, 'document_added', null, `Version ${d.version_no}: ${d.file_name} (${d.doc_type})`);
      }
      await audit(client, req, 'COMPLIANCE_DOCUMENT', `#${it.id} v${d.version_no} ${d.file_name}${renews ? ' (renewal)' : ''}`);
      return d;
    });
    const fresh = await loadOne(req, res, it.id);
    if (fresh) res.status(201).json({ document: doc, item: D.present(fresh), can: req.can });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/documents/:id/download', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT d.id, d.item_id, d.file_name, d.mime_type, d.size_bytes, d.blob_sha256, d.version_no, i.owner_role
         FROM compliance_documents d JOIN compliance_items i ON i.id = d.item_id WHERE d.id = $1`, [req.validated.params.id]);
    const d = rows[0];
    if (!d || !A.complianceAccess(req.user, { owner_role: d.owner_role }).read) return res.status(404).json({ error: 'Document not found.' });
    const mime = DOC_TYPES.some(t => t.mime === d.mime_type) ? d.mime_type : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', d.size_bytes);
    res.setHeader('Content-Disposition', `attachment; filename="${d.file_name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(d.file_name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Streamed in 1 MiB slices so a 10 MB certificate is never held whole.
    const CHUNK = 1024 * 1024;
    for (let off = 1; off <= d.size_bytes; off += CHUNK) {
      const r = await db.query('SELECT substring(bytes FROM $2 FOR $3) AS c FROM compliance_blobs WHERE sha256 = $1', [d.blob_sha256, off, CHUNK]);
      if (!r.rows.length) break;
      if (!res.write(r.rows[0].c)) await new Promise(resolve => res.once('drain', resolve));
    }
    res.end();
    audit(db, req, 'COMPLIANCE_DOWNLOAD', `#${d.item_id} v${d.version_no} ${d.file_name}`).catch(() => {});
  } catch (err) { next(err); }
});

router.post('/documents/:id/retract', validate(idParam, 'params'), validate(z.object({ reason: z.string().trim().min(5).max(500) })), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*, i.owner_role FROM compliance_documents d JOIN compliance_items i ON i.id = d.item_id WHERE d.id = $1`, [req.validated.params.id]);
    const d = rows[0];
    const can = d ? A.complianceAccess(req.user, { owner_role: d.owner_role }) : null;
    if (!d || !can.read) return res.status(404).json({ error: 'Document not found.' });
    if (d.retracted_at) return res.status(409).json({ error: 'This version is already retracted.' });
    const own = d.uploaded_by === req.user.id && Date.now() - new Date(d.uploaded_at) < 864e5;
    if (!can.retractAny && !own) return res.status(403).json({ error: 'You can retract your own upload within 24 hours; after that a senior officer or HOD of the department can.' });
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE compliance_documents SET retracted_at = NOW(), retracted_by = $2, retracted_by_name = $3, retracted_reason = $4 WHERE id = $1`,
        [d.id, req.user.id, actorName(req), req.validated.body.reason]);
      await history(client, req, d.item_id, 'document_retracted', null, `Version ${d.version_no} (${d.file_name}): ${req.validated.body.reason}`);
      await audit(client, req, 'COMPLIANCE_RETRACT', `#${d.item_id} v${d.version_no}: ${req.validated.body.reason}`);
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.get('/items/:id/history', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    const { rows } = await db.query('SELECT id, at, actor_name, action, changes, note FROM compliance_history WHERE item_id = $1 ORDER BY at DESC, id DESC LIMIT 200', [it.id]);
    res.json({ history: rows });
  } catch (err) { next(err); }
});

router.get('/items/:id/reminders', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const it = await loadOne(req, res, req.validated.params.id);
    if (!it) return;
    const { rows } = await db.query(
      `SELECT id, deadline, stage, audience, recipient_name, recipient_email, status, attempts, last_error, sent_at, created_at, updated_at
         FROM compliance_notifications WHERE item_id = $1 ORDER BY created_at DESC, id DESC LIMIT 100`, [it.id]);
    const caps = A.capabilities(req.user);
    res.json({ reminders: caps.canContacts || caps.canViewAll ? rows : rows.map(r => Object.assign(r, { recipient_email: undefined })) });
  } catch (err) { next(err); }
});

/* ═══ Contacts ══════════════════════════════════════════════════════════ */
router.get('/contacts', async (req, res, next) => {
  try {
    const caps = A.capabilities(req.user);
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.email, c.user_id, c.active, c.aliases, u.full_name AS user_name, u.email AS user_email,
              (SELECT COUNT(*)::int FROM compliance_item_responsibles r WHERE r.contact_id = c.id) AS item_count,
              EXISTS (SELECT 1 FROM compliance_head_recipients h WHERE h.contact_id = c.id) AS is_head
         FROM compliance_contacts c LEFT JOIN users u ON u.id = c.user_id
        ORDER BY c.active DESC, c.name`);
    const showEmail = caps.canContacts || caps.canViewAll;
    res.json({ contacts: rows.map(r => ({
      id: r.id, name: r.name, active: r.active, item_count: r.item_count, is_head: r.is_head, aliases: r.aliases,
      user_id: r.user_id, user_name: r.user_name,
      email: showEmail ? (r.user_email || r.email || null) : undefined,
      has_email: !!(r.user_email || r.email),
    })) });
  } catch (err) { next(err); }
});

const contactBody = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email().max(120).nullable().optional(),
});
router.post('/contacts', validate(contactBody), async (req, res, next) => {
  try {
    if (!A.capabilities(req.user).canContacts) return res.status(403).json({ error: 'Only a senior officer, HOD or administrator can add people.' });
    const { name, email } = req.validated.body;
    const r = await db.query(`INSERT INTO compliance_contacts (name, email, updated_by, updated_by_name) VALUES ($1,$2,$3,$4)
                              ON CONFLICT DO NOTHING RETURNING id, name, email`, [name, email || null, req.user.id, actorName(req)]);
    if (!r.rows.length) return res.status(409).json({ error: 'A person with that name already exists.' });
    await audit(db, req, 'COMPLIANCE_CONTACT_ADD', `${name}${email ? ' <' + email + '>' : ''}`);
    res.status(201).json({ contact: r.rows[0] });
  } catch (err) { next(err); }
});

router.patch('/contacts/:id', validate(idParam, 'params'), validate(z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(120).nullable().optional(),
  user_id: z.coerce.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
}).strict()), async (req, res, next) => {
  try {
    const caps = A.capabilities(req.user);
    if (!caps.canContacts) return res.status(403).json({ error: 'Only a senior officer, HOD or administrator can edit people.' });
    const { rows } = await db.query('SELECT * FROM compliance_contacts WHERE id = $1', [req.validated.params.id]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'Person not found.' });
    const b = req.validated.body;
    // Filling in a missing address is everyday work; changing an existing
    // one, or linking a login, redirects someone's reminders — admin only.
    const changesEmail = b.email !== undefined && (b.email || null) !== (c.email || null);
    if ((changesEmail && c.email) || b.user_id !== undefined || b.name !== undefined || b.active !== undefined) {
      if (!caps.canEditEmails) return res.status(403).json({ error: 'Only an administrator can change an existing address, a name or a login link.' });
    }
    const sets = []; const vals = [c.id];
    for (const k of ['name', 'email', 'user_id', 'active']) if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${k} = $${vals.length}`); }
    if (!sets.length) return res.json({ contact: c });
    vals.push(req.user.id, actorName(req));
    const r = await db.query(`UPDATE compliance_contacts SET ${sets.join(', ')}, updated_at = NOW(), updated_by = $${vals.length - 1}, updated_by_name = $${vals.length}
                              WHERE id = $1 RETURNING id, name, email, user_id, active`, vals);
    await audit(db, req, 'COMPLIANCE_CONTACT_EDIT', `#${c.id} ${c.name}: ${Object.keys(b).join(', ')}`);
    res.json({ contact: r.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That name or login is already used by another person.' });
    next(err);
  }
});

/* ═══ Settings & reminders ══════════════════════════════════════════════ */
function requireSettings(req, res) {
  if (A.capabilities(req.user).canSettings) return true;
  res.status(403).json({ error: 'Only the MD or an administrator can change compliance reminder settings.' });
  return false;
}

router.get('/settings', async (req, res, next) => {
  try {
    const caps = A.capabilities(req.user);
    if (!caps.canSettings && !caps.canViewAll) return res.status(403).json({ error: 'Not available for your role.' });
    const [settings, heads, lastRun, updated] = await Promise.all([
      D.loadSettings(db),
      db.query(`SELECT h.contact_id, h.label, h.position, c.name, COALESCE(u.email, c.email) AS email
                  FROM compliance_head_recipients h JOIN compliance_contacts c ON c.id = h.contact_id LEFT JOIN users u ON u.id = c.user_id
                 ORDER BY h.position, c.name`),
      db.query(`SELECT id, started_at, finished_at, as_of, trigger, dry_run, ok, error, stats, duration_ms, heap_delta_kb
                  FROM compliance_reminder_runs ORDER BY started_at DESC LIMIT 10`),
      db.query(`SELECT key, updated_at, updated_by_name FROM compliance_settings`),
    ]);
    const t = makeTransport();
    res.json({
      settings, heads: heads.rows, runs: lastRun.rows, updated: updated.rows,
      mail: { configured: mailConfigured(), transport: t ? t.kind : null, appUrl: !!(process.env.APP_URL || '').trim(),
        cron: process.env.COMPLIANCE_REMINDER_CRON === 'off' ? 'off' : (process.env.COMPLIANCE_REMINDER_CRON || '0 7,14 * * *') },
      canEdit: caps.canSettings,
    });
  } catch (err) { next(err); }
});

const settingsBody = z.object({
  reminders_enabled: z.boolean().optional(),
  overdue_cadence_days: z.coerce.number().int().min(1).max(60).optional(),
  renewal_cadence_days: z.coerce.number().int().min(1).max(90).optional(),
  condition_review_months: z.coerce.number().int().min(1).max(36).optional(),
  first_review_grace_days: z.coerce.number().int().min(0).max(180).optional(),
  hod_fallback: z.boolean().optional(),
  default_leads: z.record(z.string(), z.array(z.coerce.number().int().min(0).max(365)).length(3)).optional(),
}).strict();
router.put('/settings', validate(settingsBody), async (req, res, next) => {
  try {
    if (!requireSettings(req, res)) return;
    const b = req.validated.body;
    if (b.default_leads) {
      for (const [k, v] of Object.entries(b.default_leads)) {
        if (!S.DEFAULT_LEADS[k]) return res.status(400).json({ error: `Unknown lead-day group "${k}".` });
        if (v[1] > v[0] || v[2] > v[1]) return res.status(400).json({ error: `Lead days for ${k} must not increase (responsible ≥ supervisor ≥ head).` });
      }
    }
    await db.withTransaction(async (client) => {
      for (const [k, v] of Object.entries(b)) {
        await client.query(`INSERT INTO compliance_settings (key, value, updated_at, updated_by, updated_by_name) VALUES ($1,$2,NOW(),$3,$4)
                            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = $3, updated_by_name = $4`,
          [k, JSON.stringify(v), req.user.id, actorName(req)]);
      }
      await audit(client, req, 'COMPLIANCE_SETTINGS', JSON.stringify(b));
    });
    res.json({ settings: await D.loadSettings(db) });
  } catch (err) { next(err); }
});

router.put('/settings/head-recipients', validate(z.object({
  heads: z.array(z.object({ contact_id: z.coerce.number().int().positive(), label: z.string().trim().min(2).max(60) })).max(10),
})), async (req, res, next) => {
  try {
    if (!requireSettings(req, res)) return;
    const { heads } = req.validated.body;
    await db.withTransaction(async (client) => {
      await client.query('DELETE FROM compliance_head_recipients');
      for (let i = 0; i < heads.length; i++) {
        await client.query('INSERT INTO compliance_head_recipients (contact_id, label, position) VALUES ($1,$2,$3) ON CONFLICT (contact_id) DO UPDATE SET label = EXCLUDED.label, position = EXCLUDED.position',
          [heads[i].contact_id, heads[i].label, i]);
      }
      await audit(client, req, 'COMPLIANCE_HEADS', heads.map(h => `${h.contact_id}:${h.label}`).join(', '));
    });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(400).json({ error: 'One of the chosen people does not exist.' });
    next(err);
  }
});

router.get('/reminders', validate(z.object({
  status: z.enum(['pending', 'sent', 'failed', 'gave_up', 'held_unverified', 'skipped_no_email', 'skipped_disabled', 'superseded']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
}), 'query'), async (req, res, next) => {
  try {
    const scope = A.scopeRole(req.user);
    const params = []; const where = [];
    if (scope) { params.push(scope); where.push(`i.owner_role = $${params.length}`); }
    if (req.validated.query.status) { params.push(req.validated.query.status); where.push(`n.status = $${params.length}`); }
    params.push(req.validated.query.limit);
    const { rows } = await db.query(
      `SELECT n.id, n.item_id, i.title, i.owner_role, n.deadline, n.stage, n.audience, n.recipient_name, n.recipient_email,
              n.status, n.attempts, n.last_error, n.sent_at, n.created_at, n.updated_at
         FROM compliance_notifications n JOIN compliance_items i ON i.id = n.item_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY n.updated_at DESC, n.id DESC LIMIT $${params.length}`, params);
    const { rows: counts } = await db.query(
      `SELECT n.status, COUNT(*)::int AS n FROM compliance_notifications n JOIN compliance_items i ON i.id = n.item_id
        ${scope ? 'WHERE i.owner_role = $1' : ''} GROUP BY n.status`, scope ? [scope] : []);
    const caps = A.capabilities(req.user);
    res.json({
      reminders: rows.map(r => Object.assign(r, { department: roleLabel(r.owner_role), recipient_email: (caps.canContacts || caps.canViewAll) ? r.recipient_email : undefined })),
      counts: Object.fromEntries(counts.map(c => [c.status, c.n])),
    });
  } catch (err) { next(err); }
});

router.get('/reminders/preview', validate(z.object({ date: zDate.optional() }), 'query'), async (req, res, next) => {
  try {
    if (!requireSettings(req, res)) return;
    const r = await require('../services/complianceReminders').runReminders({ dryRun: true, asOf: req.validated.query.date || null });
    res.json(r);
  } catch (err) { next(err); }
});

router.post('/reminders/run', validate(z.object({ dryRun: z.boolean().default(false) })), async (req, res, next) => {
  try {
    if (!A.capabilities(req.user).canRunReminders) return res.status(403).json({ error: 'Only an administrator can run the reminder job by hand.' });
    const r = await require('../services/complianceReminders').runReminders({ dryRun: req.validated.body.dryRun, trigger: 'manual' });
    await audit(db, req, 'COMPLIANCE_REMINDERS_RUN', JSON.stringify(r.stats || r));
    res.json(r);
  } catch (err) { next(err); }
});

router.post('/reminders/:id/retry', validate(idParam, 'params'), async (req, res, next) => {
  try {
    if (!A.capabilities(req.user).canRunReminders) return res.status(403).json({ error: 'Only an administrator can retry a reminder.' });
    const r = await db.query(`UPDATE compliance_notifications SET status = 'pending', next_attempt_at = NULL, updated_at = NOW()
                              WHERE id = $1 AND status IN ('failed','gave_up') RETURNING id`, [req.validated.params.id]);
    if (!r.rows.length) return res.status(409).json({ error: 'Only a failed reminder can be retried.' });
    res.json({ ok: true, note: 'Queued — it goes out on the next run (or press Run now).' });
  } catch (err) { next(err); }
});

/* ═══ Import ════════════════════════════════════════════════════════════
   Two calls, no server-side session: preview parses the workbook and shows
   exactly what commit would do; commit re-uploads the same file (checked by
   hash) with any department moves the admin chose in the preview. */
function loadOldCerts() {
  try { return require('../data/mis/compliance-certs.json'); } catch { return []; }
}
function parseOverrides(raw) {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    return Object.fromEntries(Object.entries(o).filter(([, v]) => OWNER_ROLES.includes(v)));
  } catch { return {}; }
}
function xlsxOnly(req, res, next) {
  xlsxUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The workbook is larger than 10 MB.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No workbook was attached.' });
    if (!/\.xlsx$/i.test(req.file.originalname || '')) return res.status(400).json({ error: 'Upload the .xlsx workbook.' });
    next();
  });
}
async function parseUpload(req, res) {
  try {
    const settings = await D.loadSettings(db);
    const parsed = await parseComplianceWorkbook(req.file.buffer, { certs: loadOldCerts(), settings, sectionRoleOverrides: parseOverrides(req.body.sectionRoleOverrides) });
    if (!parsed.ok) { res.status(400).json({ error: parsed.error, missing: parsed.missing }); return null; }
    return parsed;
  } catch {
    res.status(400).json({ error: 'This file could not be read as an Excel workbook — is it corrupted, or not really a .xlsx file?' });
    return null;
  }
}

router.post('/import/preview', xlsxOnly, async (req, res, next) => {
  try {
    if (!A.capabilities(req.user).canImport) return res.status(403).json({ error: 'Only an administrator can import the workbook.' });
    const parsed = await parseUpload(req, res);
    if (!parsed) return;
    const client = await db.connect();
    let planned;
    try { planned = await planImport(parsed, client); } finally { client.release(); }
    const actions = new Map(planned.plan.map(p => [p.key, p]));
    const settings = await D.loadSettings(db);
    const rows = parsed.items.map(it => {
      const open = (it.periods || []).filter(p => p.status === 'open');
      const keys = new Set((it.periods || []).map(p => p.period_key));
      const sim = it.kind === 'recurring' ? S.periodsToCreate(Object.assign({}, it, { track_from: parsed.today }), parsed.today, keys, settings) : [];
      const c = S.computeStatus(Object.assign({}, it, { verified_at: null }), { today: parsed.today, settings, openPeriods: open.concat(sim), hasDirect: !!(it.responsibles && it.responsibles[1] && it.responsibles[1].length) });
      const p = actions.get(it.import_key);
      return {
        key: it.import_key, sheet: it.source_sheet, row: it.source_row, title: it.title, section: it.section_label,
        owner_role: it.owner_role, department: it.owner_role ? roleLabel(it.owner_role) : null, kind: it.kind,
        action: p.action, actionReason: p.reason || null,
        sheetSaid: it.source_raw && (it.source_raw.status || it.source_raw.lead1 && /active/i.test(it.source_raw.lead1) && it.source_raw.lead1) || null,
        sheetTo: it.source_raw ? (it.source_raw.to || it.source_raw.due || null) : null,
        computed: c.status, reason: c.reason, deadline: c.deadline,
        people: { direct: (it.responsibles && it.responsibles[1]) || [], second: (it.responsibles && it.responsibles[2]) || [] },
        warnings: it.warnings,
      };
    });
    res.json({
      file: req.file.originalname, sha256: sha256(req.file.buffer), today: parsed.today,
      counts: planned.counts, missingFromFile: planned.missingFromFile, reconciliation: parsed.reconciliation,
      sections: Object.entries(parsed.sections).map(([label, v]) => ({ label, role: v.role, department: v.role ? roleLabel(v.role) : null, count: v.count, ambiguous: parsed.ambiguous[label] ? parsed.ambiguous[label].note : null })),
      departments: OWNER_ROLES.map(r => ({ role: r, label: roleLabel(r) })),
      enrichment: { matched: parsed.enrichment.matched, unmatched: parsed.enrichment.unmatched },
      structural: parsed.classes, rows,
      statusTotals: rows.reduce((a, r) => { a[r.computed] = (a[r.computed] || 0) + 1; return a; }, {}),
    });
  } catch (err) { next(err); }
});

router.post('/import/commit', xlsxOnly, async (req, res, next) => {
  try {
    if (!A.capabilities(req.user).canImport) return res.status(403).json({ error: 'Only an administrator can import the workbook.' });
    const hash = sha256(req.file.buffer);
    if (req.body.expectedSha256 && req.body.expectedSha256 !== hash) {
      return res.status(409).json({ error: 'This is not the file you previewed. Preview it again before importing.' });
    }
    const parsed = await parseUpload(req, res);
    if (!parsed) return;
    const unmapped = parsed.items.filter(i => !i.owner_role);
    if (unmapped.length) return res.status(400).json({ error: `${unmapped.length} rows have no department — choose one for each section in the preview.` });
    const result = await db.withTransaction(async (client) => {
      const r = await commitImport(parsed, client, actor(req), { fileName: req.file.originalname, sha256: hash });
      await audit(client, req, 'COMPLIANCE_IMPORT', `${req.file.originalname}: ${JSON.stringify(r.counts)}`);
      return r;
    });
    if (result.touched.length) await rollPeriods(result.touched);
    res.json({ ok: true, importId: result.importId, counts: result.counts, missingFromFile: result.missingFromFile.length });
  } catch (err) {
    if (dbInputError(err, res)) return;
    next(err);
  }
});

router.get('/imports', async (req, res, next) => {
  try {
    if (!A.capabilities(req.user).canImport && !A.canViewAll(req.user)) return res.status(403).json({ error: 'Not available for your role.' });
    const { rows } = await db.query('SELECT id, at, by_name, file_name, counts FROM compliance_imports ORDER BY at DESC LIMIT 20');
    res.json({ imports: rows });
  } catch (err) { next(err); }
});

/* ═══ KPI tie-in ════════════════════════════════════════════════════════
   The monthly "Compliance to Legal Requirements" KPI (mines, packing,
   power plant, stores) as a SUGGESTION beside the field — the HOD still
   enters the figure. % of the department's tracked obligations not overdue
   at month end; undated ones are left out and counted. NULL — never a
   made-up 0 or 100 — when the department has no tracked obligations or no
   figure exists for that month. */
router.get('/kpi-suggestion/:kpiDept/:year/:month', validate(z.object({
  kpiDept: z.enum(Object.keys(KPI_DEPT_ROLE)), year: z.coerce.number().int().min(2020).max(2100), month: z.coerce.number().int().min(1).max(12),
}), 'params'), async (req, res, next) => {
  try {
    const { kpiDept, year, month } = req.validated.params;
    const map = KPI_DEPT_ROLE[kpiDept];
    const t = today();
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const monthEnd = S.addDays(S.addMonths(monthStart, 1, 1), -1);
    let basis, counts = null;
    if (monthStart > t) return res.json({ kpiDept, key: map.key, value: null, basis: 'future month' });
    if (monthEnd >= t) {
      const settings = await D.loadSettings(db);
      const items = await D.loadItems(db, { scope: map.role });
      D.simulatePeriods(items, t, settings); D.decorate(items, t, settings);
      counts = items.reduce((a, i) => { a[i.computed.status] = (a[i.computed.status] || 0) + 1; return a; }, {});
      basis = `live, as of ${t}`;
    } else {
      const { rows } = await db.query(`SELECT * FROM compliance_snapshots WHERE owner_role = $1 AND as_of <= $2 AND as_of >= $3 ORDER BY as_of DESC LIMIT 1`, [map.role, monthEnd, monthStart]);
      if (rows.length) { counts = rows[0]; basis = `snapshot of ${rows[0].as_of}`; }
    }
    if (!counts) return res.json({ kpiDept, key: map.key, value: null, basis: 'no compliance snapshot for that month' });
    const ok = (+counts.active || 0) + (+counts.due || 0);
    const total = ok + (+counts.overdue || 0);
    res.json({ kpiDept, key: map.key, role: map.role, department: roleLabel(map.role), value: total ? Math.round(1000 * ok / total) / 10 : null,
      compliant: ok, total, undated: +counts.undated || 0, basis });
  } catch (err) { next(err); }
});

module.exports = router;
