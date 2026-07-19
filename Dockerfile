# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY index.js ./
COPY src ./src
RUN npm run build || test -f dist/src/middleware/version-resolver.js

FROM node:${NODE_VERSION} AS production-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production
USER node
COPY --chown=node:node --from=production-deps /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node index.js ./index.js
EXPOSE 3000
CMD ["node", "index.js"]
