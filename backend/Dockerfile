FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Install only production dependencies to keep image lean and audit friendly.
RUN apk add --no-cache git tzdata
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
ENV NODE_ENV=production
ENV TZ=UTC
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- --header="X-Forwarded-Proto: https" http://localhost:3000/api/v1/health/ready || exit 1

CMD ["node", "src/server.js"]
