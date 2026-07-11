# Deploying Pax Colonia

Pax Colonia runs as a single Express server that serves the built client and the
map data. This guide covers a container deploy to [EasyPanel](https://easypanel.io/),
but the image is a plain Docker image and works on any host.

## What the image contains

- The built Vite client (`dist/`).
- The Express server (`server/`) — its only third-party runtime dependency is
  `express`, so the runtime image is small.
- The map binaries (`public/assets/*.pmtiles`, seed geojson) — **Git-LFS tracked**.
- The baked scenarios, including **Pax Colonia** (`server/data/scenarios/`).

The build **fails loudly** (`scripts/verify-assets.mjs`) if the Git-LFS map
assets were not resolved, so a blank-globe image can't ship.

## Prerequisites

1. **A GitHub repo with the LFS objects pushed.** The map files (`regions.pmtiles`
   is ~105 MB) are stored with Git LFS. Push them:
   ```sh
   git lfs install
   git add .
   git commit -m "Pax Colonia"
   git push            # pushes LFS objects too
   ```
   A **public** repo is simplest: the build resolves LFS with `git lfs pull`,
   which needs no credentials for a public repo. (For a private repo, the build
   host must be able to authenticate to fetch LFS objects.)
2. That the build host has `git-lfs` available, **or** that the repo was cloned
   with LFS smudging on. The Dockerfile installs `git-lfs` in its build stage and
   runs `git lfs pull`, so a standard EasyPanel git-source build resolves it.

## EasyPanel setup

1. **Create app → Source: GitHub**, pointing at your repo/branch.
2. **Build: Dockerfile** (the repo root `Dockerfile`). No build args needed.
3. **Port:** the app listens on **3000**. Point the EasyPanel proxy at `3000`.
4. **Domain:** attach your domain to the app in EasyPanel's Domains tab. (Keep the
   domain in EasyPanel only — it does not belong in the repo.)

### Environment variables (managed LLM endpoint)

Set these in EasyPanel's Environment tab so every player uses your LLM with **no
per-browser Settings entry**, and the API key stays on the server (it is never
sent to any browser):

| Variable        | Required | Purpose                                                        |
| --------------- | -------- | -------------------------------------------------------------- |
| `LLM_BASE_URL`  | yes      | OpenAI-compatible base URL, e.g. `https://your-endpoint/v1`.   |
| `LLM_API_KEY`   | yes      | Bearer key for that endpoint. Injected server-side at relay.   |
| `LLM_MODEL`     | strongly recommended | Model id, e.g. `gpt-4o-mini`. If omitted, the client tries `/models` discovery. |
| `LLM_DISABLE_REASONING` | no | Set to `1` if your endpoint rejects the `reasoning_effort` field — the relay strips it. |
| `PORT`          | no       | Defaults to `3000`.                                            |

Managed mode turns on only when both `LLM_BASE_URL` and `LLM_API_KEY` are set.
Without them the game runs stock — each player configures their own provider in
Settings, exactly like upstream Open Historia.

To confirm managed mode is live, request `GET /<your-app>/api/ai/config` — it
returns `{"managed":true,"provider":"openai-compatible","model":"..."}` and never
includes the key or the endpoint URL.

### Persistent volume (saved games)

Mount a volume at:

```
/app/server/data
```

Saved games live under `server/data/games`. On a **fresh** volume the mount is
empty and would hide the baked scenarios, so the entrypoint re-seeds them from a
copy kept outside the mount (`/app/seed`) on first boot — without ever clobbering
existing saves. So the volume can start empty; the scenarios appear automatically.

### Access control (basic auth)

Open Historia has no built-in login. If the deploy should not be public, add
**HTTP Basic Auth** in EasyPanel (a Traefik `basicAuth` middleware on the app's
domain). Configure it in EasyPanel, not in the repo.

## First run

1. Open the app. Start a **New Game** and pick the **Pax Colonia** scenario.
2. Each power starts with one region and expands deterministically every turn —
   settlers claim neighbouring land, armies take enemy borders, and each nation
   follows its own temperament (aggressive, cautious, expansionist, …).

## Local Docker (optional)

```sh
docker build -t pax-colonia .
docker run --rm -p 3000:3000 \
  -e LLM_BASE_URL="https://your-endpoint/v1" \
  -e LLM_API_KEY="sk-..." \
  -e LLM_MODEL="gpt-4o-mini" \
  -v pax-data:/app/server/data \
  pax-colonia
# open http://localhost:3000
```
