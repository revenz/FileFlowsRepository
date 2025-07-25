/**
 * @author lomar6932
 * @uid 4a6fc543-c001-4dbe-9b61-7853f08ef251
 * @name IMDB-Lookup
 * @description MDblist IMDb rating filter with a two-step search-then-fetch process.
 * @revision 1
 * @param {string} ApiKey Your MDblist API key.
 * @param {string} FileType "TV Show" or "Movie".
 * @param {string} Rating Filter e.g. ">8.1", "<7.5", or "7.0-8.5".
 * @output The rating matches the filter.
 * @output Tthe rating does not match.
 */
function Script(ApiKey, FileType, Rating) {

    /* ───────────────────────────────
     1. Get filename (no extension)
    ─────────────────────────────── */
    const fi = FileInfo(Flow.WorkingFile);
    if (!fi?.Name) {
        Logger.ELog("No file name");
        return -1;
    }
    const name = fi.Name.replace(/\.[^.]+$/, "");

    /* ───────────────────────────────
     2. Extract a clean title and year
    ─────────────────────────────── */
    let title = name;
    let year = null;
    
    if (FileType === "TV Show") {
        const m = /S\d{1,2}E\d{1,2}/i.exec(title);
        if (m) title = title.substring(0, m.index);
    }
    
    let cutIndex = title.length;
    
    const yearRegex = /\b((?:19|20)\d{2})\b/;
    const yearMatch = title.match(yearRegex);
    if (yearMatch) {
        year = parseInt(yearMatch[1], 10);
        cutIndex = Math.min(cutIndex, yearMatch.index);
    }

    const junkKeywordsRegex = /\b(360p|480p|720p|1080p|2160p|4K|BluRay|WEB(Rip|[-. ]?DL)|HDRip|DVD(Rip)?|x265|h265|HEVC|x264|h264)\b/i;
    const keywordMatch = title.match(junkKeywordsRegex);
    if (keywordMatch) {
        cutIndex = Math.min(cutIndex, keywordMatch.index);
    }

    const bracketIndex = title.indexOf('[');
    if (bracketIndex !== -1 && bracketIndex > 0) {
        cutIndex = Math.min(cutIndex, bracketIndex);
    }

    title = title.substring(0, cutIndex).replace(/[.\-_()]+/g, ' ').replace(/\s+/g, ' ').trim();
    
    if (!title) {
        Logger.ELog("Could not parse title from: " + name);
        return -1;
    }
    Logger.ILog(`Parsed Title: "${title}"` + (year ? `, Year: ${year}`: ''));

    /* ───────────────────────────────
     3. STEP 1: Search and find the best match
    ─────────────────────────────── */
    Logger.ILog("Step 1: Searching for item...");
    const searchMediaType = (FileType === "TV Show") ? "show" : "movie";
    const searchUrl = `https://api.mdblist.com/search/${searchMediaType}?apikey=${encodeURIComponent(ApiKey)}&query=${encodeURIComponent(title)}`;
    
    const searchExec = Flow.Execute({command: "curl", argumentList: ["-s", searchUrl]});
    if (searchExec.exitCode !== 0) { return -1; }

    const searchResults = JSON.parse(searchExec.output)?.search;
    if (!Array.isArray(searchResults) || searchResults.length === 0) {
        Logger.WLog(`No results from MDblist for "${title}"`);
        return 2;
    }

    let correctEntry = null;
    let possibleMatches = [];
    if (year) {
        possibleMatches = searchResults.filter(item => item.year === year);
    }
    
    if (possibleMatches.length > 1) {
        Logger.WLog(`Ambiguous match: Found ${possibleMatches.length} results for "${title}" (${year}).`);
        possibleMatches.sort((a, b) => b.score - a.score);
        correctEntry = possibleMatches[0];
        Logger.ILog(`Selected most popular match: "${correctEntry.title}" with score ${correctEntry.score}`);
    } else if (possibleMatches.length === 1) {
        correctEntry = possibleMatches[0];
        Logger.ILog(`Found specific match: "${correctEntry.title} (${correctEntry.year})"`);
    } else {
        // ▼▼▼▼▼ NEW SMART FALLBACK LOGIC IS HERE ▼▼▼▼▼
        Logger.WLog(`No year match found. Engaging smart fallback...`);
        const relevantMatches = searchResults.filter(item => item.title.toLowerCase().startsWith(title.toLowerCase()));

        if (relevantMatches.length > 0) {
            relevantMatches.sort((a, b) => b.score - a.score);
            correctEntry = relevantMatches[0];
            Logger.ILog(`Selected most popular relevant match: "${correctEntry.title}" with score ${correctEntry.score}`);
        } else {
            // Last resort if smart fallback finds nothing
            correctEntry = searchResults[0];
            Logger.WLog(`No relevant titles found. Using first result overall: "${correctEntry.title} (${correctEntry.year})"`);
        }
    }
    
    const imdbId = correctEntry?.ids?.imdbid;
    if (!imdbId) {
        Logger.WLog(`Could not find an IMDb ID for "${correctEntry.title}"`);
        return 2;
    }
    Logger.ILog(`Found IMDb ID: ${imdbId}`);

    /* ───────────────────────────────
     4. STEP 2: Fetch IMDb rating
    ─────────────────────────────── */
    Logger.ILog("Step 2: Fetching IMDb rating...");
    const ratingUrl = `https://api.mdblist.com/rating/${searchMediaType}/imdb?apikey=${encodeURIComponent(ApiKey)}`;
    const postData = JSON.stringify({ ids: [imdbId], provider: "imdb" });
    
    const ratingExec = Flow.Execute({command: "curl", argumentList: ["-sX", "POST", ratingUrl, "-H", "Content-Type: application/json", "-d", postData]});
    if (ratingExec.exitCode !== 0) { return -1; }
    
    const r = JSON.parse(ratingExec.output)?.ratings?.[0]?.rating;
    if (r == null) {
        Logger.WLog(`No IMDb rating found for "${correctEntry.title}"`);
        return 2;
    }
    const val = parseFloat(r);
    Logger.ILog(`${correctEntry.title} (${correctEntry.year}) IMDb Rating = ${val}`);

    /* ───────────────────────────────
     5. Apply filter
    ─────────────────────────────── */
    let ok = false;
    const f = (Rating || "").trim();
    if (f.startsWith(">") || f.startsWith("<")) {
        const t = parseFloat(f.substring(1));
        if (!isNaN(t)) ok = (f[0] === ">") ? val > t : val < t;
    } else if (f.includes("-")) {
        const [lo, hi] = f.split("-").map(x => parseFloat(x));
        if (!isNaN(lo) && !isNaN(hi)) ok = val >= lo && val <= hi;
    } else if (f) {
        const t = parseFloat(f);
        if (!isNaN(t)) ok = val >= t;
    } else {
        Logger.WLog("No rating filter provided, exiting.");
        return 2;
    }
    Logger.ILog(`Filter check for '${f}': ${ok}`);

    /* ───────────────────────────────
     6. Return branch
    ─────────────────────────────── */
    Logger.ILog(ok ? "→ True output" : "→ False output");
    return ok ? 1 : 2;
}
