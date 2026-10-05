# --- deps stage: install once, cached separately from source changes ---
FROM node:20-alpine AS deps
WORKDIR /app
# The lockfile is in the repository but not in the npm package, which ships
# this Dockerfile too: build from either.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi

# --- runtime stage ---
FROM node:20-alpine
WORKDIR /app

# Run as an unprivileged user rather than root inside the container.
RUN addgroup -S tollpike && adduser -S tollpike -G tollpike

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public
COPY config ./config
COPY scripts ./scripts

# /app/data holds usage.jsonl + settings.json — mount this as a volume
# (see docker-compose.yml) or state resets every time the container recreates.
RUN mkdir -p /app/data && chown -R tollpike:tollpike /app \
  && chmod +x /app/bin/tollpike.mjs && ln -s /app/bin/tollpike.mjs /usr/local/bin/tollpike

USER tollpike

ENV PORT=20128
# The CLI would otherwise default to ~/.tollpike/data, a different directory
# from the gateway's, and print or rotate a key the gateway does not use.
# With this, "docker exec tollpike tollpike key" reads the gateway's own.
ENV TOLLPIKE_DATA_DIR=/app/data
# Inside the container, binding loopback would make the published port
# unreachable. The container's network namespace is the isolation boundary
# here — docker-compose publishes to 127.0.0.1 on the host.
ENV BIND_HOST=0.0.0.0
EXPOSE 20128

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:20128/health || exit 1

CMD ["node", "src/server.js"]
