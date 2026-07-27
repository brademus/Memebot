# Multi-stage build: Compile and test
FROM node:22-alpine AS builder

WORKDIR /build

# Copy manifests first for caching
COPY package*.json ./
COPY tsconfig.json ./

# Deterministic install with no optional dependencies
RUN npm ci --omit=optional

# Copy source and build
COPY src ./src
COPY config.yaml schema.sql schema-v3.sql schema-telemetry.sql ./

RUN npm run build && npm test

# Runtime: Copy only compiled output and production dependencies
FROM node:22-alpine

WORKDIR /app

# Copy manifests for production install
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy compiled JavaScript from builder
COPY --from=builder /build/dist ./dist

# Copy schema and config files
COPY config.yaml schema.sql schema-v3.sql schema-telemetry.sql ./

# Copy public dashboard assets
COPY public ./public

# Runtime environment setup (secrets injected via Railway at runtime)
ENV NODE_ENV=production

# Expose port from environment (Railway uses process.env.PORT)
EXPOSE 3000

# Start application with quota guard and budget guard preloaded
CMD ["node", "--require", "./dist/helius-quota-guard.js", "--require", "./dist/ingest/pumpportal-guard.js", "dist/boot.js"]

