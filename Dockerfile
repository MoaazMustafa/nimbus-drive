# Optional Docker image — an alternative to running with Node directly.
# See SETUP.md §7. Note: on Docker Desktop (Windows/macOS), files hand-pasted
# into a bind-mounted storage folder may not fire change events; the app still
# sees them on refresh, or set WATCH_POLLING=true for live updates.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package-lock.json* ./server/
COPY web/package.json web/package-lock.json* ./web/
RUN npm install && npm --prefix server install && npm --prefix web install

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app ./
COPY . .
RUN npm --prefix web run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
# Storage + data live on volumes (see docker-compose.yml)
ENV STORAGE_ROOT=/storage DATA_DIR=/data API_PORT=4400
EXPOSE 3000
CMD ["npm", "start"]
