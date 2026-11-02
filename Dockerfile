# The TypeTorch backend as one container: the analytics API (DuckDB), the fleet API (SQLite), error logs and the explorer.
# Works as a Coolify "Dockerfile" app, or locally:
#
#   docker build -t typetorch-backend .
#   docker run -d --name typetorch-backend -p 127.0.0.1:8787:8787 -v typetorch-data:/data \
#     -e TYPETORCH_API_KEY=... -e TYPETORCH_ADMIN_TOKEN=... typetorch-backend
#
# Debian-based (glibc), so DuckDB's prebuilt linux binding loads. Runs as the non-root `bun` user (uid 1000); the data
# folder is /data (mount a volume there: a bind mount must be writable by uid 1000). No secret is baked in: every setting
# comes from the environment at run time (README "Settings").
#
# Game server locations: no IP database is baked in (the build stays offline and reproducible). With NODE_ENV=production
# the server downloads DB-IP's free City Lite and ASN Lite files into /data/geoip/ a minute after start and refreshes them
# monthly (README "Game server addresses and locations"); TYPETORCH_GEOIP=off turns that off.

# 1. Build the explorer (web/) into web/dist. --bun runs Vite under Bun: this image has no Node.
FROM oven/bun:1.3 AS explorer
WORKDIR /build/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun --bun run build

# 2. The server: production dependencies, the sources and the built explorer.
FROM oven/bun:1.3-slim
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY basin ./basin
COPY --from=explorer /build/web/dist ./web/dist

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    TYPETORCH_DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8787
USER bun
# The exec-form CMD below makes bun PID 1 (or the child of compose's `init: true`), so SIGTERM reaches it: the server
# then finishes the requests running, closes DuckDB and SQLite and exits within seconds (20 s at most; give the container
# a stop grace period of 30 s). A rolling update's new container meanwhile serves the fleet and waits for DuckDB.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "src/server/main.ts"]
