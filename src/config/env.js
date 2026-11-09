const required = ['MONGODB_URI'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

export const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 4000),
  MONGODB_URI: process.env.MONGODB_URI,
  isProd: process.env.NODE_ENV === 'production',
  // Origins allowed to open a browser WebSocket/polling connection (Step 3).
  // Comma-separated, e.g. CORS_ORIGINS=http://localhost:5173,https://chat.example.dev
  CORS_ORIGINS: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});