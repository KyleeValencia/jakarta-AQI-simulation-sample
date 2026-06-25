/* Jakarta AQI - static front-end (r7, NB8 contract).
 *
 * Consumes three static files from web/data (produced by build_web_data.py):
 *   meta.json           - resolution, model_status, anchor_date, slot_hours, horizons, legend, disclaimers
 *   forecast_r{R}.json  - { model_status, anchor_date, slot_hours, horizons_h,
 *                           cells: { h3_id: { slot_h: [ {offset_h, value, category, colour} ] } } }
 *                         (slot_h = a fixed clock slot; the page shows the slot nearest "now"
 *                          in WIB. A legacy flat { h3_id: [ series ] } is still accepted.)
 *   hexes_r{R}.geojson  - hex-cell polygons (+ h3_id, center_lat/lon)
 *
 * AQI scale, category and colour all come from meta (exported from aqi_models.physics),
 * so nothing about the scale is hardcoded here.
 *
 * Two states, driven by meta.model_status:
 *   "pending_retrain" - coming-soon: map + location tools work, but per-cell values
 *                       show an honest "awaiting model output" message.
 *   "live"            - real forecasts shown (value, category, diurnal chart).
 *
 * Date picker (archive):
 *   meta.archive = { start_date, end_date, path_pattern } tells the page the bounds and
 *   filename pattern of a separate set of already-built per-date forecast files
 *   (data/forecast_r{R}_{date}.json, same contract as the default forecast file). The
 *   "Today (live)" / "Pick a date" toggle swaps state.forecast between the live file
 *   loaded at boot and a lazily-fetched, cached archive date. Missing dates (some days
 *   in the archive may not exist) are handled with an inline message, not a crash.
 */

const JAKARTA_CENTER = [-6.2, 106.84];
const state = {
  meta: null,
  forecast: null,
  liveForecast: null, // the "today" forecast loaded at boot, kept so we can revert to it
  resolution: 7,
  h3ToLayer: new Map(),
  geoLayer: null,
  maskLayer: null,
  selectedLayer: null,
  locationMarker: null,
  chart: null,
  currentSlot: null, // the diurnal clock slot nearest "now" (null for legacy flat data)
  selected: null, // { h3id, lat, lng } of the chosen cell, so the clock tick can re-render it
  mode: "current", // "current" | "other"
  dateMode: "live", // "live" | "archive"
  archiveDate: null, // "YYYY-MM-DD" currently shown, when dateMode === "archive"
  archiveCache: new Map(), // date -> forecast object, or null if known-missing
};

// Fallback if meta.json predates the archive feature; meta.archive (when present) wins.
const DEFAULT_ARCHIVE = {
  start_date: "2024-02-02",
  end_date: "2025-02-28",
  path_pattern: "data/forecast_r{res}_{date}.json",
};

const isPending = () => !state.meta || state.meta.model_status === "pending_retrain";
const cellsMap = () => (state.forecast && state.forecast.cells) || {};
const show = (id, on) => document.getElementById(id).classList.toggle("hidden", !on);

// ---------------------------------------------------------------------------
// AQI scale helpers - driven entirely by meta.legend (single source of truth).
// ---------------------------------------------------------------------------
function legendEntryFor(value) {
  const legend = state.meta.legend;
  for (const e of legend) {
    if (e.upper === null || value <= e.upper) return e;
  }
  return legend[legend.length - 1];
}
const colorFor = (value) => legendEntryFor(value).color;

