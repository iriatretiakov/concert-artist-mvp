const form = document.querySelector("#analyzeForm");
const imageInput = document.querySelector("#imageInput");
const imageUrl = document.querySelector("#imageUrl");
const previewImage = document.querySelector("#previewImage");
const previewEmpty = document.querySelector("#previewEmpty");
const fileMeta = document.querySelector("#fileMeta");
const pasteImageButton = document.querySelector("#pasteImageButton");
const pasteHint = document.querySelector("#pasteHint");
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
const manualArtistInput = document.querySelector("#manualArtistInput");
const manualArtistSearchButton = document.querySelector("#manualArtistSearchButton");
const manualArtistStatus = document.querySelector("#manualArtistStatus");
const manualArtistResultsEl = document.querySelector("#manualArtistResults");
const coverTooltipImage = document.querySelector("#coverTooltipImage");
const coverTooltipText = document.querySelector("#coverTooltipText");
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
let manualArtistMatches = [];
let latestCoverPreviewDataUrl = "";
let fallbackCoverDataUrl = "";
let spotifyAuth = { authenticated: false, login_url: "/api/spotify/login", redirect_uri: "", cover_scope_granted: false, user: null };
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

function generateFallbackCover() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) return "";

  const gradient = context.createLinearGradient(0, 0, 512, 512);
  gradient.addColorStop(0, "#16110e");
  gradient.addColorStop(0.42, "#d82231");
  gradient.addColorStop(1, "#f1b51c");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);

  context.globalAlpha = 0.42;
  for (let index = 0; index < 12; index += 1) {
    const x = 24 + index * 42;
    context.fillStyle = index % 2 ? "#fffaf0" : "#15110e";
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + 72, 0);
    context.lineTo(280 + Math.sin(index) * 120, 330);
    context.closePath();
    context.fill();
  }

  context.globalAlpha = 1;
  context.fillStyle = "rgba(21, 17, 14, 0.72)";
  context.fillRect(0, 318, 512, 194);
  context.fillStyle = "#fffaf0";
  for (let index = 0; index < 34; index += 1) {
    const x = index * 16 - 8;
    const height = 34 + ((index * 17) % 42);
    context.beginPath();
    context.arc(x + 8, 340 + ((index * 9) % 18), 7 + (index % 4), 0, Math.PI * 2);
    context.fill();
    context.fillRect(x + 3, 350, 10, height);
  }

  context.fillStyle = "#15110e";
  context.fillRect(136, 190, 240, 72);
  context.fillStyle = "#fffaf0";
  context.fillRect(152, 204, 208, 44);
  context.fillStyle = "#d82231";
  context.fillRect(172, 218, 168, 16);

  return canvas.toDataURL("image/jpeg", 0.82);
}

function updateCoverTooltip(src = "", text = "") {
  const fallback = fallbackCoverDataUrl || "";
  coverTooltipImage.src = src || fallback;
  coverTooltipText.textContent = text || "A generated concert image is shown until a poster cover is ready.";
}

function updatePreview() {
  previewImage.removeAttribute("src");
  previewImage.removeAttribute("crossorigin");
  previewImage.classList.remove("visible");
  previewEmpty.classList.remove("hidden");
  latestCoverPreviewDataUrl = "";
  updateCoverTooltip("", "Upload a poster to use it as the playlist cover.");

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
    updateCoverTooltip(previewImage.src, "This poster will be converted into the Spotify playlist cover.");
    return;
  }

  const url = imageUrl.value.trim();
  if (url) {
    previewImage.src = url;
    previewImage.classList.add("visible");
    previewEmpty.classList.add("hidden");
    updateCoverTooltip(url, "This URL poster will be used when the browser can read it safely.");
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionForMimeType(mimeType) {
  const normalized = (mimeType || "").toLowerCase();
  if (normalized.includes("jpeg")) return "jpg";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("heic")) return "heic";
  if (normalized.includes("heif")) return "heif";
  return "png";
}

function isSupportedImageFile(file) {
  if (!file) return false;
  if ((file.type || "").startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || "");
}

function normalizeClipboardFile(file) {
  if (file.name) return file;
  const extension = extensionForMimeType(file.type);
  return new File([file], `clipboard-poster.${extension}`, {
    type: file.type || "image/png",
    lastModified: Date.now(),
  });
}

