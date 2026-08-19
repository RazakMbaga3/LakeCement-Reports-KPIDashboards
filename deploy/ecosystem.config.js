// pm2 process definition for production (Linux). Start with:
//   pm2 start deploy/ecosystem.config.js
// See docs/DEPLOYMENT_DIGITALOCEAN.md §2.6.
module.exports = {
  apps: [
    {
      name: 'lake-cement-mis',
      cwd: __dirname + '/../backend',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      max_memory_restart: '300M',
      autorestart: true,
    },
  ],
};
