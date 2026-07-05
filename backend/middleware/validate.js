/*
  middleware/validate.js — zod request validation.

  validate(schema, source) parses req[source] ('body' | 'query' | 'params')
  and 400s with the consistent { error } shape on failure. Parsed data
  (coerced, defaulted, trimmed) is attached to req.validated[source] —
  routes must read from there whenever the schema transforms values,
  because Express 5 request properties like req.query are read-only.

  Also exports the shared field types so every route validates dates,
  shifts and numerics the same way. Routes import z from here (not from
  'zod' directly) so the whole app is guaranteed one zod instance.
*/

const { z } = require('zod');

const zDate  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date');
const zShift = z.enum(['day', 'night', 'all']);

/* Forgiving numeric: '' / null / undefined → null; numeric strings → number;
   anything non-numeric is rejected. Matches how form JS sends KPI values. */
const zNumeric = z.preprocess(v => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}, z.number().finite().nullable());

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue.path.length ? issue.path.join('.') : source;
      return res.status(400).json({ error: `Invalid ${where}: ${issue.message}` });
    }
    req.validated = req.validated || {};
    req.validated[source] = result.data;
    next();
  };
}

module.exports = { validate, z, zDate, zShift, zNumeric };