function setUploadedImageFile(file, sourceLabel = "Clipboard") {
  if (!isSupportedImageFile(file)) {
    throw new Error("Clipboard does not contain a supported image.");
  }

  const normalizedFile = normalizeClipboardFile(file);
  const transfer = new DataTransfer();
  transfer.items.add(normalizedFile);
  imageInput.files = transfer.files;
  imageUrl.value = "";

  if (activeMode !== "upload") {
    setMode("upload");
  } else {
    updatePreview();
  }

  setStatus(`${sourceLabel} image ready`, "ok");
  pasteHint.textContent = `${normalizedFile.name} · ${formatBytes(normalizedFile.size)}`;
}

function imageFileFromDataTransfer(items) {
  for (const item of Array.from(items || [])) {
    if (item.kind === "file" && (item.type || "").startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
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

function normalizeSpotifyArtist(artist) {
  const images = Array.isArray(artist.images) ? artist.images : [];
  return {
    id: artist.id || "",
    name: artist.name || "",
    url: artist.url || artist.spotify_url || artist.external_url || artist.external_urls?.spotify || "",
    uri: artist.uri || "",
    genres: Array.isArray(artist.genres) ? artist.genres : [],
    popularity: typeof artist.popularity === "number" ? artist.popularity : null,
    followers: typeof artist.followers === "number" ? artist.followers : artist.followers?.total || null,
    image_url: artist.image_url || images[0]?.url || null,
  };
}

function comparableName(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replaceAll("&", "and")
    .replace(/[^\p{Letter}\p{Number}]/gu, "");
}

function artistAlreadyChecked(artist) {
  const spotifyId = artist.id;
  const nameKey = comparableName(artist.name);
  return currentAnalysis.spotify_checked.some((check) => {
    if (spotifyId && check.spotify?.id === spotifyId) return true;
    return nameKey && comparableName(check.spotify?.name || check.input_name) === nameKey;
  });
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
  manualArtistMatches = [];
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
  manualArtistStatus.textContent = "Search Spotify";

  renderChips(artistChips, currentAnalysis.artists, "None");
  renderChips(unclearChips, currentAnalysis.unclear, "None");
  renderEventSummary();
  renderManualArtistMatches();
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

function renderManualArtistMatches() {
  manualArtistResultsEl.replaceChildren();

  if (!manualArtistMatches.length) {
    return;
  }

  manualArtistMatches.forEach((artist, index) => {
    const row = document.createElement("div");
    row.className = "manual-result-row";

    const artwork = document.createElement("div");
    artwork.className = "artist-artwork";
    if (artist.image_url) {
      const image = document.createElement("img");
      image.src = artist.image_url;
      image.alt = "";
      artwork.append(image);
    } else {
      artwork.textContent = (artist.name || "?").slice(0, 1).toUpperCase();
    }

    const details = document.createElement("div");
    details.className = "artist-details";

    const title = document.createElement("div");
    title.className = "artist-title";
    title.textContent = artist.name || "Unknown";
    details.append(title);

    const meta = document.createElement("div");
    meta.className = "artist-meta";
    const metaParts = [];
    if (typeof artist.popularity === "number") metaParts.push(`popularity ${artist.popularity}`);
    if (typeof artist.followers === "number") metaParts.push(`${new Intl.NumberFormat().format(artist.followers)} followers`);
    if (artist.genres?.length) metaParts.push(artist.genres.slice(0, 2).join(", "));
    meta.textContent = metaParts.join(" · ") || "Spotify artist";
    details.append(meta);

    const actions = document.createElement("div");
    actions.className = "artist-actions";
    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "decision-button approve";
    addButton.dataset.manualIndex = String(index);
    addButton.textContent = artistAlreadyChecked(artist) ? "Added" : "Add";
    addButton.disabled = artistAlreadyChecked(artist);
    actions.append(addButton);

    row.append(artwork, details, actions);
    manualArtistResultsEl.append(row);
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

async function searchManualArtist() {
  const query = manualArtistInput.value.trim();
  manualArtistMatches = [];
  renderManualArtistMatches();

  if (!query) {
    manualArtistStatus.textContent = "Enter an artist name";
    return;
  }

  manualArtistSearchButton.disabled = true;
  manualArtistStatus.textContent = "Searching";

  try {
    const response = await fetch(`/api/spotify/search-artist?q=${encodeURIComponent(query)}&limit=8`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Artist search failed.");

    manualArtistMatches = Array.isArray(data.artists) ? data.artists.map(normalizeSpotifyArtist).filter((artist) => artist.id && artist.name) : [];
    manualArtistStatus.textContent = manualArtistMatches.length
      ? `${manualArtistMatches.length} Spotify results`
      : "No Spotify results";
    renderManualArtistMatches();
  } catch (error) {
    manualArtistStatus.textContent = error.message;
  } finally {
    manualArtistSearchButton.disabled = false;
  }
}

function addManualArtist(index) {
  const artist = manualArtistMatches[index];
  if (!artist || artistAlreadyChecked(artist)) {
    renderManualArtistMatches();
    return;
  }

  const check = {
    input_name: manualArtistInput.value.trim() || artist.name,
    source: "manual",
    status: "verified",
    spotify: artist,
    alternatives: [],
  };

  currentAnalysis.spotify_checked.push(check);
  currentAnalysis.spotify_verified_artists.push(artist);
  decisions.set(String(currentAnalysis.spotify_checked.length - 1), "approved");
  currentPlaylistResult = null;
  currentTracksByArtist = [];
  manualArtistStatus.textContent = `${artist.name} added`;
  renderManualArtistMatches();
  renderSpotifyReview();
  renderFinalJson();
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
  copyButton.disabled = !currentAnalysis.spotify_checked.length;
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
  const needsCoverReconnect = spotifyAuth.authenticated && spotifyAuth.cover_scope_granted === false;
  createPlaylistButton.disabled = !spotifyAuth.authenticated || !hasApproved || hasPending || Boolean(currentPlaylistResult) || needsCoverReconnect;

  if (currentPlaylistResult?.url) {
    playlistStatus.replaceChildren();
    const link = document.createElement("a");
    link.href = currentPlaylistResult.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open playlist on Spotify";
    playlistStatus.append(link);
    if (currentPlaylistResult.cover_uploaded) {
      const sourceText = currentPlaylistResult.cover_source === "uploaded_poster" ? "uploaded poster" : "poster";
      playlistStatus.append(` · Cover added from ${sourceText}.`);
    } else if (currentPlaylistResult.cover_error) {
      playlistStatus.append(` · Cover skipped: ${currentPlaylistResult.cover_error}`);
    }
    return;
  }

  if (!spotifyAuth.authenticated) {
    playlistStatus.textContent = "Sign in with Spotify before creating a playlist.";
    return;
  }

  if (needsCoverReconnect) {
    playlistStatus.textContent = "Reconnect Spotify to allow poster covers.";
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

function hasPosterPreview() {
  if (activeMode === "upload") return Boolean(imageInput.files?.[0]);
  return Boolean(imageUrl.value.trim());
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not read the uploaded poster image."));
    };
    image.src = objectUrl;
  });
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the image URL for a playlist cover."));
    image.src = url;
  });
}

function drawCoverCanvas(image, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;

  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  if (!imageWidth || !imageHeight) return null;

  context.fillStyle = "#15110e";
  context.fillRect(0, 0, size, size);

  const backgroundScale = Math.max(size / imageWidth, size / imageHeight);
  const backgroundWidth = Math.round(imageWidth * backgroundScale);
  const backgroundHeight = Math.round(imageHeight * backgroundScale);
  const backgroundX = Math.round((size - backgroundWidth) / 2);
  const backgroundY = Math.round((size - backgroundHeight) / 2);
  context.save();
  context.filter = "blur(18px)";
  context.drawImage(image, backgroundX - 18, backgroundY - 18, backgroundWidth + 36, backgroundHeight + 36);
  context.restore();

  context.fillStyle = "rgba(21, 17, 14, 0.35)";
  context.fillRect(0, 0, size, size);

  const padding = Math.round(size * 0.07);
  const foregroundScale = Math.min((size - padding * 2) / imageWidth, (size - padding * 2) / imageHeight);
  const foregroundWidth = Math.round(imageWidth * foregroundScale);
  const foregroundHeight = Math.round(imageHeight * foregroundScale);
  const foregroundX = Math.round((size - foregroundWidth) / 2);
  const foregroundY = Math.round((size - foregroundHeight) / 2);

  context.shadowColor = "rgba(0, 0, 0, 0.36)";
  context.shadowBlur = Math.round(size * 0.035);
  context.shadowOffsetY = Math.round(size * 0.018);
  context.drawImage(image, foregroundX, foregroundY, foregroundWidth, foregroundHeight);
  context.shadowColor = "transparent";

  return canvas;
}

function encodeCoverCanvas(canvas) {
  const sizes = [640, 512, 384, 320];
  const qualities = [0.86, 0.76, 0.66, 0.56, 0.46];

  for (const size of sizes) {
    const scaled = document.createElement("canvas");
    scaled.width = size;
    scaled.height = size;
    const context = scaled.getContext("2d");
    if (!context) continue;
    context.drawImage(canvas, 0, 0, size, size);

    for (const quality of qualities) {
      const dataUrl = scaled.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.split(",", 2)[1] || "";
      if (base64 && base64.length <= 256 * 1024) {
        return { base64, dataUrl };
      }
    }
  }

  return null;
}

async function buildPlaylistCoverImage() {
  if (!hasPosterPreview()) {
    return null;
  }

  try {
    const sourceImage = activeMode === "upload"
      ? await loadImageFromFile(imageInput.files[0])
      : await loadImageFromUrl(imageUrl.value.trim());
    const canvas = drawCoverCanvas(sourceImage, 768);
    const encoded = canvas ? encodeCoverCanvas(canvas) : null;
    if (!encoded) return null;

    latestCoverPreviewDataUrl = encoded.dataUrl;
    updateCoverTooltip(encoded.dataUrl, "This exact poster cover will be sent to Spotify.");
    return {
      image: encoded.base64,
      source: activeMode === "upload" ? "uploaded_poster" : "url_poster",
    };
  } catch (error) {
    console.warn("Could not prepare playlist cover", error);
    updateCoverTooltip("", "Poster cover could not be prepared; the generated concert image is shown as a fallback.");
    return null;
  }
}

async function refreshSpotifyAuthStatus() {
  try {
    const response = await fetch("/api/spotify/auth-status");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not check Spotify login.");

    spotifyAuth = data;
    if (data.authenticated) {
      const userName = data.user?.display_name || data.user?.id || "Spotify user";
      spotifyAuthLabel.textContent = data.cover_scope_granted
        ? `Connected as ${userName}`
        : `Connected as ${userName}; reconnect for poster covers`;
    } else {
      spotifyAuthLabel.textContent = "Not connected";
    }
    spotifyLoginButton.textContent = data.authenticated ? "Reconnect" : "Sign In";
  } catch (error) {
    spotifyAuth = { authenticated: false, login_url: "/api/spotify/login", redirect_uri: "", cover_scope_granted: false, user: null };
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
  const coverText = activeMode === "upload" && imageInput.files?.[0]
    ? "Uploaded poster image"
    : imageUrl.value.trim()
      ? "URL poster image, if browser-readable"
      : "Not available";
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
      <dt>Cover</dt>
      <dd>${escapeHtml(coverText)}</dd>
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
    const playlistCover = await buildPlaylistCoverImage();
    const response = await fetch("/api/spotify/create-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed: true,
        event_name: currentFinalResult.event_name,
        event_dates: currentFinalResult.event_dates,
        playlist_name: currentFinalResult.playlist_name,
        approved_artists: currentFinalResult.approved_artists,
        playlist_cover_image: playlistCover?.image || null,
        playlist_cover_source: playlistCover?.source || null,
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

manualArtistSearchButton.addEventListener("click", searchManualArtist);

manualArtistInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  searchManualArtist();
});

manualArtistResultsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-manual-index]");
  if (!button) return;
  addManualArtist(Number(button.dataset.manualIndex));
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

pasteImageButton.addEventListener("click", async () => {
  if (!navigator.clipboard?.read) {
    setStatus("Paste unavailable", "warn");
    pasteHint.textContent = "Use the browser paste command.";
    return;
  }

  pasteImageButton.disabled = true;
  setStatus("Reading clipboard", "busy");

  try {
    const clipboardItems = await navigator.clipboard.read();
    for (const clipboardItem of clipboardItems) {
      const imageType = clipboardItem.types.find((type) => type.startsWith("image/"));
      if (!imageType) continue;
      const blob = await clipboardItem.getType(imageType);
      setUploadedImageFile(blob, "Clipboard");
      return;
    }

    setStatus("No image in clipboard", "warn");
    pasteHint.textContent = "Copy an image, then paste again.";
  } catch (error) {
    setStatus("Paste blocked", "warn");
    pasteHint.textContent = "Use the browser paste command.";
  } finally {
    pasteImageButton.disabled = false;
  }
});

document.addEventListener("paste", (event) => {
  const file = imageFileFromDataTransfer(event.clipboardData?.items);
  if (!file) return;

  event.preventDefault();
  try {
    setUploadedImageFile(file, "Pasted");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

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

  try {
    setUploadedImageFile(file, "Dropped");
  } catch (error) {
    setStatus(error.message, "error");
  }
});

fallbackCoverDataUrl = generateFallbackCover();
updateCoverTooltip();
renderResult(currentAnalysis);
setStatus("Ready");
refreshSpotifyAuthStatus();
