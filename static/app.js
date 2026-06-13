const form = document.querySelector("#analyzeForm");
const imageInput = document.querySelector("#imageInput");
const imageUrl = document.querySelector("#imageUrl");
const previewImage = document.querySelector("#previewImage");
const previewEmpty = document.querySelector("#previewEmpty");
const fileMeta = document.querySelector("#fileMeta");
const statusPill = document.querySelector("#statusPill");
const analyzeButton = document.querySelector("#analyzeButton");
const copyButton = document.querySelector("#copyButton");
const jsonBox = document.querySelector("#jsonBox");
const artistChips = document.querySelector("#artistChips");
const unclearChips = document.querySelector("#unclearChips");
const spotifyList = document.querySelector("#spotifyList");
const reviewMeta = document.querySelector("#reviewMeta");
const eventMeta = document.querySelector("#eventMeta");
const eventNameInput = document.querySelector("#eventNameInput");
const eventDatesInput = document.querySelector("#eventDatesInput");
const playlistNameInput = document.querySelector("#playlistNameInput");
const spotifyAuthLabel = document.querySelector("#spotifyAuthLabel");
const spotifyLoginButton = document.querySelector("#spotifyLoginButton");
const createPlaylistButton = document.querySelector("#createPlaylistButton");
const playlistStatus = document.querySelector("#playlistStatus");
const confirmDialog = document.querySelector("#confirmDialog");
const confirmDetails = document.querySelector("#confirmDetails");
const confirmCreateButton = document.querySelector("#confirmCreateButton");
const dropZone = document.querySelector("#dropZone");

let activeMode = "upload";
let playlistNameTouched = false;
let spotifyAuth = { authenticated: false, login_url: "/api/spotify/login", redirect_uri: "", user: null };
let currentPlaylistResult = null;
let currentTracksByArtist = [];
let currentAnalysis = {
  artists: [],
  unclear: [],
  event_name: null,
  event_dates: [],
  needs_verification: false,
  spotify_checked: [],
  spotify_verified_artists: [],
};
let decisions = new Map();
let currentFinalResult = buildFinalResult();

function setMode(mode) {
  activeMode = mode;
  document.querySelectorAll(".segment").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll(".source").forEach((source) => {
    source.classList.toggle("active", source.dataset.source === mode);
  });
  updatePreview();
}

function setStatus(text, state = "idle") {
  statusPill.textContent = text;
  statusPill.dataset.state = state;
}

