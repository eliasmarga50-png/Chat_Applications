const required = ['MONGODB_URI', 'JWT_SECRET'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// HS256 is only as strong as its secret. Fail fast on a weak one.
if (process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters');
  process.exit(1);
}

// reads an integer env var, falling back to a default if unset.
// Exits at startup if the value is set but invalid or out of range.
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
  PORT: Number(process.env.PORT ?? 4000),
  MONGODB_URI: process.env.MONGODB_URI,
  isProd: process.env.NODE_ENV === 'production',
  // Origins allowed to open a browser WebSocket/polling connection (Step 3).
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // Step 4: JWT signing
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN ?? '1h',
  //  sandboxed code execution (NEW)
  EXEC_TIMEOUT_MS: intFromEnv('EXEC_TIMEOUT_MS', 2000, { min: 100, max: 10000 }),
  EXEC_MEMORY_MB: intFromEnv('EXEC_MEMORY_MB', 64, { min: 16, max: 512 }),
  EXEC_MAX_CONCURRENT: intFromEnv('EXEC_MAX_CONCURRENT', 4, { min: 1, max: 32 }),
  EXEC_MAX_CODE_CHARS: intFromEnv('EXEC_MAX_CODE_CHARS', 10000, { min: 1, max: 50000 }),
});