/*
  services/metrics.js — Prometheus metrics (prom-client) at /api/metrics.

  Node/process defaults + request rate/latency/status per route,
  daily-form submission counts, and live pg pool gauges.
*/

const client = require('prom-client');
const pool   = require('../db');

const register = new client.Registry();
register.setDefaultLabels({ app: 'lcl-mis' });
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 1, 3, 10],
  registers: [register],
});

const httpTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'HTTP requests by route and status',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const formSubmissions = new client.Counter({
  name: 'form_submissions_total',
  help: 'Daily-report submissions by form type',
  labelNames: ['form_type'],
  registers: [register],
});

/* pg pool visibility — sampled at scrape time */
new client.Gauge({ name: 'pg_pool_total_clients', help: 'pg pool: total clients',
  registers: [register], collect() { this.set(pool.totalCount || 0); } });
new client.Gauge({ name: 'pg_pool_idle_clients', help: 'pg pool: idle clients',
  registers: [register], collect() { this.set(pool.idleCount || 0); } });
new client.Gauge({ name: 'pg_pool_waiting_requests', help: 'pg pool: queued connection requests',
  registers: [register], collect() { this.set(pool.waitingCount || 0); } });

/* Route template (e.g. /api/reports/:formType/:date), not the raw URL —
   keeps label cardinality bounded. */
function routeLabel(req) {
  if (req.route) return (req.baseUrl || '') + req.route.path;
  return req.path.startsWith('/api') ? 'unmatched' : 'static';
}

function middleware(req, res, next) {
  const end = httpDuration.startTimer({ method: req.method });
  res.on('finish', () => {
    const labels = { method: req.method, route: routeLabel(req), status: res.statusCode };
    end(labels);
    httpTotal.inc(labels);
  });
  next();
}

module.exports = { register, middleware, formSubmissions };
