#!/usr/bin/env python3
import base64
import binascii
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import time
import traceback
import unicodedata
from email import policy
from email.parser import BytesParser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
STATIC_ROOT = ROOT / "static"
DEFAULT_PORT = 8765
DEFAULT_MODEL = "gemini-2.5-flash"
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))
MAX_REQUEST_BYTES = int(os.getenv("MAX_REQUEST_BYTES", str(12 * 1024 * 1024)))
DOWNLOAD_TIMEOUT_SECONDS = float(os.getenv("DOWNLOAD_TIMEOUT_SECONDS", "12"))
BLOCK_PRIVATE_URLS = os.getenv("BLOCK_PRIVATE_URLS", "1") != "0"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize"
SPOTIFY_API_BASE = "https://api.spotify.com/v1"
SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search"
SPOTIFY_TOKEN_CACHE = {"access_token": None, "expires_at": 0}
SPOTIFY_OAUTH_STATES = {}
SPOTIFY_USER_SESSIONS = {}
SPOTIFY_AUTH_SCOPE = "playlist-modify-private playlist-modify-public user-read-private ugc-image-upload"
SPOTIFY_STATE_TTL_SECONDS = 10 * 60

SUPPORTED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
}

PROMPT = """
You are an artist-name extraction system for concert, festival, and live-show images.

Analyze the image and return only music artist, band, DJ, or performer names that are visibly written in the image.

Rules:
- Preserve names exactly as written, including Japanese, punctuation, capitalization, and symbols.
- Put clearly readable artist names in "artists".
- Put possible artist names that are stylized, partially hidden, blurry, or uncertain in "unclear".
- Extract the event, festival, tour, or show name into "event_name" when visible.
- Extract visible event date strings into "event_dates". Preserve the date text as written when exact ISO conversion is not obvious.
- Do not include festival names, event names, venues, cities, dates, ticket URLs, prices, labels, sponsors, promoters, or phrases like "and more", "TBA", "upcoming shows", "release party", or "special guests" in "artists" or "unclear".
- Do not guess from faces, clothing, instruments, or genre.
- Set "needs_verification" to true when "unclear" is non-empty, when important logos are hard to read, or when the image quality makes the result likely incomplete.

Return JSON only:
{
  "artists": ["Artist Name"],
  "unclear": ["Possible Artist Name"],
  "event_name": "Event Name",
  "event_dates": ["2025-10-31"],
  "needs_verification": true
}
""".strip()


class AppError(Exception):
    def __init__(self, message, status=HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def load_dotenv(override=False):
    env_path = ROOT / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and (override or key not in os.environ):
            os.environ[key] = value


def infer_mime_type(data, declared=None, filename=None):
    declared = (declared or "").split(";")[0].strip().lower()
    if declared == "image/jpg":
        declared = "image/jpeg"
    if declared in SUPPORTED_IMAGE_TYPES:
        return declared

    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) > 12 and data[4:12] in {b"ftypheic", b"ftypheix", b"ftyphevc", b"ftyphevx", b"ftypmif1", b"ftypmsf1"}:
        return "image/heic"

    if filename:
        guessed, _ = mimetypes.guess_type(filename)
        if guessed == "image/jpg":
            guessed = "image/jpeg"
        if guessed in SUPPORTED_IMAGE_TYPES:
            return guessed

    raise AppError("Unsupported image type. Use JPEG, PNG, WebP, HEIC, or HEIF.")


def parse_multipart(content_type, body):
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    message = BytesParser(policy=policy.default).parsebytes(header + body)
    fields = {}

    if not message.is_multipart():
        raise AppError("Expected multipart form data.")

    for part in message.iter_parts():
        disposition = part.get("Content-Disposition", "")
        if not disposition:
            continue

        params = dict(part.get_params(header="content-disposition") or [])
        name = params.get("name")
        if not name:
            continue

        payload = part.get_payload(decode=True) or b""
        fields[name] = {
            "filename": params.get("filename"),
            "content_type": part.get_content_type(),
            "bytes": payload,
            "text": payload.decode(part.get_content_charset() or "utf-8", errors="replace").strip(),
        }

    return fields


