module.exports = {
  apps: [
    {
      name: "legacy-x-api",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "350M",
      kill_timeout: 10000,
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
