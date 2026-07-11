# Pax Colonia — production image for EasyPanel (or any Docker host).
#
# Two stages: a full Node image builds the Vite client and resolves the Git-LFS
# map binaries; a slim image runs just the Express server (its only third-party
# runtime dependency) plus the built client and the map assets.
#
# syntax=docker/dockerfile:1

# ---- Stage 1: build ---------------------------------------------------------
FROM node:22-bookworm AS build
WORKDIR /app

# The map binaries are Git-LFS tracked. EasyPanel's build context has no .git and
# doesn't smudge LFS, so `git lfs pull` can't run here — instead resolve-lfs.mjs
# fetches each object straight from GitHub's media host by reading the pointer OID
# (the deploy fork is public, so no credentials). GIT_SHA is the commit being built
# (EasyPanel passes it); owner/repo default to the deploy fork and can be overridden.
ARG GIT_SHA=pax-colonia
ARG LFS_OWNER=Romuromylus
ARG LFS_REPO=open-historia

# Install deps first so this layer caches across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci

# The rest of the repo (LFS pointer stubs included).
COPY . .

# Resolve LFS pointers to real bytes from the media host, then HARD-verify: a build
# that would ship a blank map fails here. resolve-lfs.mjs is a no-op for files that
# are already real (e.g. a local build from an LFS-smudged working tree).
RUN node scripts/resolve-lfs.mjs . "$LFS_OWNER" "$LFS_REPO" "$GIT_SHA" \
  && node scripts/verify-assets.mjs

# Build the client bundle. The pmtiles vite copies into dist/assets are dead
# weight — the client streams them from public/assets through the server API.
RUN npm run build \
  && rm -f dist/assets/*.pmtiles

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

# The server imports only express (everything else is a Node builtin), so the
# runtime node_modules is tiny — no react/vite/eslint from the build toolchain.
COPY package.json ./
RUN npm install --omit=dev --no-save express@^5.1.0 \
  && npm cache clean --force

# Server code, built client, and the map binaries the server streams.
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# A seed copy of the baked scenarios kept OUTSIDE server/data, so a fresh
# persistence volume mounted at server/data can be re-seeded on first boot
# (the mount would otherwise shadow the baked scenarios). See docker-entrypoint.sh.
RUN cp -r server/data /app/seed

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
