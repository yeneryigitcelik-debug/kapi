// PM2 ile çalıştırma (örn. Hetzner):
//   pm2 start ecosystem.config.cjs   →   pm2 save   →   pm2 startup
// NOT: kapi.yaml çalışılan dizinde (cwd) bulunmalı. Anahtarları config'e düz metin
// yazma; sistemde 'export KAPI_KEY=...' ile ver (PM2 ortamı devralır).
module.exports = {
  apps: [
    {
      name: 'kapi',
      script: 'bin/kapi.js',
      args: 'up',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
