module.exports = {
  apps: [
    {
      name: 'shopprint-control-plane',
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/server.ts',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      kill_timeout: 5000
    }
  ]
};