// ---------------------------------------------------------------------------
// Diurnal clock-slice: the forecast carries every fixed clock slot; the page
// shows the slot nearest the user's current WIB time (current + next-3, weather-
// forecast style). The data's slots are WIB clock hours, so "now" is WIB too.
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
// A Date whose UTC fields read as WIB wall-clock (WIB = UTC+7), so the date and
// hour are correct no matter what timezone the viewer's browser is in.
const nowWIB = () => new Date(Date.now() + 7 * 3600 * 1000);
const nowHourWIB = () => nowWIB().getUTCHours();
const wibDateStr = () => { const d = nowWIB(); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
const wibClockStr = () => { const d = nowWIB(); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
const circDist = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };

function nearestSlot(hour, slots) {
  const list = slots || (state.meta && state.meta.slot_hours) || [];
  if (!list.length) return null;
  return list.reduce((best, s) => (circDist(s, hour) < circDist(best, hour) ? s : best), list[0]);
}

// The slot_hours that govern the CURRENTLY LOADED forecast (archive dates carry their
// own slot_hours; fall back to meta for the live/default file or legacy data).
const activeSlotHours = () => (state.forecast && state.forecast.slot_hours) || (state.meta && state.meta.slot_hours) || [];

// The current-slot series for a cell. Accepts the slot-keyed shape
// { slot_h: [series] } and the legacy flat [series] (returned as-is).
function seriesForCell(h3id) {
  const cell = cellsMap()[h3id];
  if (!cell) return null;
  if (Array.isArray(cell)) return cell;                       // legacy flat (single anchor)
  const slot = state.currentSlot != null ? state.currentSlot : nearestSlot(nowHourWIB());
  return cell[String(slot)] || cell[Object.keys(cell)[0]] || null;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
function initMap() {
  const map = L.map("map").setView(JAKARTA_CENTER, 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  state.map = map;
  // "Lat/lon" mode: click anywhere to resolve the containing cell.
  map.on("click", (e) => {
    if (state.mode === "other") selectByLatLng(e.latlng.lat, e.latlng.lng);
  });
  return map;
}

function styleForFeature(feature) {
  // Pending: render the grid uniformly so users can see coverage (no values yet).
  if (isPending()) {
    return { fillColor: "#cdd6e0", fillOpacity: 0.22, color: "#8aa0b8", weight: 0.4 };
  }
  const series = seriesForCell(feature.properties.h3_id);
  const idx = series ? series[0].value : null;
  return {
    fillColor: idx === null ? state.meta.no_data_color : series[0].colour || colorFor(idx),
    fillOpacity: 0.4,
    color: "#5b6573",
    weight: 0.3,
  };
}

function addGeoLayer(geojson) {
  state.geoLayer = L.geoJSON(geojson, {
    style: styleForFeature,
    onEachFeature: (feature, layer) => {
      const id = feature.properties.h3_id;
      state.h3ToLayer.set(id, layer);
      layer.on("click", (e) => {
        L.DomEvent.stopPropagation(e); // don't also fire the map "other" click
        const p = feature.properties;
        placeMarker(p.center_lat, p.center_lon);
        selectByCell(id, p.center_lat, p.center_lon);
      });
    },
  }).addTo(state.map);
}

// Opaque mask: hide the basemap everywhere OUTSIDE the hex grid, so only the
// Jakarta study area shows map tiles. Each hex ring becomes a hole in a
// world-covering polygon (Leaflet's default evenodd fill-rule cuts them out);
// a dedicated pane keeps the mask above the tiles but below the hex layer.
// Also frames the grid and bounds panning so the view can't wander off Jakarta.
function addGridMask() {
  if (!state.geoLayer) return;
  const holes = [];
  state.geoLayer.eachLayer((layer) => {
    const rings = layer.getLatLngs();
    if (rings && rings[0]) holes.push(rings[0]);
  });
  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];

  if (!state.map.getPane("maskPane")) {
    const pane = state.map.createPane("maskPane");
    pane.style.zIndex = 350; // tilePane(200) < maskPane(350) < overlayPane(400)
    pane.style.pointerEvents = "none";
  }
  state.maskLayer = L.polygon([world, ...holes], {
    pane: "maskPane",
    stroke: false,
    fillColor: "#e9eef3",
    fillOpacity: 1,
    interactive: false,
  }).addTo(state.map);

  const b = state.geoLayer.getBounds();
  state.map.fitBounds(b);
  state.map.setMaxBounds(b.pad(0.5));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------
function placeMarker(lat, lng) {
  if (state.locationMarker) state.locationMarker.setLatLng([lat, lng]);
  else state.locationMarker = L.marker([lat, lng]).addTo(state.map);
}

function highlight(layer) {
  if (state.selectedLayer && state.geoLayer) state.geoLayer.resetStyle(state.selectedLayer);
  if (layer) {
    layer.setStyle({ color: "#111", weight: 2.5, fillOpacity: isPending() ? 0.4 : 0.65 });
    layer.bringToFront();
  }
  state.selectedLayer = layer;
}

function selectByLatLng(lat, lng) {
  // h3-js v4 API (matches Python aqi_utils.h3_grid.latlng_to_cell at the same res).
  const cell = h3.latLngToCell(lat, lng, state.resolution);
  placeMarker(lat, lng);
  selectByCell(cell, lat, lng);
}

function selectByCell(h3id, lat, lng) {
  state.selected = { h3id, lat, lng };
  show("result-card", true);
  const layer = state.h3ToLayer.get(h3id) || null;
  const onGrid = layer !== null;
  highlight(layer);
  if (layer) state.map.panTo(layer.getBounds().getCenter());

  const coordTxt = lat != null ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : "";
  const dateTxt = state.dateMode === "archive" && state.archiveDate
    ? `<br>Archived date: ${state.archiveDate}`
    : "";
  document.getElementById("result-meta").innerHTML =
    `Cell <code>${h3id}</code>${coordTxt ? "<br>" + coordTxt : ""}${dateTxt}` +
    (onGrid ? "" : `<br><span class="warn">Outside the Jakarta study grid.</span>`);

  // --- PENDING (coming-soon) state ---
  if (isPending()) {
    show("aqi-readout", false);
    show("forecast-section", false);
    show("aqi-pending", true);
    document.getElementById("pending-text").textContent = onGrid
      ? state.meta.model_note
      : "This location is outside the Jakarta mainland study grid, so it has no forecast cell.";
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }

  // --- LIVE state ---
  show("aqi-pending", false);
  const series = seriesForCell(h3id);
  if (!series) {
    show("aqi-readout", true);
    show("forecast-section", false);
    document.getElementById("aqi-value").textContent = "—";
    const badge = document.getElementById("aqi-badge");
    badge.textContent = "Outside coverage";
    badge.style.background = state.meta.no_data_color;
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }
  show("aqi-readout", true);
  show("forecast-section", true);
  const now = series[0];
  const e = legendEntryFor(now.value);
  document.getElementById("aqi-value").textContent = Math.round(now.value);
  const badge = document.getElementById("aqi-badge");
  badge.textContent = `${now.category || e.category} · ${e.english}`;
  badge.style.background = now.colour || e.color;
  renderChart(series);
  renderStepBadges(series);
}

// ---------------------------------------------------------------------------
// Forecast chart + step badges
// ---------------------------------------------------------------------------
const stepLabel = (offsetH) => (offsetH === 0 ? "Now" : `+${offsetH}h`);

// WIB clock time of a forecast point. Slots are whole WIB clock hours and offsets
// are whole hours, so the wall-clock is just (slot + offset) mod 24 -- computed in
// WIB directly, independent of the viewer's browser timezone.
function stepClock(offsetH) {
  if (state.currentSlot != null) return pad2((state.currentSlot + offsetH) % 24) + ":00";
  // legacy flat data (single anchor): derive the hour from anchor_ts if present.
  if (state.meta.anchor_ts) {
    const d = new Date(String(state.meta.anchor_ts).replace(" ", "T"));
    if (!isNaN(d.getTime())) return pad2((d.getHours() + offsetH) % 24) + ":00";
  }
  return "";
}

function renderChart(series) {
  // Heading reflects the actual step size + horizon span from the data (not hardcoded).
  const step = series.length > 1 ? series[1].offset_h - series[0].offset_h : 0;
  const span = series.length ? series[series.length - 1].offset_h : 0;
  const titleEl = document.getElementById("chart-title");
  if (titleEl) titleEl.textContent = step ? `Next ${span} hours · ${step}-hour steps` : "Forecast";

  const labels = series.map((s) => {
    const clk = stepClock(s.offset_h);
    return clk ? `${stepLabel(s.offset_h)}\n${clk}` : stepLabel(s.offset_h);
  });
  const values = series.map((s) => s.value);
  const colors = series.map((s) => s.colour || colorFor(s.value));
  const ctx = document.getElementById("forecast-chart");

  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: "#8893a0",
        borderWidth: 2,
        tension: 0.3,
        pointBackgroundColor: colors,
        pointBorderColor: "#333",
        pointRadius: 6,
        pointHoverRadius: 8,
      }],
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => {
              const e = legendEntryFor(item.parsed.y);
              return `AQI ${Math.round(item.parsed.y)} — ${e.category} (${e.english})`;
            },
          },
        },
      },
      scales: {
        y: { beginAtZero: true, suggestedMax: 150, title: { display: true, text: "ISPU index" } },
        x: { ticks: { maxRotation: 0, autoSkip: false } },
      },
    },
  });
}

