FROM oven/bun:1.4.4 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM oven/bun:1.4.4 AS migration-source
WORKDIR /source
COPY drizzle/migrations ./migrations
COPY scripts/staging-bounded-image.mjs ./staging-bounded-image.mjs
RUN bun staging-bounded-image.mjs /source/migrations /bounded/migrations

FROM oven/bun:1.4.4 AS runner
WORKDIR /app
ENV STAGING_MIGRATOR_MODE=inspect
COPY --from=dependencies /app/node_modules ./node_modules
COPY scripts/staging-bounded-migrate.mjs ./scripts/staging-bounded-migrate.mjs
COPY --from=migration-source /bounded/migrations ./drizzle/migrations
USER bun
ENTRYPOINT ["bun", "scripts/staging-bounded-migrate.mjs"]
