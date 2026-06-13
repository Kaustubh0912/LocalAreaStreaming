# syntax=docker/dockerfile:1

FROM node:22-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:22-alpine AS server-builder
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci
COPY server/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg dumb-init \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8096

WORKDIR /app/server

COPY server/package*.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=server-builder /app/server/dist ./dist
COPY --from=client-builder /app/client/dist /app/public

RUN mkdir -p /app/server/data/subtitles /app/server/data/hls-stable /media

EXPOSE 8096

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
