# Deployment

## What Goes In Git

Commit app code, `.env.example`, docs, and CI files.

Do not commit `.env`. It contains API keys and Spotify secrets and is ignored by Git.

## Environment Variables

Local development:

```bash
HOST=127.0.0.1
PORT=8765
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8765/callback
SPOTIFY_MARKET=US
SPOTIFY_PLAYLIST_PUBLIC=0
MAX_IMAGE_BYTES=8388608
MAX_REQUEST_BYTES=12582912
DOWNLOAD_TIMEOUT_SECONDS=12
BLOCK_PRIVATE_URLS=1
```

Production example:

```bash
HOST=0.0.0.0
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=https://your-app.example.com/callback
SPOTIFY_MARKET=US
SPOTIFY_PLAYLIST_PUBLIC=0
MAX_IMAGE_BYTES=8388608
MAX_REQUEST_BYTES=12582912
DOWNLOAD_TIMEOUT_SECONDS=12
BLOCK_PRIVATE_URLS=1
```

Most managed web hosts provide `PORT` automatically. On Render, do not set `PORT` yourself unless Render support tells you to.

## Spotify Dashboard

Local callback:

```text
http://127.0.0.1:8765/callback
```

Production callback:

```text
https://your-app.example.com/callback
```

The value in Spotify Dashboard must match `SPOTIFY_REDIRECT_URI` exactly.

## Simple Host Setup

For a free/easy host such as Render:

- Connect the GitHub repository.
- Runtime: Python.
- Build command: leave empty or use `true`.
- Start command: `python server.py`.
- Add the production environment variables in the host dashboard.
- Set `HOST=0.0.0.0`.
- Do not set `PORT` manually; Render injects it.
- After the service gets its HTTPS URL, update `SPOTIFY_REDIRECT_URI` and Spotify Dashboard.

## What Codex Can Do

- Prepare code for deployment.
- Initialize a local Git repo.
- Create commits.
- Add CI files.
- Create deploy docs.

## What You Need To Do

- Create or authorize the GitHub repository under your account.
- Paste secrets into GitHub/Render/hosting dashboards.
- Configure the Spotify app redirect URI.
- Configure the Gemini API key.
- Connect a payment method if a provider requires it, even for a free tier.
