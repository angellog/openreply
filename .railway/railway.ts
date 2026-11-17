import { defineRailway, github, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Redis = redis("Redis", { region: "sfo" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  Redis.networking = { privateNetworkEndpoint: "redis", tcpProxies: { "6379": {} } };
  const Postgres = postgres("Postgres", { region: "sfo" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const openwaVolume = volume("openwa-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const worker = service("worker", {
    source: github("angellog/openreply"),
    build: "npm run db:generate",
    start: "npm run worker",
    replicas: { "sfo": 1 },
    env: { AGENT_RELAY_ACCOUNT_IDS: preserve(), AGENT_RELAY_SECRET: preserve(), AGENT_RELAY_URL: preserve(), CRON_SECRET: preserve(), DATABASE_URL: preserve(), ENCRYPTION_KEY: preserve(), FACEBOOK_APP_SECRET: preserve(), INSTAGRAM_APP_ID: preserve(), INSTAGRAM_APP_SECRET: preserve(), META_GRAPH_API_VERSION: preserve(), NEXTAUTH_SECRET: preserve(), NEXTAUTH_URL: preserve(), REDIS_URL: preserve(), WEBHOOK_VERIFY_TOKEN: preserve() },
  });
  const openwa = service("openwa", {
    source: github("angellog/OpenWA"),
    replicas: { "sfo": 1 },
    volumeMounts: { "/app/data": openwaVolume },
    env: { API_MASTER_KEY: preserve(), AUTO_START_SESSIONS: preserve(), BASE_URL: preserve(), CACHE_ENABLED: preserve(), DATABASE_NAME: preserve(), DATABASE_SYNCHRONIZE: preserve(), DATABASE_TYPE: preserve(), ENGINE_TYPE: preserve(), NODE_ENV: preserve(), PORT: preserve(), PUPPETEER_ARGS: preserve(), PUPPETEER_HEADLESS: preserve(), QUEUE_ENABLED: preserve(), REDIS_ENABLED: preserve(), RESOLVE_LID_TO_PHONE: preserve(), SEND_PACING_ENABLED: preserve(), SERVE_DASHBOARD: preserve(), SESSION_DATA_PATH: preserve(), STORAGE_LOCAL_PATH: preserve(), STORAGE_TYPE: preserve() },
  });

  return project("openreply", {
    resources: [Redis, worker, Postgres, openwa, openwaVolume, redisVolume, postgresVolume],
  });
});
