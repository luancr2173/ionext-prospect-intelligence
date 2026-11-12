FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
# Central:  docker run ... pnpm --filter @ionext/central start
# Motor 01: docker run ... pnpm --filter @ionext/motor-prospecting worker
CMD ["pnpm", "--filter", "@ionext/central", "start"]
