# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 oven/bun:1.3.11-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

FROM --platform=linux/amd64 oven/bun:1.3.11-slim
WORKDIR /app
ENV NODE_ENV=production HOME=/tmp TMPDIR=/tmp
COPY --chown=1000:1000 --from=dependencies /app/node_modules ./node_modules
COPY --chown=1000:1000 package.json bun.lock tsconfig.json bunfig.toml ./
COPY --chown=1000:1000 src ./src
USER 1000:1000
EXPOSE 8080 8081
CMD ["bun", "run", "start:api"]
