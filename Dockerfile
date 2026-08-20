# build stage
FROM node:lts-alpine AS build-stage
# Set environment variables for non-interactive npm installs
ENV NPM_CONFIG_LOGLEVEL warn
ENV CI true
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# corepack pins pnpm to package.json's packageManager field; `npm install -g pnpm`
# grabs latest, which refuses this lockfile ("Cannot verify the identity of the
# @pnpm/exe.linux-x64 native binary: it is missing from pnpm-lock.yaml").
RUN corepack enable && pnpm i --frozen-lockfile
COPY . .
ARG VITE_CONVERTX_URL=/api/v1
ENV VITE_CONVERTX_URL=$VITE_CONVERTX_URL
RUN pnpm build

# production stage
FROM nginx:stable-alpine AS production-stage
COPY --from=build-stage /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
