import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import process from 'node:process';
import env from './config/env.js';
import logger from './infra/logging/logger.js';
import requestContext from './interfaces/http/middlewares/requestContext.js';
import errorHandler from './interfaces/http/middlewares/errorHandler.js';
import notFoundHandler from './interfaces/http/middlewares/notFoundHandler.js';
import routesV1 from './interfaces/http/routes/index.js';
import rateLimit from './interfaces/http/middlewares/rateLimit.js';
import { responseWrapper } from './interfaces/http/middlewares/responseWrapper.js';
import backpressure from './interfaces/http/middlewares/backpressure.js';
import enforceHttps from './interfaces/http/middlewares/enforceHttps.js';
import sanitizeInput from './interfaces/http/middlewares/sanitizeInput.js';
import { getStartupState, isStartupReady } from './infra/runtime/startupState.js';

const app = express();

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim())
  : ['*'];

// Base hardening middleware stack; keep order to avoid leaking data before logging.
app.set('trust proxy', true); // Respect X-Forwarded-* from Nginx/ingress for audit IPs.
app.use(requestContext);
if (env.http.requireHttps) {
  app.use(enforceHttps);
}
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url?.startsWith('/api/v1/health/')
    },
    customProps: (req) => ({ requestId: req.id }),
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed'
  })
);
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(backpressure);
app.use(rateLimit);
app.use(sanitizeInput);
app.use(compression());
app.use(express.json({ limit: env.http.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: env.http.bodyLimit }));
app.use(responseWrapper);

// Global request timeout protects upstream resources in overload scenarios.
app.use((req, res, next) => {
  res.setTimeout(env.http.requestTimeoutMs, () => {
    req.log.warn({ requestId: res.locals.requestId }, 'Request timed out');
    res.status(503).json({ error: 'Request timeout', requestId: res.locals.requestId });
  });
  next();
});

app.use((req, res, next) => {
  if (isStartupReady()) {
    next();
    return;
  }
  if (req.path === '/api/v1/health/live' || req.path === '/api/v1/health/ready') {
    next();
    return;
  }
  res.status(503).json({
    error: 'Service starting',
    startup: getStartupState(),
    requestId: res.locals.requestId
  });
});

app.use('/api/v1', routesV1);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