def validate_public_http_url(raw_url):
    raw_url = (raw_url or "").strip()
    parsed = urlparse(raw_url)

    if parsed.scheme not in {"http", "https"}:
        raise AppError("Image URL must start with http:// or https://.")
    if not parsed.hostname:
        raise AppError("Image URL is missing a hostname.")

    if not BLOCK_PRIVATE_URLS:
        return raw_url

    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise AppError(f"Could not resolve image URL hostname: {exc}") from exc

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise AppError("Private, local, or reserved network URLs are blocked.")

    return raw_url


def download_image(raw_url):
    url = validate_public_http_url(raw_url)
    request = Request(url, headers={"User-Agent": "concert-artist-mvp/0.1"})

    try:
        with urlopen(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            declared_type = response.headers.get_content_type()
            chunks = []
            total = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_IMAGE_BYTES:
                    raise AppError(f"Image is too large. Limit is {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
                chunks.append(chunk)
    except HTTPError as exc:
        raise AppError(f"Image download failed with HTTP {exc.code}.") from exc
    except URLError as exc:
        raise AppError(f"Image download failed: {exc.reason}") from exc
    except TimeoutError as exc:
        raise AppError("Image download timed out.") from exc

    data = b"".join(chunks)
    mime_type = infer_mime_type(data, declared=declared_type, filename=urlparse(url).path)
    return data, mime_type


def extract_image_from_form(fields):
    upload = fields.get("image")
    image_url = fields.get("image_url", {}).get("text", "")

    if upload and upload["filename"] and upload["bytes"]:
        data = upload["bytes"]
        if len(data) > MAX_IMAGE_BYTES:
            raise AppError(f"Image is too large. Limit is {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
        mime_type = infer_mime_type(data, declared=upload["content_type"], filename=upload["filename"])
        return data, mime_type

    if image_url:
        return download_image(image_url)

    raise AppError("Provide an uploaded image or an image URL.")


def call_gemini(image_bytes, mime_type):
    load_dotenv(override=True)
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise AppError("GEMINI_API_KEY is not configured. Add it to .env and try again, or export it before starting the server.", HTTPStatus.SERVICE_UNAVAILABLE)

    model = os.getenv("GEMINI_MODEL", DEFAULT_MODEL).strip().removeprefix("models/")
    endpoint = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + quote(model, safe="")
        + ":generateContent?"
        + urlencode({"key": api_key})
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": base64.b64encode(image_bytes).decode("ascii"),
                        }
                    },
                    {"text": PROMPT},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.0,
            "responseMimeType": "application/json",
        },
    }

    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Gemini request failed with HTTP {exc.code}: {redact_secret(details)}", HTTPStatus.BAD_GATEWAY) from exc
    except URLError as exc:
        raise AppError(f"Gemini request failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc
    except TimeoutError as exc:
        raise AppError("Gemini request timed out.", HTTPStatus.BAD_GATEWAY) from exc


def parse_json_text(text):
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.removeprefix("```json").removeprefix("```").strip()
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3].strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def unique_strings(value):
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []

    seen = set()
    result = []
    for item in value:
        if not isinstance(item, str):
            continue
        normalized = " ".join(item.strip().split())
        if normalized and normalized.lower() not in seen:
            seen.add(normalized.lower())
            result.append(normalized)
    return result


def optional_string(value):
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.strip().split())
    return normalized or None


def comparable_name(value):
    normalized = unicodedata.normalize("NFKC", value or "").casefold()
    normalized = normalized.replace("&", "and")
    return "".join(character for character in normalized if character.isalnum())


def normalize_result(raw_response):
    candidates = raw_response.get("candidates") or []
    if not candidates:
        raise AppError("Gemini returned no candidates.", HTTPStatus.BAD_GATEWAY)

    parts = candidates[0].get("content", {}).get("parts", [])
    text = "\n".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()
    if not text:
        raise AppError("Gemini returned an empty response.", HTTPStatus.BAD_GATEWAY)

    try:
        parsed = parse_json_text(text)
    except json.JSONDecodeError as exc:
        raise AppError(f"Gemini returned invalid JSON: {text}", HTTPStatus.BAD_GATEWAY) from exc

    artists = unique_strings(parsed.get("artists"))
    unclear = unique_strings(parsed.get("unclear") or parsed.get("uncertain"))
    event_name = optional_string(parsed.get("event_name"))
    event_dates = unique_strings(parsed.get("event_dates") or parsed.get("event_date"))
    needs_verification = bool(parsed.get("needs_verification")) or bool(unclear)

    return {
        "artists": artists,
        "unclear": unclear,
        "event_name": event_name,
        "event_dates": event_dates,
        "needs_verification": needs_verification,
    }