function renderStepBadges(series) {
  const wrap = document.getElementById("step-badges");
  wrap.innerHTML = "";
  series.forEach((s) => {
    const e = legendEntryFor(s.value);
    const clk = stepClock(s.offset_h);
    const div = document.createElement("div");
    div.className = "sb";
    div.innerHTML =
      `<div class="sb-time">${stepLabel(s.offset_h)}${clk ? " · " + clk : ""}</div>` +
      `<div class="sb-val">${Math.round(s.value)}</div>` +
      `<div><span class="dot" style="background:${s.colour || e.color}"></span>${s.category || e.category}</div>`;
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Static UI: legend, banner, about, mode toggle
// ---------------------------------------------------------------------------
function renderLegend() {
  const ul = document.getElementById("legend-list");
  ul.innerHTML = "";
  let lower = 0;
  state.meta.legend.forEach((e) => {
    const li = document.createElement("li");
    const range = e.upper === null ? `${lower}+` : `${lower}–${e.upper}`;
    li.innerHTML =
      `<span class="swatch" style="background:${e.color}"></span>` +
      `<span>${e.category} <em>(${e.english})</em></span>` +
      `<span class="range">${range}</span>`;
    ul.appendChild(li);
    lower = (e.upper ?? lower) + 1;
  });
}

function renderBanner() {
  const b = document.getElementById("status-banner");
  if (isPending()) {
    b.className = "banner banner-pending";
    b.innerHTML = `<strong>PREVIEW</strong> &mdash; ${state.meta.model_note}`;
  } else {
    b.className = "banner banner-live";
    if (state.dateMode === "archive" && state.archiveDate) {
      // Archived date: the diurnal SHAPE still follows the live WIB clock (the slot
      // nearest "now"), but the underlying day is the picked archive date, not today.
      const clk = state.currentSlot != null ? ` &middot; ${wibClockStr()} WIB` : "";
      b.innerHTML =
        `<strong>ARCHIVE</strong> &middot; modeled diurnal pattern for ${state.archiveDate}${clk} ` +
        `&middot; representative day, not a live measurement`;
    } else if (state.currentSlot != null) {
      // Driven by the current WIB clock: today's date + live WIB time. The values are
      // a modeled representative diurnal pattern, so we label it honestly (not "live").
      b.innerHTML =
        `Modeled diurnal pattern &middot; ${wibDateStr()} ${wibClockStr()} WIB ` +
        `&middot; representative day, not a live measurement`;
    } else {
      const anchorTxt = state.meta.anchor_ts || state.meta.anchor_date || "—";
      b.innerHTML = `Modeled forecast &middot; anchor ${anchorTxt} (WIB)`;
    }
  }
}

function renderAbout() {
  document.getElementById("about-disclaimers").innerHTML =
    state.meta.disclaimers.map((d) => `<li>${d}</li>`).join("");
  const tail = isPending()
    ? "forecast pending re-train"
    : `${state.meta.n_forecast_cells} cells forecast`;
  document.getElementById("footer-note").textContent =
    `${state.meta.n_cells} hex cells · resolution r${state.resolution} · ${tail}`;
}

function setMode(mode) {
  state.mode = mode;
  document.getElementById("mode-current").classList.toggle("active", mode === "current");
  document.getElementById("mode-other").classList.toggle("active", mode === "other");
  show("panel-current", mode === "current");
  show("panel-other", mode === "other");
}

// Re-evaluate the WIB clock on a timer: keep the banner's "now" current, and when the
// nearest slot rolls over (every few hours) recolor the grid + re-render the selected
// cell, so the map follows the time of day on its own without a reload.
function tickClock() {
  if (isPending()) return;
  const slots = activeSlotHours();
  if (!slots.length) return;
  const s = nearestSlot(nowHourWIB(), slots);
  const slotChanged = s !== state.currentSlot;
  state.currentSlot = s;
  renderBanner();
  if (slotChanged) {
    if (state.geoLayer) state.geoLayer.setStyle(styleForFeature); // hexes follow the new slot
    if (state.selected) selectByCell(state.selected.h3id, state.selected.lat, state.selected.lng);
  }
}

// ---------------------------------------------------------------------------
// Date picker (archive): swap state.forecast between the live "today" file and
// an already-built per-date file from the archive. Lazily fetched + cached;
// missing dates degrade to an inline message, never a crash.
// ---------------------------------------------------------------------------
const archiveConfig = () => (state.meta && state.meta.archive) || DEFAULT_ARCHIVE;
const archivePath = (dateStr) =>
  archiveConfig().path_pattern.replace("{res}", state.resolution).replace("{date}", dateStr);

async function loadArchiveDate(dateStr) {
  const cache = state.archiveCache;
  if (cache.has(dateStr)) return cache.get(dateStr); // a forecast object, or null = known-missing
  try {
    const res = await fetch(archivePath(dateStr));
    if (!res.ok) { cache.set(dateStr, null); return null; }
    const data = await res.json();
    cache.set(dateStr, data);
    return data;
  } catch (e) {
    cache.set(dateStr, null);
    return null;
  }
}

// Re-derive everything that depends on "which forecast is loaded": the clock slot,
// the grid colouring, the banner, and the currently-selected cell's readout.
function refreshAfterForecastChange() {
  const slots = activeSlotHours();
  state.currentSlot = slots.length ? nearestSlot(nowHourWIB(), slots) : null;
  if (state.geoLayer) state.geoLayer.setStyle(styleForFeature);
  renderBanner();
  if (state.selected) selectByCell(state.selected.h3id, state.selected.lat, state.selected.lng);
}

async function onArchiveDateChange(dateStr) {
  state.archiveDate = dateStr;
  const hint = document.getElementById("date-hint");
  hint.classList.remove("warn");
  hint.textContent = "Loading…";
  const data = await loadArchiveDate(dateStr);
  if (!data) {
    hint.textContent = `No forecast saved for ${dateStr} — try a nearby date.`;
    hint.classList.add("warn");
    return; // keep showing whatever was loaded before (don't blank the map on a miss)
  }
  state.forecast = data;
  hint.textContent = `Showing the modeled climatology for ${dateStr}.`;
  refreshAfterForecastChange();
}

function setDateMode(mode) {
  state.dateMode = mode;
  document.getElementById("date-mode-live").classList.toggle("active", mode === "live");
  document.getElementById("date-mode-archive").classList.toggle("active", mode === "archive");
  show("panel-date-live", mode === "live");
  show("panel-date-archive", mode === "archive");
  if (mode === "live") {
    state.forecast = state.liveForecast;
    refreshAfterForecastChange();
  } else {
    const input = document.getElementById("date-input");
    if (input.value) onArchiveDateChange(input.value);
  }
}

function wireControls() {
  document.getElementById("date-mode-live").addEventListener("click", () => setDateMode("live"));
  document.getElementById("date-mode-archive").addEventListener("click", () => setDateMode("archive"));
  document.getElementById("date-input").addEventListener("change", (e) => onArchiveDateChange(e.target.value));

  document.getElementById("mode-current").addEventListener("click", () => setMode("current"));
  document.getElementById("mode-other").addEventListener("click", () => setMode("other"));

  const locateBtn = document.getElementById("locate-btn");
  const locateHint = document.getElementById("locate-hint");
  const setLocateHint = (msg, isErr) => {
    locateHint.textContent = msg;
    locateHint.classList.toggle("warn", !!isErr);
  };

  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setLocateHint("Geolocation isn't supported by this browser — use the Lat / lon option.", true);
      return;
    }
    const original = locateBtn.textContent;
    locateBtn.disabled = true;
    locateBtn.textContent = "Locating…";
    setLocateHint("Requesting your location…", false);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locateBtn.disabled = false;
        locateBtn.textContent = original;
        const { latitude: lat, longitude: lng } = pos.coords;
        selectByLatLng(lat, lng); // resolves the hex cell + shows the (pending) readout
        const cell = h3.latLngToCell(lat, lng, state.resolution);
        if (state.h3ToLayer.has(cell)) {
          state.map.setView([lat, lng], Math.max(state.map.getZoom(), 13));
          setLocateHint("Showing the hex cell at your location.", false);
        } else {
          if (state.geoLayer) state.map.fitBounds(state.geoLayer.getBounds());
          setLocateHint("You're outside the Jakarta study grid — showing the covered area.", true);
        }
      },
      (err) => {
        locateBtn.disabled = false;
        locateBtn.textContent = original;
        const reason = { 1: "permission denied", 2: "position unavailable", 3: "request timed out" };
        let msg = "Couldn't get your location (" + (reason[err.code] || err.message) + ").";
        if (!window.isSecureContext) msg += " Location needs HTTPS or localhost.";
        msg += " Try the Lat / lon option.";
        setLocateHint(msg, true);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });

  document.getElementById("go-btn").addEventListener("click", () => {
    const lat = parseFloat(document.getElementById("lat-input").value);
    const lng = parseFloat(document.getElementById("lon-input").value);
    if (Number.isNaN(lat) || Number.isNaN(lng)) { alert("Enter a valid lat/lon."); return; }
    state.map.setView([lat, lng], Math.max(state.map.getZoom(), 12));
    selectByLatLng(lat, lng);
  });

  // About overlay
  const overlay = document.getElementById("about-overlay");
  document.getElementById("about-btn").addEventListener("click", () => overlay.classList.remove("hidden"));
  document.getElementById("about-close").addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden"); });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  // meta first (it carries the resolution that names the other two files)
  const meta = await fetch("data/meta.json").then((r) => r.json());
  state.meta = meta;
  state.resolution = meta.resolution;

  const [forecast, geojson] = await Promise.all([
    fetch(`data/forecast_r${meta.resolution}.json`).then((r) => r.json()),
    fetch(`data/hexes_r${meta.resolution}.geojson`).then((r) => r.json()),
  ]);
  state.forecast = forecast;
  state.liveForecast = forecast; // keep a handle so "Today (live)" can revert to it
  state.currentSlot = (meta.slot_hours && meta.slot_hours.length) ? nearestSlot(nowHourWIB()) : null;
  document.getElementById("res-label").textContent = "r" + meta.resolution;

  const arc = archiveConfig();
  const dateInput = document.getElementById("date-input");
  dateInput.min = arc.start_date;
  dateInput.max = arc.end_date;
  dateInput.value = arc.end_date; // default to the most recent archived date
  document.getElementById("live-date-hint").textContent =
    `Showing today's live modeled forecast. Archive available ${arc.start_date} → ${arc.end_date}.`;

  initMap();
  addGeoLayer(geojson);
  addGridMask();
  renderLegend();
  renderBanner();
  renderAbout();
  wireControls();
  setMode("current");
  setInterval(tickClock, 60 * 1000); // follow the WIB clock without a reload
}

boot().catch((e) => {
  console.error(e);
  alert("Failed to load web data. Run `python web/build_web_data.py` first, then serve the folder.");
});