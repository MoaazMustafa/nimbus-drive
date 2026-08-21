/**
 * PM2 process file — keeps both servers running, restarts them if they crash,
 * and (with `pm2 save` + startup config, see SETUP.md §6) brings them back
 * after a reboot. Works on Windows, macOS and Linux.
 *
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 save
 */
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'nimbus-api',
      cwd: path.join(__dirname, 'server'),
      script: 'src/index.js',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      out_file: path.join(__dirname, 'data', 'logs', 'api.log'),
      error_file: path.join(__dirname, 'data', 'logs', 'api.err.log'),
      time: true,
    },
    {
      name: 'nimbus-web',
      cwd: path.join(__dirname, 'web'),
      script: path.join(__dirname, 'web', 'node_modules', 'next', 'dist', 'bin', 'next'),
      args: 'start',
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 2000,
      out_file: path.join(__dirname, 'data', 'logs', 'web.log'),
      error_file: path.join(__dirname, 'data', 'logs', 'web.err.log'),
      time: true,
    },
  ],
};
