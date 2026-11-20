# Servify in Docker. Mount the Docker socket; replicas run as sibling containers.
FROM node:22-alpine
RUN apk add --no-cache git docker-cli docker-cli-buildx tar
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile || pnpm install
COPY . .
RUN pnpm build
ENV SERVIFY_DATA_DIR=/data \
    SERVIFY_HOST=0.0.0.0 \
    SERVIFY_PROXY_HOST=0.0.0.0 \
    SERVIFY_IN_CONTAINER=1
VOLUME /data
EXPOSE 7700 8080
CMD ["node", "server/bin/servify.mjs", "start"]