def require_spotify_credentials():
    load_dotenv(override=True)
    client_id = os.getenv("SPOTIFY_CLIENT_ID", "").strip()
    client_secret = os.getenv("SPOTIFY_CLIENT_SECRET", "").strip()

    if (
        not client_id
        or not client_secret
        or client_id.startswith("your_")
        or client_secret.startswith("your_")
    ):
        raise AppError(
            "SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are not configured. Add them to .env and try again.",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )

    return client_id, client_secret


def spotify_redirect_uri():
    load_dotenv(override=True)
    return os.getenv("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8765/callback").strip()


def spotify_market():
    load_dotenv(override=True)
    return os.getenv("SPOTIFY_MARKET", "US").strip() or "US"


def spotify_playlist_public():
    load_dotenv(override=True)
    return os.getenv("SPOTIFY_PLAYLIST_PUBLIC", "0").strip().lower() in {"1", "true", "yes"}


def get_spotify_token(force_refresh=False):
    now = time.time()
    cached_token = SPOTIFY_TOKEN_CACHE.get("access_token")
    if cached_token and not force_refresh and SPOTIFY_TOKEN_CACHE.get("expires_at", 0) > now + 60:
        return cached_token

    client_id, client_secret = require_spotify_credentials()
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    request = Request(
        SPOTIFY_TOKEN_URL,
        data=urlencode({"grant_type": "client_credentials"}).encode("utf-8"),
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Spotify token request failed with HTTP {exc.code}: {details}", HTTPStatus.BAD_GATEWAY) from exc
    except URLError as exc:
        raise AppError(f"Spotify token request failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc
    except TimeoutError as exc:
        raise AppError("Spotify token request timed out.", HTTPStatus.BAD_GATEWAY) from exc

    access_token = payload.get("access_token")
    if not access_token:
        raise AppError("Spotify token response did not include an access token.", HTTPStatus.BAD_GATEWAY)

    SPOTIFY_TOKEN_CACHE["access_token"] = access_token
    SPOTIFY_TOKEN_CACHE["expires_at"] = now + int(payload.get("expires_in", 3600))
    return access_token


def spotify_app_request_json(url, method="GET", payload=None, force_refresh=False):
    token = get_spotify_token(force_refresh=force_refresh)
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, data=data, headers=headers, method=method)

    try:
        with urlopen(request, timeout=20) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as exc:
        if exc.code == 401 and not force_refresh:
            SPOTIFY_TOKEN_CACHE["access_token"] = None
            return spotify_app_request_json(url, method=method, payload=payload, force_refresh=True)
        if exc.code == 429:
            retry_after = exc.headers.get("Retry-After", "unknown")
            raise AppError(f"Spotify rate limit hit. Retry after {retry_after} seconds.", HTTPStatus.BAD_GATEWAY) from exc
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Spotify request failed with HTTP {exc.code}: {details}", HTTPStatus.BAD_GATEWAY) from exc
    except URLError as exc:
        raise AppError(f"Spotify request failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc
    except TimeoutError as exc:
        raise AppError("Spotify request timed out.", HTTPStatus.BAD_GATEWAY) from exc


def spotify_get_json(url, force_refresh=False):
    return spotify_app_request_json(url, force_refresh=force_refresh)


def spotify_artist_summary(item):
    images = item.get("images") or []
    return {
        "id": item.get("id"),
        "name": item.get("name"),
        "url": (item.get("external_urls") or {}).get("spotify"),
        "uri": item.get("uri"),
        "genres": item.get("genres") or [],
        "popularity": item.get("popularity"),
        "followers": (item.get("followers") or {}).get("total"),
        "image_url": images[0].get("url") if images else None,
    }


def search_spotify_artist(name):
    query = urlencode({"q": name, "type": "artist", "limit": "5"})
    payload = spotify_get_json(f"{SPOTIFY_SEARCH_URL}?{query}")
    items = (payload.get("artists") or {}).get("items") or []

    expected = comparable_name(name)
    exact_match = None
    for item in items:
        if comparable_name(item.get("name", "")) == expected:
            exact_match = item
            break

    return {
        "input_name": name,
        "status": "verified" if exact_match else "not_found",
        "spotify": spotify_artist_summary(exact_match) if exact_match else None,
        "alternatives": [spotify_artist_summary(item) for item in items[:3]],
    }


def search_spotify_artist_candidates(name, limit=8):
    name = optional_string(name)
    if not name:
        raise AppError("Enter an artist name to search.")

    limit = max(1, min(int(limit or 8), 10))
    query = urlencode({"q": name, "type": "artist", "limit": str(limit)})
    payload = spotify_get_json(f"{SPOTIFY_SEARCH_URL}?{query}")
    items = (payload.get("artists") or {}).get("items") or []
    return [spotify_artist_summary(item) for item in items]


def spotify_check_artists(artists, unclear):
    checks = []
    seen = set()

    for source, names in (("artists", artists), ("unclear", unclear)):
        for name in names:
            key = comparable_name(name)
            if not key or key in seen:
                continue
            seen.add(key)

            check = search_spotify_artist(name)
            check["source"] = source
            checks.append(check)

    verified_ids = set()
    verified_artists = []
    for check in checks:
        spotify_artist = check.get("spotify")
        if check.get("status") != "verified" or not spotify_artist:
            continue
        spotify_id = spotify_artist.get("id")
        if spotify_id and spotify_id not in verified_ids:
            verified_ids.add(spotify_id)
            verified_artists.append(spotify_artist)

    return checks, verified_artists


def cleanup_expired_oauth_states():
    now = time.time()
    expired = [state for state, data in SPOTIFY_OAUTH_STATES.items() if data.get("expires_at", 0) <= now]
    for state in expired:
        SPOTIFY_OAUTH_STATES.pop(state, None)


def build_spotify_login_url():
    client_id, _ = require_spotify_credentials()
    cleanup_expired_oauth_states()
    state = secrets.token_urlsafe(24)
    SPOTIFY_OAUTH_STATES[state] = {"expires_at": time.time() + SPOTIFY_STATE_TTL_SECONDS}

    return (
        SPOTIFY_AUTHORIZE_URL
        + "?"
        + urlencode(
            {
                "client_id": client_id,
                "response_type": "code",
                "redirect_uri": spotify_redirect_uri(),
                "scope": SPOTIFY_AUTH_SCOPE,
                "state": state,
            }
        )
    )


def exchange_spotify_code(code):
    client_id, client_secret = require_spotify_credentials()
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    request = Request(
        SPOTIFY_TOKEN_URL,
        data=urlencode(
            {
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": spotify_redirect_uri(),
            }
        ).encode("utf-8"),
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Spotify authorization failed with HTTP {exc.code}: {details}", HTTPStatus.BAD_GATEWAY) from exc
    except URLError as exc:
        raise AppError(f"Spotify authorization failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc
    except TimeoutError as exc:
        raise AppError("Spotify authorization timed out.", HTTPStatus.BAD_GATEWAY) from exc


def create_spotify_user_session(token_payload):
    access_token = token_payload.get("access_token")
    if not access_token:
        raise AppError("Spotify authorization did not return an access token.", HTTPStatus.BAD_GATEWAY)

    session_id = secrets.token_urlsafe(32)
    SPOTIFY_USER_SESSIONS[session_id] = {
        "access_token": access_token,
        "refresh_token": token_payload.get("refresh_token"),
        "expires_at": time.time() + int(token_payload.get("expires_in", 3600)),
    }
    return session_id


def parse_cookies(header):
    cookies = {}
    for part in (header or "").split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


def refresh_spotify_user_session(session_id):
    session = SPOTIFY_USER_SESSIONS.get(session_id)
    if not session or not session.get("refresh_token"):
        raise AppError("Spotify login expired. Sign in again.", HTTPStatus.UNAUTHORIZED)

    client_id, client_secret = require_spotify_credentials()
    credentials = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    request = Request(
        SPOTIFY_TOKEN_URL,
        data=urlencode(
            {
                "grant_type": "refresh_token",
                "refresh_token": session["refresh_token"],
            }
        ).encode("utf-8"),
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Spotify token refresh failed with HTTP {exc.code}: {details}", HTTPStatus.UNAUTHORIZED) from exc
    except URLError as exc:
        raise AppError(f"Spotify token refresh failed: {exc.reason}", HTTPStatus.UNAUTHORIZED) from exc
    except TimeoutError as exc:
        raise AppError("Spotify token refresh timed out.", HTTPStatus.UNAUTHORIZED) from exc

    session["access_token"] = payload.get("access_token", session["access_token"])
    session["refresh_token"] = payload.get("refresh_token", session["refresh_token"])
    session["expires_at"] = time.time() + int(payload.get("expires_in", 3600))
    return session


def get_spotify_user_session(session_id):
    session = SPOTIFY_USER_SESSIONS.get(session_id)
    if not session:
        raise AppError("Sign in with Spotify before creating a playlist.", HTTPStatus.UNAUTHORIZED)
    if session.get("expires_at", 0) <= time.time() + 60:
        session = refresh_spotify_user_session(session_id)
    return session


def spotify_user_request_json(session_id, method, path, payload=None, retry=True):
    session = get_spotify_user_session(session_id)
    data = None
    headers = {"Authorization": f"Bearer {session['access_token']}"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    url = path if path.startswith("http") else f"{SPOTIFY_API_BASE}{path}"
    request = Request(url, data=data, headers=headers, method=method)

    try:
        with urlopen(request, timeout=25) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except HTTPError as exc:
        if exc.code == 401 and retry:
            refresh_spotify_user_session(session_id)
            return spotify_user_request_json(session_id, method, path, payload=payload, retry=False)
        if exc.code == 429:
            retry_after = exc.headers.get("Retry-After", "unknown")
            raise AppError(f"Spotify rate limit hit. Retry after {retry_after} seconds.", HTTPStatus.BAD_GATEWAY) from exc
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Spotify user request failed with HTTP {exc.code}: {details}", HTTPStatus.BAD_GATEWAY) from exc
    except URLError as exc:
        raise AppError(f"Spotify user request failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc
    except TimeoutError as exc:
        raise AppError("Spotify user request timed out.", HTTPStatus.BAD_GATEWAY) from exc


def spotify_user_request_raw(session_id, method, path, body, content_type, retry=True):
    session = get_spotify_user_session(session_id)
    data = body.encode("ascii") if isinstance(body, str) else body
    headers = {
        "Authorization": f"Bearer {session['access_token']}",
        "Content-Type": content_type,
    }

    url = path if path.startswith("http") else f"{SPOTIFY_API_BASE}{path}"
    request = Request(url, data=data, headers=headers, method=method)

    try:
        with urlopen(request, timeout=25) as response:
            response.read()
            return {"status": response.status}
    except HTTPError as exc:
        if exc.code == 401 and retry:
            refresh_spotify_user_session(session_id)
            return spotify_user_request_raw(session_id, method, path, body, content_type, retry=False)
        if exc.code == 429:
            retry_after = exc.headers.get("Retry-After", "unknown")
            raise AppError(f"Spotify rate limit hit. Retry after {retry_after} seconds.", HTTPStatus.BAD_GATEWAY) from exc
        details = exc.read().decode("utf-8", errors="replace")
        raise AppError(f"Spotify user request failed with HTTP {exc.code}: {details}", HTTPStatus.BAD_GATEWAY) from exc
    except URLError as exc:
        raise AppError(f"Spotify user request failed: {exc.reason}", HTTPStatus.BAD_GATEWAY) from exc
    except TimeoutError as exc:
        raise AppError("Spotify user request timed out.", HTTPStatus.BAD_GATEWAY) from exc


def spotify_auth_status(session_id):
    base = {
        "authenticated": False,
        "login_url": "/api/spotify/login",
        "redirect_uri": spotify_redirect_uri(),
    }

    if not session_id or session_id not in SPOTIFY_USER_SESSIONS:
        return base

    try:
        profile = spotify_user_request_json(session_id, "GET", "/me")
    except AppError as exc:
        if exc.status == HTTPStatus.UNAUTHORIZED:
            return base
        raise

    return {
        "authenticated": True,
        "login_url": "/api/spotify/login",
        "redirect_uri": spotify_redirect_uri(),
        "user": {
            "id": profile.get("id"),
            "display_name": profile.get("display_name") or profile.get("id"),
            "url": (profile.get("external_urls") or {}).get("spotify"),
        },
    }


def track_summary(track):
    return {
        "id": track.get("id"),
        "name": track.get("name"),
        "uri": track.get("uri"),
        "url": (track.get("external_urls") or {}).get("spotify"),
        "popularity": track.get("popularity"),
        "artist_names": [artist.get("name") for artist in track.get("artists", []) if artist.get("name")],
    }


def search_top_tracks_for_artist(artist):
    artist_id = artist.get("spotify_id") or artist.get("id")
    artist_name = artist.get("name") or artist.get("input_name")
    if not artist_id or not artist_name:
        return []

    query = urlencode(
        {
            "q": f'artist:"{artist_name}"',
            "type": "track",
            "limit": "50",
            "market": spotify_market(),
        }
    )
    payload = spotify_get_json(f"{SPOTIFY_SEARCH_URL}?{query}")
    items = (payload.get("tracks") or {}).get("items") or []
    expected_name = comparable_name(artist_name)

    matching = []
    for item in items:
        item_artists = item.get("artists") or []
        if any(spotify_artist.get("id") == artist_id for spotify_artist in item_artists) or any(
            comparable_name(spotify_artist.get("name", "")) == expected_name for spotify_artist in item_artists
        ):
            matching.append(item)

    matching.sort(key=lambda track: int(track.get("popularity") or 0), reverse=True)

    seen = set()
    tracks = []
    for track in matching:
        uri = track.get("uri")
        if not uri or uri in seen:
            continue
        seen.add(uri)
        tracks.append(track_summary(track))
        if len(tracks) == 5:
            break

    return tracks


def clean_playlist_text(value, fallback):
    if not isinstance(value, str):
        return fallback
    value = " ".join(value.strip().split())
    return value[:180] if value else fallback


def build_playlist_name(event_name, event_dates):
    date_text = ", ".join(event_dates[:2]) if event_dates else ""
    if event_name and date_text:
        return f"{event_name} - {date_text}"
    if event_name:
        return f"{event_name} artists"
    if date_text:
        return f"Concert artists - {date_text}"
    return "Concert artist discoveries"


def validate_playlist_cover_image(value):
    if not value:
        return None
    if not isinstance(value, str):
        raise AppError("Playlist cover image must be base64 JPEG data.")

    value = value.strip()
    if value.startswith("data:image/jpeg;base64,"):
        value = value.split(",", 1)[1]
    value = "".join(value.split())

    if not value:
        return None
    if len(value.encode("ascii", errors="ignore")) > 256 * 1024:
        raise AppError("Playlist cover image is too large. Spotify allows base64 JPEG payloads up to 256 KB.")

    try:
        image_bytes = base64.b64decode(value, validate=True)
    except binascii.Error as exc:
        raise AppError("Playlist cover image must be valid base64 JPEG data.") from exc

    if not image_bytes.startswith(b"\xff\xd8"):
        raise AppError("Playlist cover image must be a JPEG.")

    return value


def create_playlist_from_payload(payload, session_id):
    if not payload.get("confirmed"):
        raise AppError("Confirm playlist creation before sending the request.")

    approved_artists = payload.get("approved_artists")
    if not isinstance(approved_artists, list) or not approved_artists:
        raise AppError("Approve at least one Spotify-verified artist before creating a playlist.")

    event_name = optional_string(payload.get("event_name"))
    event_dates = unique_strings(payload.get("event_dates"))
    playlist_name = clean_playlist_text(payload.get("playlist_name"), build_playlist_name(event_name, event_dates))
    playlist_cover_image = validate_playlist_cover_image(payload.get("playlist_cover_image"))

    tracks_by_artist = []
    track_uris = []
    seen_uris = set()
    for artist in approved_artists:
        if not isinstance(artist, dict):
            continue
        tracks = search_top_tracks_for_artist(artist)
        tracks_by_artist.append(
            {
                "artist": artist.get("name") or artist.get("input_name") or "Unknown artist",
                "spotify_id": artist.get("spotify_id") or artist.get("id"),
                "tracks": tracks,
            }
        )
        for track in tracks:
            uri = track.get("uri")
            if uri and uri not in seen_uris:
                seen_uris.add(uri)
                track_uris.append(uri)

    if not track_uris:
        raise AppError("No Spotify tracks were found for the approved artists.")

    profile = spotify_user_request_json(session_id, "GET", "/me")
    user_id = profile.get("id")
    if not user_id:
        raise AppError("Could not determine the current Spotify user.", HTTPStatus.BAD_GATEWAY)

    artist_names = [artist.get("name") or artist.get("input_name") for artist in approved_artists if isinstance(artist, dict)]
    description = clean_playlist_text(
        f"Generated from a concert image. Event: {event_name or 'Unknown'}; dates: {', '.join(event_dates) or 'Unknown'}; artists: {', '.join(name for name in artist_names if name)}.",
        "Generated from a concert image.",
    )
    playlist = spotify_user_request_json(
        session_id,
        "POST",
        f"/users/{quote(user_id, safe='')}/playlists",
        payload={
            "name": playlist_name,
            "public": spotify_playlist_public(),
            "description": description,
        },
    )
    playlist_id = playlist.get("id")
    if not playlist_id:
        raise AppError("Spotify did not return a playlist ID.", HTTPStatus.BAD_GATEWAY)

    for index in range(0, len(track_uris), 100):
        spotify_user_request_json(
            session_id,
            "POST",
            f"/playlists/{quote(playlist_id, safe='')}/items",
            payload={"uris": track_uris[index : index + 100]},
        )

    cover_uploaded = False
    cover_error = None
    if playlist_cover_image:
        try:
            spotify_user_request_raw(
                session_id,
                "PUT",
                f"/playlists/{quote(playlist_id, safe='')}/images",
                playlist_cover_image,
                "image/jpeg",
            )
            cover_uploaded = True
        except AppError as exc:
            cover_error = str(exc)

    return {
        "playlist": {
            "id": playlist_id,
            "name": playlist.get("name") or playlist_name,
            "url": (playlist.get("external_urls") or {}).get("spotify"),
            "uri": playlist.get("uri"),
            "track_count": len(track_uris),
            "public": spotify_playlist_public(),
            "cover_uploaded": cover_uploaded,
            "cover_error": cover_error,
        },
        "event_name": event_name,
        "event_dates": event_dates,
        "approved_artists": approved_artists,
        "tracks_by_artist": tracks_by_artist,
    }


def analyze(fields):
    get_spotify_token()
    image_bytes, mime_type = extract_image_from_form(fields)
    raw_response = call_gemini(image_bytes, mime_type)
    result = normalize_result(raw_response)
    spotify_checked, verified_artists = spotify_check_artists(result["artists"], result["unclear"])
    has_unverified = any(check["status"] != "verified" for check in spotify_checked)

    return {
        **result,
        "spotify_checked": spotify_checked,
        "spotify_verified_artists": verified_artists,
        "needs_verification": result["needs_verification"] or has_unverified,
    }


def redact_secret(value):
    return re.sub(r"([?&]key=)[^&]+", r"\1REDACTED", value)


class Handler(BaseHTTPRequestHandler):
    server_version = "ConcertArtistMVP/0.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def spotify_session_id(self):
        return parse_cookies(self.headers.get("Cookie", "")).get("spotify_session")

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/spotify/auth-status":
            try:
                self.send_json(spotify_auth_status(self.spotify_session_id()))
            except AppError as exc:
                self.send_json({"error": str(exc)}, status=exc.status)
            return

        if parsed.path == "/api/spotify/login":
            try:
                self.send_redirect(build_spotify_login_url())
            except AppError as exc:
                self.send_html(f"<h1>Spotify Login Error</h1><p>{str(exc)}</p>", status=exc.status)
            return

        if parsed.path == "/api/spotify/search-artist":
            self.handle_spotify_artist_search(parsed)
            return

        if parsed.path == "/callback":
            self.handle_spotify_callback(parsed)
            return

        self.serve_static(head_only=False)

    def do_HEAD(self):
        self.serve_static(head_only=True)

    def serve_static(self, head_only=False):
        if self.path == "/" or self.path.startswith("/?"):
            self.serve_file(ROOT / "index.html", "text/html; charset=utf-8", head_only=head_only)
            return

        if self.path.startswith("/static/"):
            relative = self.path.split("?", 1)[0].removeprefix("/static/")
            candidate = (STATIC_ROOT / relative).resolve()
            if not str(candidate).startswith(str(STATIC_ROOT.resolve())) or not candidate.exists():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            mime_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            self.serve_file(candidate, mime_type, head_only=head_only)
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/analyze":
            self.handle_analyze()
            return

        if parsed.path == "/api/spotify/create-playlist":
            self.handle_create_playlist()
            return

        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_analyze(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                raise AppError("Request body is empty.")
            if content_length > MAX_REQUEST_BYTES:
                raise AppError(f"Request is too large. Limit is {MAX_REQUEST_BYTES // (1024 * 1024)} MB.")

            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                raise AppError("Expected multipart/form-data.")

            body = self.rfile.read(content_length)
            fields = parse_multipart(content_type, body)
            result = analyze(fields)
            self.send_json(result)
        except AppError as exc:
            self.send_json({"error": str(exc)}, status=exc.status)
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Unexpected server error."}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_create_playlist(self):
        try:
            session_id = self.spotify_session_id()
            if not session_id:
                raise AppError("Sign in with Spotify before creating a playlist.", HTTPStatus.UNAUTHORIZED)

            content_length = int(self.headers.get("Content-Length", "0"))
            if content_length <= 0:
                raise AppError("Request body is empty.")
            if content_length > MAX_REQUEST_BYTES:
                raise AppError(f"Request is too large. Limit is {MAX_REQUEST_BYTES // (1024 * 1024)} MB.")

            body = self.rfile.read(content_length)
            try:
                payload = json.loads(body.decode("utf-8"))
            except json.JSONDecodeError as exc:
                raise AppError("Expected JSON body.") from exc

            result = create_playlist_from_payload(payload, session_id)
            self.send_json(result)
        except AppError as exc:
            response = {"error": str(exc)}
            if exc.status == HTTPStatus.UNAUTHORIZED:
                response["login_url"] = "/api/spotify/login"
            self.send_json(response, status=exc.status)
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Unexpected server error."}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_spotify_artist_search(self, parsed):
        try:
            query = parse_qs(parsed.query)
            name = (query.get("q") or [""])[0]
            limit = int((query.get("limit") or ["8"])[0])
            self.send_json(
                {
                    "query": name,
                    "artists": search_spotify_artist_candidates(name, limit=limit),
                }
            )
        except ValueError:
            self.send_json({"error": "Search limit must be a number."}, status=HTTPStatus.BAD_REQUEST)
        except AppError as exc:
            self.send_json({"error": str(exc)}, status=exc.status)
        except Exception:
            traceback.print_exc()
            self.send_json({"error": "Unexpected server error."}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_spotify_callback(self, parsed):
        query = parse_qs(parsed.query)
        if query.get("error"):
            self.send_html("<h1>Spotify Login Cancelled</h1><p>You can close this page and return to the app.</p>")
            return

        state = (query.get("state") or [""])[0]
        code = (query.get("code") or [""])[0]
        state_data = SPOTIFY_OAUTH_STATES.pop(state, None)
        if not code or not state_data or state_data.get("expires_at", 0) <= time.time():
            self.send_html("<h1>Spotify Login Error</h1><p>The authorization state was missing or expired. Return to the app and try again.</p>", status=HTTPStatus.BAD_REQUEST)
            return

        try:
            token_payload = exchange_spotify_code(code)
            session_id = create_spotify_user_session(token_payload)
        except AppError as exc:
            self.send_html(f"<h1>Spotify Login Error</h1><p>{str(exc)}</p>", status=exc.status)
            return

        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", "/?spotify=connected")
        self.send_header("Set-Cookie", f"spotify_session={session_id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000")
        self.end_headers()

    def serve_file(self, path, mime_type, head_only=False):
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def send_redirect(self, location):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.end_headers()

    def send_html(self, html, status=HTTPStatus.OK):
        data = f"<!doctype html><html><body>{html}</body></html>".encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    load_dotenv()
    host = os.getenv("HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("PORT", str(DEFAULT_PORT)))
    server = ThreadingHTTPServer((host, port), Handler)
    display_host = "127.0.0.1" if host == "0.0.0.0" else host
    print(f"Concert Artist MVP running at http://{display_host}:{port}")
    if host == "0.0.0.0":
        print("Server is listening on all network interfaces.")
    print(f"Gemini model: {os.getenv('GEMINI_MODEL', DEFAULT_MODEL)}")
    if not os.getenv("GEMINI_API_KEY"):
        print("GEMINI_API_KEY is not set yet. Add it to .env before analyzing images.")
    if not os.getenv("SPOTIFY_CLIENT_ID") or not os.getenv("SPOTIFY_CLIENT_SECRET"):
        print("Spotify credentials are not set yet. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env.")
    server.serve_forever()


if __name__ == "__main__":
    main()
