# Imagem única do IONEXT Prospect Intelligence.
# Padrão: Central (painel + API) e Motor 01 no mesmo container — serve para hospedagens que sobem 1 container
# (Cloudfy, Coolify, Easypanel, Railway...). Para separar, troque o comando (veja docker-compose.yml).
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333 \
    CENTRAL_URL=http://127.0.0.1:3333
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "start"]
