# Concert Artist Extractor MVP

A tiny local web MVP for extracting artist names from concert, festival, and live-show images with Gemini Flash, checking them against Spotify, letting the user approve the final list, and creating a Spotify playlist from those approved artists.

## Run

```bash
cd /Users/ilia/dev/concert-artist-mvp
cp .env.example .env
# Put your Gemini and Spotify credentials in .env
python3 server.py
```

Open:

```text
http://127.0.0.1:8765
```

## Result Shape

```json
{
  "event_name": "TAJADA RO pre. ほんね",
  "event_dates": ["2025-10-31"],
  "playlist_name": "TAJADA RO pre. ほんね - 2025-10-31",
  "artists": ["TAJADA RO"],
  "approved_artists": [
    {
      "name": "TAJADA RO",
      "spotify_id": "spotify-artist-id",
      "spotify_url": "https://open.spotify.com/artist/...",
      "input_name": "TAJADA RO",
      "source": "artists"
    }
  ],
  "analyzed_artists": ["TAJADA RO", "第五感情"],
  "unclear": ["Possible Stylized Logo"],
  "playlist": {
    "name": "TAJADA RO pre. ほんね - 2025-10-31",
    "url": "https://open.spotify.com/playlist/..."
  },
  "needs_verification": true
}
```

The `artists` array is the final user-approved list. The app only allows approval for exact Spotify artist-name matches.

## Spotify Setup

Create a Spotify app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), then add these to `.env`.
This is a one-time developer setup. End users do not need the dashboard; they only click **Sign In** in the app.

```bash
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8765/callback
SPOTIFY_MARKET=US
SPOTIFY_PLAYLIST_PUBLIC=0
```

Add this exact redirect URI in the Spotify dashboard:

```text
http://127.0.0.1:8765/callback
```

Do not use `localhost` for the redirect URI. Spotify permits HTTP for explicit loopback IP literals like `127.0.0.1`, but `localhost` is not allowed.

If Spotify shows `redirect_uri: Not matching configuration`, add the value from `SPOTIFY_REDIRECT_URI` to the Spotify dashboard exactly. The scheme, host, port, and path must all match.

For production, register your deployed callback URL instead, for example:

```text
https://your-domain.example/callback
```

Playlist creation requires user login and these scopes:

```text
playlist-modify-private playlist-modify-public user-read-private
```

The app asks for confirmation before creating the playlist. It adds up to 5 popular Spotify tracks per approved artist, using Spotify track search filtered to the artist.

## Inputs

- Upload: JPEG, PNG, WebP, HEIC, HEIF.
- URL: the server downloads an HTTP/HTTPS image, blocks private/local hosts by default, and caps image size.

## Notes

- Default model: `gemini-2.5-flash`.
- Override with `GEMINI_MODEL` in `.env`.
- Spotify credentials use the Web API client-credentials flow: `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET`.
- Deployment notes are in [DEPLOYMENT.md](DEPLOYMENT.md).
- This is an MVP. For production URL downloads, keep the private-network block and add stronger redirect/DNS-rebinding protections.
