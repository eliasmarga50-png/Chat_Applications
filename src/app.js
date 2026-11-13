
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import healthRoutes from './routes/health.routes.js';
import roomsRoutes from './routes/rooms.routes.js';
import authRoutes from './routes/auth.routes.js';
import uploadsRoutes from './routes/uploads.routes.js';
import executeRoutes from './routes/execute.routes.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { env } from './config/env.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());

  if (env.NODE_ENV !== 'test') {
    app.use(morgan(env.isProd ? 'combined' : 'dev'));
  }

  // Raw uploads must be mounted before express.json(). The request stream is
  // consumed by streamUpload(), including when Content-Type is application/json.
  app.use('/api/uploads', uploadsRoutes);

  app.use(express.json({ limit: '100kb' }));
  app.use('/health', healthRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/rooms', roomsRoutes);
  app.use('/api/execute', executeRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
