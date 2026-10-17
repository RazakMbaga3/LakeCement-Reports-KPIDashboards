// pm2 process for the Integration Package's Sales Dashboard (the collaborator's
// Streamlit app, integration/sales-dashboard/app.py), served by nginx at
// /sales-app/ (deploy/nginx-sales-app.conf).
//
// Deliberately NOT in ecosystem.config.js: deploy.sh reloads that file on every
// CI deploy, and this app only exists once deploy/setup-sales-app.sh has built
// its Python environment. deploy.sh reloads this file only when pm2 already
// knows a process called `sales-app`.
//
// Start (setup-sales-app.sh does this):  pm2 start deploy/sales-app.ecosystem.config.js && pm2 save
// Restart by hand:                       pm2 restart sales-app
const path = require('path');
const dir = path.resolve(__dirname, '../integration/sales-dashboard');

module.exports = {
  apps: [
    {
      name: 'sales-app',
      cwd: dir,
      script: path.join(dir, '.venv/bin/python'),
      interpreter: 'none',
      args: [
        // run_sales_app.py = streamlit's CLI + a silent sign-in as
        // SALES_APP_AUTO_USER (nginx's gate is the login) — see that file.
        'run_sales_app.py', 'run', 'app.py',
        '--server.address', '127.0.0.1',   // only nginx reaches it
        '--server.port', '8501',
        '--server.baseUrlPath', 'sales-app',
        '--server.headless', 'true',
        '--server.fileWatcherType', 'none',
        '--browser.gatherUsageStats', 'false',
      ],
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      // pandas + the year-to-date register: ~250-400 MB in normal use. app.py
      // keeps one extra "last good" copy of the register per day and never
      // drops old ones, so memory creeps up; the cap and the nightly restart
      // keep that bounded. A restart signs Streamlit users out (its login lives
      // in the session), hence 03:00.
      max_memory_restart: '600M',
      cron_restart: '0 3 * * *',
      env: { PYTHONUNBUFFERED: '1' },
    },
  ],
};