function updatePreview() {
  previewImage.removeAttribute("src");
  previewImage.classList.remove("visible");
  previewEmpty.classList.remove("hidden");

  if (activeMode === "upload") {
    const file = imageInput.files?.[0];
    if (!file) {
      fileMeta.textContent = "JPEG, PNG, WebP, HEIC, HEIF";
      return;
    }

    fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
    previewImage.src = URL.createObjectURL(file);
    previewImage.classList.add("visible");
    previewEmpty.classList.add("hidden");
    return;
  }

  const url = imageUrl.value.trim();
  if (url) {
    previewImage.src = url;
    previewImage.classList.add("visible");
    previewEmpty.classList.add("hidden");
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function splitDates(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function renderChips(target, values, emptyText) {
  target.replaceChildren();

  if (!values.length) {
    const empty = document.createElement("span");
    empty.className = "empty-chip";
    empty.textContent = emptyText;
    target.append(empty);
    return;
  }

  values.forEach((value) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = value;
    target.append(chip);
  });
}

function normalizeCheck(check) {
  return {
    input_name: check.input_name || "",
    source: check.source || "artists",
    status: check.status || "not_found",
    spotify: check.spotify || null,
    alternatives: Array.isArray(check.alternatives) ? check.alternatives : [],
  };
}

function suggestPlaylistName(eventName, eventDates) {
  const dateText = eventDates.slice(0, 2).join(", ");
  if (eventName && dateText) return `${eventName} - ${dateText}`;
  if (eventName) return `${eventName} artists`;
  if (dateText) return `Concert artists - ${dateText}`;
  return "Concert artist discoveries";
}

function renderResult(result) {
  currentPlaylistResult = null;
  currentTracksByArtist = [];
  currentAnalysis = {
    artists: Array.isArray(result.artists) ? result.artists : [],
    unclear: Array.isArray(result.unclear) ? result.unclear : [],
    event_name: typeof result.event_name === "string" ? result.event_name : null,
    event_dates: Array.isArray(result.event_dates) ? result.event_dates : [],
    needs_verification: Boolean(result.needs_verification),
    spotify_checked: Array.isArray(result.spotify_checked) ? result.spotify_checked.map(normalizeCheck) : [],
    spotify_verified_artists: Array.isArray(result.spotify_verified_artists) ? result.spotify_verified_artists : [],
  };

  decisions = new Map();
  currentAnalysis.spotify_checked.forEach((check, index) => {
    decisions.set(String(index), check.status === "verified" ? "pending" : "unverified");
  });

  playlistNameTouched = false;
  eventNameInput.value = currentAnalysis.event_name || "";
  eventDatesInput.value = currentAnalysis.event_dates.join(", ");
  playlistNameInput.value = suggestPlaylistName(eventNameInput.value.trim(), splitDates(eventDatesInput.value));
  playlistStatus.textContent = "Approve Spotify-verified artists to create a playlist.";

  renderChips(artistChips, currentAnalysis.artists, "None");
  renderChips(unclearChips, currentAnalysis.unclear, "None");
  renderEventSummary();
  renderSpotifyReview();
  renderFinalJson();
  copyButton.disabled = !currentAnalysis.spotify_checked.length;
}

function renderEventSummary() {
  const eventName = eventNameInput.value.trim();
  const eventDates = splitDates(eventDatesInput.value);
  eventMeta.textContent = eventName || eventDates.length ? "Visible in playlist name" : "Not detected";
  if (!playlistNameTouched) {
    playlistNameInput.value = suggestPlaylistName(eventName, eventDates);
  }
}

function renderSpotifyReview() {
  spotifyList.replaceChildren();

  const verifiedCount = currentAnalysis.spotify_checked.filter((check) => check.status === "verified").length;
  const unverifiedCount = currentAnalysis.spotify_checked.length - verifiedCount;
  reviewMeta.textContent = currentAnalysis.spotify_checked.length
    ? `${verifiedCount} verified · ${unverifiedCount} unverified`
    : "No Spotify checks yet";

  if (!currentAnalysis.spotify_checked.length) {
    const empty = document.createElement("div");
    empty.className = "review-empty";
    empty.textContent = "Run analysis to review Spotify matches.";
    spotifyList.append(empty);
    return;
  }

  currentAnalysis.spotify_checked.forEach((check, index) => {
    spotifyList.append(createSpotifyRow(check, index));
  });
}

function createSpotifyRow(check, index) {
  const decision = decisions.get(String(index)) || "pending";
  const row = document.createElement("div");
  row.className = `spotify-row ${check.status} ${decision}`;
  row.dataset.index = String(index);

  const artwork = document.createElement("div");
  artwork.className = "artist-artwork";
  if (check.spotify?.image_url) {
    const image = document.createElement("img");
    image.src = check.spotify.image_url;
    image.alt = "";
    artwork.append(image);
  } else {
    artwork.textContent = (check.spotify?.name || check.input_name || "?").slice(0, 1).toUpperCase();
  }

  const details = document.createElement("div");
  details.className = "artist-details";

  const title = document.createElement("div");
  title.className = "artist-title";
  title.textContent = check.spotify?.name || check.input_name || "Unknown";
  details.append(title);

  const meta = document.createElement("div");
  meta.className = "artist-meta";
  const parts = [`from ${check.source}`, `read as "${check.input_name}"`];
  if (typeof check.spotify?.popularity === "number") {
    parts.push(`popularity ${check.spotify.popularity}`);
  }
  meta.textContent = parts.join(" · ");
  details.append(meta);

  if (check.status !== "verified" && check.alternatives.length) {
    const alternatives = document.createElement("div");
    alternatives.className = "artist-alternatives";
    alternatives.textContent = `Closest Spotify results: ${check.alternatives.map((item) => item.name).filter(Boolean).join(", ")}`;
    details.append(alternatives);
  }

  const actions = document.createElement("div");
  actions.className = "artist-actions";

  if (check.status === "verified") {
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "decision-button approve";
    approve.dataset.action = "approved";
    approve.textContent = "Approve";

    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "decision-button decline";
    decline.dataset.action = "declined";
    decline.textContent = "Decline";

    actions.append(approve, decline);
  } else {
    const badge = document.createElement("span");
    badge.className = "unverified-badge";
    badge.textContent = "Not verified";
    actions.append(badge);
  }

  if (check.spotify?.url) {
    const link = document.createElement("a");
    link.className = "spotify-link";
    link.href = check.spotify.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Spotify";
    actions.append(link);
  }

  row.append(artwork, details, actions);
  return row;
}

function buildFinalResult() {
  const eventName = eventNameInput?.value.trim() || "";
  const eventDates = eventDatesInput ? splitDates(eventDatesInput.value) : [];
  const playlistName = playlistNameInput?.value.trim() || suggestPlaylistName(eventName, eventDates);

  const approvedChecks = (currentAnalysis.spotify_checked || []).filter((check, index) => {
    return check.status === "verified" && decisions.get(String(index)) === "approved" && check.spotify;
  });

  const rejected = (currentAnalysis.spotify_checked || []).filter((check, index) => {
    return check.status === "verified" && decisions.get(String(index)) === "declined";
  });

  const pending = (currentAnalysis.spotify_checked || []).filter((check, index) => {
    return check.status === "verified" && decisions.get(String(index)) === "pending";
  });

  const unverified = (currentAnalysis.spotify_checked || []).filter((check) => check.status !== "verified");

  const result = {
    event_name: eventName || null,
    event_dates: eventDates,
    playlist_name: playlistName,
    artists: approvedChecks.map((check) => check.spotify.name),
    approved_artists: approvedChecks.map((check) => ({
      name: check.spotify.name,
      spotify_id: check.spotify.id,
      spotify_url: check.spotify.url,
      input_name: check.input_name,
      source: check.source,
    })),
    analyzed_artists: currentAnalysis.artists || [],
    unclear: currentAnalysis.unclear || [],
    rejected: rejected.map((check) => check.spotify?.name || check.input_name),
    pending_review: pending.map((check) => check.spotify?.name || check.input_name),
    unverified: unverified.map((check) => ({
      input_name: check.input_name,
      source: check.source,
      alternatives: check.alternatives.map((item) => item.name).filter(Boolean),
    })),
    needs_verification: Boolean(currentAnalysis.needs_verification || pending.length || unverified.length),
  };

  if (currentPlaylistResult) {
    result.playlist = currentPlaylistResult;
    result.tracks_by_artist = currentTracksByArtist;
  }

  return result;
}

function renderFinalJson() {
  currentFinalResult = buildFinalResult();
  jsonBox.textContent = JSON.stringify(currentFinalResult, null, 2);
  updatePlaylistControls();

  const pendingCount = currentFinalResult.pending_review.length;
  if (pendingCount) {
    setStatus(`${pendingCount} pending`, "warn");
    return;
  }

  if (currentFinalResult.needs_verification) {
    setStatus("Needs verification", "warn");
    return;
  }

  setStatus("Done", "ok");
}

function updatePlaylistControls() {
  const hasApproved = currentFinalResult.approved_artists.length > 0;
  const hasPending = currentFinalResult.pending_review.length > 0;
  createPlaylistButton.disabled = !spotifyAuth.authenticated || !hasApproved || hasPending || Boolean(currentPlaylistResult);

  if (currentPlaylistResult?.url) {
    playlistStatus.innerHTML = `<a href="${currentPlaylistResult.url}" target="_blank" rel="noreferrer">Open playlist on Spotify</a>`;
    return;
  }

  if (!spotifyAuth.authenticated) {
    playlistStatus.textContent = "Sign in with Spotify before creating a playlist.";
    return;
  }

  if (hasPending) {
    playlistStatus.textContent = "Approve or decline all Spotify matches first.";
    return;
  }

  if (!hasApproved) {
    playlistStatus.textContent = "Approve Spotify-verified artists to create a playlist.";
    return;
  }

  playlistStatus.textContent = "Ready to create a playlist with up to 5 popular tracks per approved artist.";
}

async function refreshSpotifyAuthStatus() {
  try {
    const response = await fetch("/api/spotify/auth-status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not check Spotify login.");

    spotifyAuth = data;
    spotifyAuthLabel.textContent = data.authenticated
      ? `Connected as ${data.user?.display_name || data.user?.id || "Spotify user"}`
      : "Not connected";
    spotifyLoginButton.textContent = data.authenticated ? "Reconnect" : "Sign In";
  } catch (error) {
    spotifyAuth = { authenticated: false, login_url: "/api/spotify/login", redirect_uri: "", user: null };
    spotifyAuthLabel.textContent = error.message;
  }

  updatePlaylistControls();
}

function validateInput() {
  if (activeMode === "upload") {
    if (!imageInput.files?.[0]) {
      throw new Error("Choose an image file.");
    }
    return;
  }

  if (!imageUrl.value.trim()) {
    throw new Error("Enter an image URL.");
  }
}

async function analyze(event) {
  event.preventDefault();

  try {
    validateInput();
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  const body = new FormData();
  if (activeMode === "upload") {
    body.append("image", imageInput.files[0]);
  } else {
    body.append("image_url", imageUrl.value.trim());
  }

  analyzeButton.disabled = true;
  copyButton.disabled = true;
  currentPlaylistResult = null;
  currentTracksByArtist = [];
  setStatus("Analyzing", "busy");

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      body,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Analysis failed.");
    }

    renderResult(data);
  } catch (error) {
    setStatus(error.message, "error");
    jsonBox.textContent = JSON.stringify({ error: error.message }, null, 2);
  } finally {
    analyzeButton.disabled = false;
  }
}

function openConfirmDialog() {
  currentFinalResult = buildFinalResult();

  if (!spotifyAuth.authenticated) {
    window.location.href = spotifyAuth.login_url || "/api/spotify/login";
    return;
  }

  if (!currentFinalResult.approved_artists.length) {
    setStatus("Approve artists first", "error");
    return;
  }

  if (currentFinalResult.pending_review.length) {
    setStatus("Review pending artists", "error");
    return;
  }

  const artistNames = currentFinalResult.approved_artists.map((artist) => artist.name).join(", ");
  confirmDetails.innerHTML = `
    <dl>
      <dt>Playlist</dt>
      <dd>${escapeHtml(currentFinalResult.playlist_name)}</dd>
      <dt>Event</dt>
      <dd>${escapeHtml(currentFinalResult.event_name || "Unknown")}</dd>
      <dt>Date</dt>
      <dd>${escapeHtml(currentFinalResult.event_dates.join(", ") || "Unknown")}</dd>
      <dt>Artists</dt>
      <dd>${escapeHtml(artistNames)}</dd>
      <dt>Tracks</dt>
      <dd>Up to 5 popular Spotify tracks per approved artist</dd>
    </dl>
  `;

  if (typeof confirmDialog.showModal === "function") {
    confirmDialog.showModal();
  } else {
    confirmDialog.setAttribute("open", "");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function createPlaylist() {
  currentFinalResult = buildFinalResult();
  confirmCreateButton.disabled = true;
  createPlaylistButton.disabled = true;
  playlistStatus.textContent = "Creating playlist";
  setStatus("Creating playlist", "busy");

  try {
    const response = await fetch("/api/spotify/create-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        event_name: currentFinalResult.event_name,
        event_dates: currentFinalResult.event_dates,
        playlist_name: currentFinalResult.playlist_name,
        approved_artists: currentFinalResult.approved_artists,
      }),
    });
    const data = await response.json();

    if (response.status === 401 && data.login_url) {
      window.location.href = data.login_url;
      return;
    }

    if (!response.ok) {
      throw new Error(data.error || "Could not create playlist.");
    }

    currentPlaylistResult = data.playlist;
    currentTracksByArtist = data.tracks_by_artist || [];
    if (confirmDialog.open) confirmDialog.close();
    renderFinalJson();
    setStatus("Playlist created", "ok");
  } catch (error) {
    setStatus(error.message, "error");
    playlistStatus.textContent = error.message;
    updatePlaylistControls();
  } finally {
    confirmCreateButton.disabled = false;
  }
}

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

