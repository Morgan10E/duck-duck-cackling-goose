"use strict";
const INAT_BASE = "https://api.inaturalist.org/v1/observations";
const INAT_TAXA_BASE = "https://api.inaturalist.org/v1/taxa";
const TAXON_SEARCH_DEBOUNCE_MS = 320;
const OBS_RANDOM_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const INAT_DATE_FETCH_PER_PAGE = 50;
const INAT_DATE_FETCH_MAX_PAGES = 5;
const STORAGE_KEY = "ddcg_v2";
const LEGACY_STATS_COOKIE = "ddcg_stats";
const FEEDBACK_MS = 450;
const STATS_DEFAULT = {
    totalAttempts: 0,
    totalCorrect: 0,
    currentStreak: 0,
    longestStreak: 0,
    shownA: 0,
    correctA: 0,
    shownB: 0,
    correctB: 0,
};
const PRESETS = [
    {
        id: "geese",
        title: "Cackling Goose / Canada Goose",
        pair: {
            idA: 59220,
            idB: 7089,
            labelA: "Cackling Goose",
            labelB: "Canada Goose",
        },
    },
    {
        id: "finches",
        title: "Purple Finch / House Finch",
        pair: {
            idA: 199841,
            idB: 199840,
            labelA: "Purple Finch",
            labelB: "House Finch",
        },
    },
    {
        id: "swallows",
        title: "Violet-green Swallow / Tree Swallow",
        pair: {
            idA: 11931,
            idB: 11935,
            labelA: "Violet-green Swallow",
            labelB: "Tree Swallow",
        },
    },
];
const DEFAULT_PAIR = PRESETS[0].pair;
function pairKey(pair) {
    return `${pair.idA}-${pair.idB}`;
}
function clonePair(pair) {
    return { ...pair };
}
function getEl(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`Missing #${id}`);
    return node;
}
const el = {
    placeholder: getEl("imagePlaceholder"),
    img: getEl("gooseImage"),
    credit: getEl("photoCredit"),
    feedback: getEl("feedback"),
    btnTaxonA: getEl("btnTaxonA"),
    btnTaxonB: getEl("btnTaxonB"),
    errorMsg: getEl("errorMsg"),
    statsModal: getEl("statsModal"),
    settingsModal: getEl("settingsModal"),
    statsTrigger: getEl("statsTrigger"),
    settingsTrigger: getEl("settingsTrigger"),
    statsClose: getEl("statsClose"),
    settingsClose: getEl("settingsClose"),
    presetList: getEl("presetList"),
    statCurrentStreak: getEl("statCurrentStreak"),
    statLongestStreak: getEl("statLongestStreak"),
    statTotalPct: getEl("statTotalPct"),
    statMatrixColGuessA: getEl("statMatrixColGuessA"),
    statMatrixColGuessB: getEl("statMatrixColGuessB"),
    statMatrixRowWhenA: getEl("statMatrixRowWhenA"),
    statMatrixRowWhenB: getEl("statMatrixRowWhenB"),
    statWhenAGuessA: getEl("statWhenAGuessA"),
    statWhenAGuessB: getEl("statWhenAGuessB"),
    statWhenBGuessA: getEl("statWhenBGuessA"),
    statWhenBGuessB: getEl("statWhenBGuessB"),
    btnPickTaxonA: getEl("btnPickTaxonA"),
    btnPickTaxonB: getEl("btnPickTaxonB"),
    taxonPickLabelA: getEl("taxonPickLabelA"),
    taxonPickLabelB: getEl("taxonPickLabelB"),
    taxonSearchModal: getEl("taxonSearchModal"),
    taxonSearchTitle: getEl("taxonSearchTitle"),
    taxonSearchInput: getEl("taxonSearchInput"),
    taxonSearchResults: getEl("taxonSearchResults"),
    taxonSearchClose: getEl("taxonSearchClose"),
    taxonSearchHint: getEl("taxonSearchHint"),
};
let roundActual = null;
let roundBusy = false;
let taxonSearchTarget = null;
let taxonSearchDebounceTimer = null;
function buildSearchParams(overrides) {
    return new URLSearchParams({
        photos: "true",
        quality_grade: "research",
        ...overrides,
    });
}
async function fetchInatJson(searchParams) {
    const url = `${INAT_BASE}?${searchParams}`;
    const res = await fetch(url, {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) {
        const hint = res.status === 403 ? " (rate limits or blocking)" : "";
        throw new Error(`iNaturalist error ${res.status}${hint}`);
    }
    return res.json();
}
async function fetchTaxaJson(searchParams) {
    const url = `${INAT_TAXA_BASE}?${searchParams}`;
    const res = await fetch(url, {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) {
        const hint = res.status === 403 ? " (rate limits or blocking)" : "";
        throw new Error(`iNaturalist taxa error ${res.status}${hint}`);
    }
    return res.json();
}
function taxonDisplayLabel(t) {
    const c = t.preferred_common_name?.trim();
    if (c)
        return c;
    return t.name?.trim() || `Taxon ${t.id}`;
}
function taxonSquareUrl(t) {
    const p = t.default_photo;
    const u = p?.square_url || p?.url;
    return u && u.length > 0 ? u : null;
}
async function fetchTaxonById(id) {
    try {
        const data = await fetchTaxaJson(new URLSearchParams({ id: String(id) }));
        const t = data.results?.[0];
        return t && t.id === id ? t : null;
    }
    catch {
        return null;
    }
}
async function searchTaxaForPicker(query) {
    const q = query.trim();
    if (q.length < 2)
        return [];
    const data = await fetchTaxaJson(new URLSearchParams({
        q,
        rank: "species",
        per_page: "25",
        order: "desc",
        order_by: "observations_count",
    }));
    const list = data.results ?? [];
    return list.filter((t) => t.is_active !== false &&
        typeof t.id === "number" &&
        (t.observations_count ?? 0) > 0 &&
        t.rank === "species");
}
function photoToMediumUrl(url) {
    if (!url)
        return "";
    return url.replace(/\/(square|thumb|small)\.(jpg|jpeg|png|webp)/i, "/medium.$2");
}
function isoDateUTC(d) {
    return d.toISOString().slice(0, 10);
}
function observedAtMs(obs) {
    const s = obs.time_observed_at || obs.observed_on;
    if (!s)
        return NaN;
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : NaN;
}
async function fetchObservationForRandomCutoff(taxonId) {
    const now = Date.now();
    const cutoff = new Date(now - Math.random() * OBS_RANDOM_WINDOW_MS);
    const windowStart = new Date(now - OBS_RANDOM_WINDOW_MS);
    let d1 = isoDateUTC(windowStart);
    let d2 = isoDateUTC(cutoff);
    if (d1 > d2) {
        const swap = d1;
        d1 = d2;
        d2 = swap;
    }
    const cutoffMs = cutoff.getTime();
    for (let page = 1; page <= INAT_DATE_FETCH_MAX_PAGES; page++) {
        const data = await fetchInatJson(buildSearchParams({
            taxon_id: String(taxonId),
            per_page: String(INAT_DATE_FETCH_PER_PAGE),
            page: String(page),
            d1,
            d2,
            order_by: "observed_on",
            order: "desc",
        }));
        const list = data.results ?? [];
        for (const obs of list) {
            if (!obs || obs.taxon?.id !== taxonId)
                continue;
            if (!Array.isArray(obs.photos) || obs.photos.length === 0)
                continue;
            const obsMs = observedAtMs(obs);
            if (!Number.isFinite(obsMs) || obsMs > cutoffMs)
                continue;
            const rawUrl = obs.photos[0].url;
            if (!rawUrl)
                continue;
            const imageUrl = photoToMediumUrl(rawUrl);
            const login = obs.user?.login ?? "unknown";
            return { imageUrl, login, observation: obs };
        }
        if (list.length < INAT_DATE_FETCH_PER_PAGE)
            break;
    }
    throw new Error("Could not load a photo for this species. Try again.");
}
function readCookie(name) {
    const prefix = `${name}=`;
    const parts = document.cookie.split(";").map((c) => c.trim());
    for (const part of parts) {
        if (part.startsWith(prefix)) {
            return decodeURIComponent(part.slice(prefix.length));
        }
    }
    return null;
}
function writeCookie(name, value, maxAgeSeconds) {
    const safe = encodeURIComponent(value);
    document.cookie = `${name}=${safe}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}
function clearLegacyStatsCookie() {
    writeCookie(LEGACY_STATS_COOKIE, "", 0);
}
function migrateLegacyCookie() {
    const raw = readCookie(LEGACY_STATS_COOKIE);
    if (!raw)
        return null;
    try {
        const parsed = JSON.parse(raw);
        const s = { ...STATS_DEFAULT };
        if (typeof parsed.totalAttempts === "number")
            s.totalAttempts = parsed.totalAttempts;
        if (typeof parsed.totalCorrect === "number")
            s.totalCorrect = parsed.totalCorrect;
        if (typeof parsed.currentStreak === "number")
            s.currentStreak = parsed.currentStreak;
        if (typeof parsed.longestStreak === "number")
            s.longestStreak = parsed.longestStreak;
        if (typeof parsed.cacklingShown === "number")
            s.shownA = parsed.cacklingShown;
        if (typeof parsed.cacklingCorrect === "number")
            s.correctA = parsed.cacklingCorrect;
        if (typeof parsed.canadaShown === "number")
            s.shownB = parsed.canadaShown;
        if (typeof parsed.canadaCorrect === "number")
            s.correctB = parsed.canadaCorrect;
        clearLegacyStatsCookie();
        return s;
    }
    catch {
        return null;
    }
}
function loadPersisted() {
    const migrated = migrateLegacyCookie();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            const activePair = parsed.activePair &&
                typeof parsed.activePair.idA === "number" &&
                typeof parsed.activePair.idB === "number" &&
                typeof parsed.activePair.labelA === "string" &&
                typeof parsed.activePair.labelB === "string"
                ? clonePair(parsed.activePair)
                : clonePair(DEFAULT_PAIR);
            const statsByPairKey = {};
            if (parsed.statsByPairKey && typeof parsed.statsByPairKey === "object") {
                for (const [k, v] of Object.entries(parsed.statsByPairKey)) {
                    if (v && typeof v === "object")
                        statsByPairKey[k] = { ...STATS_DEFAULT, ...v };
                }
            }
            const key = pairKey(activePair);
            if (migrated && !statsByPairKey[key]) {
                statsByPairKey[key] = migrated;
            }
            else if (migrated && statsByPairKey[key]) {
                const cur = statsByPairKey[key];
                if (cur.totalAttempts === 0 && migrated.totalAttempts > 0) {
                    statsByPairKey[key] = migrated;
                }
            }
            return { activePair, statsByPairKey };
        }
    }
    catch {
        /* ignore */
    }
    const statsByPairKey = {};
    if (migrated) {
        statsByPairKey[pairKey(DEFAULT_PAIR)] = migrated;
    }
    return { activePair: clonePair(DEFAULT_PAIR), statsByPairKey };
}
function savePersisted(state) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    catch {
        /* ignore */
    }
}
function getActivePair() {
    return loadPersisted().activePair;
}
function getCurrentStats() {
    const { activePair, statsByPairKey } = loadPersisted();
    const key = pairKey(activePair);
    return statsByPairKey[key] ? { ...STATS_DEFAULT, ...statsByPairKey[key] } : { ...STATS_DEFAULT };
}
function saveCurrentStats(stats) {
    const state = loadPersisted();
    state.statsByPairKey[pairKey(state.activePair)] = { ...stats };
    savePersisted(state);
}
function setActivePair(pair) {
    const state = loadPersisted();
    state.activePair = clonePair(pair);
    const k = pairKey(pair);
    if (!state.statsByPairKey[k]) {
        state.statsByPairKey[k] = { ...STATS_DEFAULT };
    }
    savePersisted(state);
}
function pct(n, d) {
    if (d === 0)
        return "—";
    return `${Math.round((100 * n) / d)}%`;
}
function formatStreak(n) {
    return String(n);
}
function applyTaxonLabels() {
    const pair = getActivePair();
    el.btnTaxonA.textContent = pair.labelA;
    el.btnTaxonB.textContent = pair.labelB;
    const short = (s) => (s.length > 22 ? `${s.slice(0, 20)}…` : s);
    el.statMatrixColGuessA.textContent = short(pair.labelA);
    el.statMatrixColGuessB.textContent = short(pair.labelB);
    el.statMatrixRowWhenA.textContent = short(pair.labelA);
    el.statMatrixRowWhenB.textContent = short(pair.labelB);
}
async function refreshTaxonPickerVisuals() {
    const pair = getActivePair();
    el.taxonPickLabelA.textContent = `Left species: ${pair.labelA}. Tap to replace.`;
    el.taxonPickLabelB.textContent = `Right species: ${pair.labelB}. Tap to replace.`;
    el.btnPickTaxonA.setAttribute("aria-label", `Replace ${pair.labelA} (left quiz button)`);
    el.btnPickTaxonB.setAttribute("aria-label", `Replace ${pair.labelB} (right quiz button)`);
    const [ta, tb] = await Promise.all([fetchTaxonById(pair.idA), fetchTaxonById(pair.idB)]);
    const urlA = ta ? taxonSquareUrl(ta) : null;
    const urlB = tb ? taxonSquareUrl(tb) : null;
    el.btnPickTaxonA.style.backgroundImage = urlA ? `url("${urlA}")` : "";
    el.btnPickTaxonB.style.backgroundImage = urlB ? `url("${urlB}")` : "";
}
function showTaxonSearchHint(text) {
    el.taxonSearchHint.textContent = text;
    el.taxonSearchHint.classList.toggle("hidden", text.length === 0);
}
function clearTaxonSearchUI() {
    el.taxonSearchInput.value = "";
    el.taxonSearchResults.replaceChildren();
    showTaxonSearchHint("");
}
function openTaxonSearch(slot) {
    taxonSearchTarget = slot;
    const pair = getActivePair();
    el.taxonSearchTitle.textContent =
        slot === "a" ? `Replace: ${pair.labelA}` : `Replace: ${pair.labelB}`;
    clearTaxonSearchUI();
    el.taxonSearchModal.showModal();
    window.setTimeout(() => el.taxonSearchInput.focus(), 0);
}
function closeTaxonSearch() {
    taxonSearchTarget = null;
    el.taxonSearchModal.close();
    if (taxonSearchDebounceTimer !== null) {
        clearTimeout(taxonSearchDebounceTimer);
        taxonSearchDebounceTimer = null;
    }
    clearTaxonSearchUI();
}
function renderTaxonSearchResults(results) {
    el.taxonSearchResults.replaceChildren();
    const slot = taxonSearchTarget;
    if (!slot)
        return;
    const pair = getActivePair();
    const otherId = slot === "a" ? pair.idB : pair.idA;
    let added = 0;
    for (const t of results) {
        if (t.id === otherId)
            continue;
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "taxon-search-result";
        const thumb = document.createElement("img");
        thumb.className = "taxon-search-result-thumb";
        thumb.alt = "";
        const su = taxonSquareUrl(t);
        if (su)
            thumb.src = su;
        else
            thumb.style.visibility = "hidden";
        const wrap = document.createElement("div");
        wrap.className = "taxon-search-result-text";
        const nameEl = document.createElement("div");
        nameEl.className = "taxon-search-result-name";
        nameEl.textContent = taxonDisplayLabel(t);
        const sci = document.createElement("div");
        sci.className = "taxon-search-result-sci";
        sci.textContent = t.name ?? "";
        wrap.append(nameEl, sci);
        btn.append(thumb, wrap);
        btn.addEventListener("click", () => applyPickedTaxon(t));
        li.appendChild(btn);
        el.taxonSearchResults.appendChild(li);
        added += 1;
    }
    if (added === 0 && results.length > 0) {
        showTaxonSearchHint("All matching species are already the other slot. Try a different search.");
    }
}
async function runTaxonSearchQuery() {
    showTaxonSearchHint("");
    el.taxonSearchResults.replaceChildren();
    const q = el.taxonSearchInput.value;
    if (q.trim().length < 2) {
        showTaxonSearchHint("Type at least 2 characters.");
        return;
    }
    try {
        const results = await searchTaxaForPicker(q);
        if (results.length === 0) {
            showTaxonSearchHint("No species found with observations. Try another name.");
            return;
        }
        renderTaxonSearchResults(results);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Search failed.";
        showTaxonSearchHint(msg);
    }
}
function scheduleTaxonSearch() {
    if (taxonSearchDebounceTimer !== null)
        clearTimeout(taxonSearchDebounceTimer);
    taxonSearchDebounceTimer = setTimeout(() => {
        taxonSearchDebounceTimer = null;
        void runTaxonSearchQuery();
    }, TAXON_SEARCH_DEBOUNCE_MS);
}
function applyPickedTaxon(t) {
    const slot = taxonSearchTarget;
    if (!slot)
        return;
    const pair = getActivePair();
    const otherId = slot === "a" ? pair.idB : pair.idA;
    if (t.id === otherId) {
        showTaxonSearchHint("Pick a different species than the other slot.");
        return;
    }
    const label = taxonDisplayLabel(t);
    const next = slot === "a"
        ? { idA: t.id, idB: pair.idB, labelA: label, labelB: pair.labelB }
        : { idA: pair.idA, idB: t.id, labelA: pair.labelA, labelB: label };
    setActivePair(next);
    applyTaxonLabels();
    void buildPresetList();
    void refreshTaxonPickerVisuals();
    refreshStatsUI();
    closeTaxonSearch();
    void startRound();
}
function refreshStatsUI() {
    const s = getCurrentStats();
    el.statCurrentStreak.textContent = formatStreak(s.currentStreak);
    el.statLongestStreak.textContent = formatStreak(s.longestStreak);
    el.statTotalPct.textContent = pct(s.totalCorrect, s.totalAttempts);
    const wrongGuessBWhenA = Math.max(0, s.shownA - s.correctA);
    const wrongGuessAWhenB = Math.max(0, s.shownB - s.correctB);
    el.statWhenAGuessA.textContent = String(s.correctA);
    el.statWhenAGuessB.textContent = String(wrongGuessBWhenA);
    el.statWhenBGuessA.textContent = String(wrongGuessAWhenB);
    el.statWhenBGuessB.textContent = String(s.correctB);
}
function hideError() {
    el.errorMsg.classList.add("hidden");
    el.errorMsg.textContent = "";
}
function showError(msg) {
    el.errorMsg.textContent = msg;
    el.errorMsg.classList.remove("hidden");
}
function setPhotoCredit(login) {
    el.credit.replaceChildren();
    const safe = String(login ?? "").trim();
    if (!safe)
        return;
    el.credit.append(document.createTextNode("Photo via iNaturalist · observer "));
    if (safe === "unknown") {
        el.credit.append(document.createTextNode(`@${safe}`));
        return;
    }
    const a = document.createElement("a");
    a.href = `https://www.inaturalist.org/observations?user_id=${encodeURIComponent(safe)}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "credit-link";
    a.textContent = `@${safe}`;
    el.credit.append(a);
}
function setLoading(loading) {
    if (loading) {
        el.placeholder.classList.remove("hidden");
        el.img.classList.add("hidden");
    }
    el.btnTaxonA.disabled = loading || roundBusy;
    el.btnTaxonB.disabled = loading || roundBusy;
}
function hideFeedback() {
    el.feedback.classList.add("hidden");
    el.feedback.textContent = "";
    el.feedback.classList.remove("correct", "wrong");
}
function showFeedback(correct) {
    el.feedback.textContent = correct ? "✓" : "✗";
    el.feedback.classList.remove("hidden", "correct", "wrong");
    el.feedback.classList.add(correct ? "correct" : "wrong");
}
function applyGuess(guess) {
    if (roundBusy || roundActual === null)
        return;
    const actual = roundActual;
    const correct = guess === actual;
    roundBusy = true;
    el.btnTaxonA.disabled = true;
    el.btnTaxonB.disabled = true;
    showFeedback(correct);
    const stats = getCurrentStats();
    stats.totalAttempts += 1;
    if (correct) {
        stats.totalCorrect += 1;
        stats.currentStreak += 1;
        if (stats.currentStreak > stats.longestStreak) {
            stats.longestStreak = stats.currentStreak;
        }
    }
    else {
        stats.currentStreak = 0;
    }
    if (actual === "a") {
        stats.shownA += 1;
        if (correct)
            stats.correctA += 1;
    }
    else {
        stats.shownB += 1;
        if (correct)
            stats.correctB += 1;
    }
    saveCurrentStats(stats);
    refreshStatsUI();
    window.setTimeout(() => {
        hideFeedback();
        roundBusy = false;
        void startRound();
    }, FEEDBACK_MS);
}
async function startRound() {
    hideError();
    hideFeedback();
    roundActual = null;
    setLoading(true);
    const pair = getActivePair();
    const actual = Math.random() < 0.5 ? "a" : "b";
    const taxonId = actual === "a" ? pair.idA : pair.idB;
    try {
        const { imageUrl, login } = await fetchObservationForRandomCutoff(taxonId);
        roundActual = actual;
        setPhotoCredit(login);
        const label = actual === "a" ? pair.labelA : pair.labelB;
        el.img.alt = `${label} (quiz image)`;
        const reveal = () => {
            el.placeholder.classList.add("hidden");
            el.img.classList.remove("hidden");
            el.btnTaxonA.disabled = false;
            el.btnTaxonB.disabled = false;
        };
        el.img.onload = reveal;
        el.img.onerror = () => {
            roundActual = null;
            showError("Image failed to load. Trying another…");
            el.placeholder.classList.remove("hidden");
            el.img.classList.add("hidden");
            window.setTimeout(() => void startRound(), 800);
        };
        el.img.removeAttribute("src");
        el.img.src = imageUrl;
        if (typeof el.img.decode === "function") {
            el.img.decode().then(reveal).catch(() => { });
        }
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Something went wrong.";
        showError(`${msg} Retrying…`);
        el.placeholder.classList.remove("hidden");
        el.img.classList.add("hidden");
        setPhotoCredit(null);
        el.btnTaxonA.disabled = true;
        el.btnTaxonB.disabled = true;
        window.setTimeout(() => {
            hideError();
            void startRound();
        }, 2500);
    }
}
function openStats() {
    applyTaxonLabels();
    refreshStatsUI();
    el.statsModal.showModal();
}
function closeStats() {
    el.statsModal.close();
}
function openSettings() {
    void refreshTaxonPickerVisuals();
    el.settingsModal.showModal();
}
function closeSettings() {
    if (el.taxonSearchModal.open)
        closeTaxonSearch();
    el.settingsModal.close();
}
function applyPresetById(presetId) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset)
        return;
    setActivePair(preset.pair);
    applyTaxonLabels();
    void buildPresetList();
    void refreshTaxonPickerVisuals();
    refreshStatsUI();
    closeSettings();
    void startRound();
}
async function buildPresetList() {
    el.presetList.replaceChildren();
    const active = pairKey(getActivePair());
    const ids = [...new Set(PRESETS.flatMap((p) => [p.pair.idA, p.pair.idB]))];
    const fetched = await Promise.all(ids.map((id) => fetchTaxonById(id)));
    const byId = new Map();
    ids.forEach((id, i) => byId.set(id, fetched[i] ?? null));
    for (const p of PRESETS) {
        const ta = byId.get(p.pair.idA) ?? null;
        const tb = byId.get(p.pair.idB) ?? null;
        const urlA = ta ? taxonSquareUrl(ta) : null;
        const urlB = tb ? taxonSquareUrl(tb) : null;
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "preset-btn";
        btn.setAttribute("aria-label", `${p.pair.labelA} / ${p.pair.labelB} preset`);
        const sr = document.createElement("span");
        sr.className = "preset-btn-sr";
        sr.textContent = p.title;
        const thumbA = document.createElement(urlA ? "img" : "span");
        thumbA.className = "preset-btn-img preset-btn-img--a";
        if (urlA) {
            const img = thumbA;
            img.alt = "";
            img.decoding = "async";
            img.src = urlA;
        }
        else {
            thumbA.classList.add("preset-btn-img--placeholder");
            thumbA.setAttribute("aria-hidden", "true");
        }
        const mid = document.createElement("span");
        mid.className = "preset-btn-mid";
        const nameA = document.createElement("span");
        nameA.className = "preset-btn-name preset-btn-name--a";
        nameA.textContent = p.pair.labelA;
        const sep = document.createElement("span");
        sep.className = "preset-btn-sep";
        sep.textContent = " / ";
        const nameB = document.createElement("span");
        nameB.className = "preset-btn-name preset-btn-name--b";
        nameB.textContent = p.pair.labelB;
        mid.append(nameA, sep, nameB);
        const thumbB = document.createElement(urlB ? "img" : "span");
        thumbB.className = "preset-btn-img preset-btn-img--b";
        if (urlB) {
            const img = thumbB;
            img.alt = "";
            img.decoding = "async";
            img.src = urlB;
        }
        else {
            thumbB.classList.add("preset-btn-img--placeholder");
            thumbB.setAttribute("aria-hidden", "true");
        }
        btn.append(sr, thumbA, mid, thumbB);
        if (pairKey(p.pair) === active) {
            btn.classList.add("preset-btn--active");
            btn.setAttribute("aria-current", "true");
        }
        btn.addEventListener("click", () => applyPresetById(p.id));
        li.appendChild(btn);
        el.presetList.appendChild(li);
    }
}
function boot() {
    try {
        localStorage.removeItem("ddcg_inat_jwt");
    }
    catch {
        /* ignore */
    }
    applyTaxonLabels();
    void buildPresetList();
    void refreshTaxonPickerVisuals();
    refreshStatsUI();
    void startRound();
}
el.btnTaxonA.addEventListener("click", () => applyGuess("a"));
el.btnTaxonB.addEventListener("click", () => applyGuess("b"));
el.statsTrigger.addEventListener("click", openStats);
el.statsClose.addEventListener("click", closeStats);
el.settingsTrigger.addEventListener("click", openSettings);
el.settingsClose.addEventListener("click", closeSettings);
el.statsModal.addEventListener("click", (ev) => {
    if (ev.target === el.statsModal)
        closeStats();
});
el.settingsModal.addEventListener("click", (ev) => {
    if (ev.target === el.settingsModal)
        closeSettings();
});
el.btnPickTaxonA.addEventListener("click", () => openTaxonSearch("a"));
el.btnPickTaxonB.addEventListener("click", () => openTaxonSearch("b"));
el.taxonSearchClose.addEventListener("click", closeTaxonSearch);
el.taxonSearchInput.addEventListener("input", scheduleTaxonSearch);
el.taxonSearchModal.addEventListener("click", (ev) => {
    if (ev.target === el.taxonSearchModal)
        closeTaxonSearch();
});
boot();
