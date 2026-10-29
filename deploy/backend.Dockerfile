# syntax=docker/dockerfile:1
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
RUN npm ci --ignore-scripts --workspace @multai/backend --include-workspace-root
COPY apps/backend/tsconfig.json apps/backend/tsconfig.build.json apps/backend/
COPY apps/backend/src apps/backend/src
COPY apps/backend/migrations apps/backend/migrations
COPY deploy/stamp-build.mjs deploy/stamp-build.mjs
ARG SOURCE_COMMIT
ARG SOURCE_DIRTY=true
RUN ./node_modules/.bin/tsc -p apps/backend/tsconfig.build.json
RUN node deploy/stamp-build.mjs
RUN npm prune --omit=dev --ignore-scripts --workspace @multai/backend --include-workspace-root \
    && rm -rf node_modules/@multai

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
WORKDIR /service
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.title="MultAI collaboration service" \
      org.opencontainers.image.revision=$SOURCE_COMMIT
COPY --from=build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/backend/dist ./dist
COPY --from=build --chown=node:node /workspace/apps/backend/migrations ./migrations
COPY --from=build --chown=node:node /workspace/apps/backend/package.json ./package.json
COPY --chown=node:node deploy/entrypoint.mjs ./entrypoint.mjs
RUN node -e "for(const name of ['electron','typescript','tsx','react','@multai/runtime']){if(require('node:fs').existsSync('node_modules/'+name))throw Error('Unexpected desktop/development dependency: '+name)}"
USER node
EXPOSE 4310
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4310/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "entrypoint.mjs"]
