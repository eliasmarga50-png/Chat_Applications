
const required = ['MONGODB_URI', 'JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

function intFromEnv(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${name} must be an integer between ${min} and ${max}`);
    process.exit(1);
  }
  return value;
}

export const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: intFromEnv('PORT', 4000, { min: 1, max: 65535 }),
  MONGODB_URI: process.env.MONGODB_URI,
  REDIS_URL: process.env.REDIS_URL ?? '',
  REQUIRE_REDIS_ADAPTER: process.env.REQUIRE_REDIS_ADAPTER === 'true',
  isProd: process.env.NODE_ENV === 'production',
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
    .split(',').map((origin) => origin.trim()).filter(Boolean),
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '1h',
  EXEC_TIMEOUT_MS: intFromEnv('EXEC_TIMEOUT_MS', 2000, { min: 100, max: 10000 }),
  EXEC_MEMORY_MB: intFromEnv('EXEC_MEMORY_MB', 64, { min: 16, max: 512 }),
  EXEC_MAX_CONCURRENT: intFromEnv('EXEC_MAX_CONCURRENT', 4, { min: 1, max: 32 }),
  EXEC_MAX_CODE_CHARS: intFromEnv('EXEC_MAX_CODE_CHARS', 10000, { min: 1, max: 50000 }),
});