spotifyList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  const row = event.target.closest(".spotify-row");
  if (!button || !row) return;

  decisions.set(row.dataset.index, button.dataset.action);
  currentPlaylistResult = null;
  currentTracksByArtist = [];
  renderSpotifyReview();
  renderFinalJson();
});

spotifyLoginButton.addEventListener("click", () => {
  window.location.href = spotifyAuth.login_url || "/api/spotify/login";
});

eventNameInput.addEventListener("input", () => {
  renderEventSummary();
  renderFinalJson();
});

eventDatesInput.addEventListener("input", () => {
  renderEventSummary();
  renderFinalJson();
});

playlistNameInput.addEventListener("input", () => {
  playlistNameTouched = true;
  renderFinalJson();
});

createPlaylistButton.addEventListener("click", openConfirmDialog);
confirmCreateButton.addEventListener("click", createPlaylist);

imageInput.addEventListener("change", updatePreview);
imageUrl.addEventListener("input", updatePreview);
form.addEventListener("submit", analyze);

copyButton.addEventListener("click", async () => {
  await navigator.clipboard.writeText(JSON.stringify(currentFinalResult, null, 2));
  setStatus("Copied", "ok");
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  const file = event.dataTransfer.files?.[0];
  if (!file) return;

  const transfer = new DataTransfer();
  transfer.items.add(file);
  imageInput.files = transfer.files;
  updatePreview();
});

renderResult(currentAnalysis);
setStatus("Ready");
refreshSpotifyAuthStatus();
