import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import healthRoutes from './routes/health.routes.js';
import roomsRoutes from './routes/rooms.routes.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  if (env.NODE_ENV !== 'test') app.use(morgan(env.isProd ? 'combined' : 'dev'));
  app.use(express.json({ limit: '100kb' })); // cap body size; Step 5 handles big payloads via streams

  app.use('/health', healthRoutes);
  app.use('/api/rooms', roomsRoutes);

  app.use(notFound);     // must come after all routes
  app.use(errorHandler); // must be last

  return app;
}