// _worker.js

// === CONFIGURATION ===
const CACHE_KEY = "market_data_v7"; 
const CACHE_LOCK_KEY = "market_data_lock";
const UPDATE_INTERVAL_MS = 15 * 60 * 1000; 
const SOFT_REFRESH_MS = 12 * 60 * 1000;    
const MIN_RETRY_DELAY_MS = 2 * 60 * 1000;  
const TIMEOUT_MS = 45000; 
const LOCK_TIMEOUT_MS = 120000; 

// === EXCLUSION FILES ===
const EXCLUSION_FILES = [
    "/exclusions/stablecoins-exclusion-list.json",
    "/exclusions/wrapped-tokens-exclusion-list.json"
];

const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
};

const API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.coingecko.com/"
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // === ROUTE 1: DYNAMIC SITEMAP ===
        if (url.pathname === "/sitemap.xml") {
            const baseUrl = "https://cryptomovers.pages.dev";
            const now = new Date().toISOString();
            
            try {
                const manifestRes = await env.ASSETS.fetch(new URL("/urls.json", request.url));
                
                if (!manifestRes.ok) {
                    return new Response("Error: urls.json not found", { status: 500 });
                }

                const pages = await manifestRes.json();

                let sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

                pages.forEach(page => {
                    sitemap += `
  <url>
    <loc>${baseUrl}${page.path}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`;
                });

                sitemap += `\n</urlset>`;

                return new Response(sitemap, {
                    headers: { 
                        "Content-Type": "application/xml", 
                        "Cache-Control": "no-cache, no-store, must-revalidate" 
                    }
                });
            } catch (err) {
                return new Response("Sitemap Error: " + err.message, { status: 500 });
            }
        }

        // === ROUTE 2: MARKET DATA API ===
        if (url.pathname === "/api/stats") {
            if (!env.KV_STORE) {
                return new Response(JSON.stringify({ error: true, message: "KV_STORE binding missing" }), { status: 500, headers: HEADERS });
            }

            try {
                const [cachedRaw, lock] = await Promise.all([
                    env.KV_STORE.get(CACHE_KEY),
                    env.KV_STORE.get(CACHE_LOCK_KEY)
                ]);
                
                let cachedData = null;
                let dataAge = 0;
                const now = Date.now();

                if (cachedRaw) {
                    try {
                        cachedData = JSON.parse(cachedRaw);
                        dataAge = now - (cachedData.timestamp || 0);
                    } catch (e) { console.error("Cache corrupted:", e); }
                }

                const isUpdating = lock && (now - parseInt(lock)) < LOCK_TIMEOUT_MS;

                if (cachedData && dataAge < SOFT_REFRESH_MS) {
                    return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-Fresh" } });
                }

                if (isUpdating && cachedData) {
                    return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-UpdateInProgress" } });
                }

                if (cachedData && dataAge >= SOFT_REFRESH_MS) {
                    const lastAttemptAge = now - (cachedData.lastUpdateAttempt || 0);
                    
                    if (lastAttemptAge >= MIN_RETRY_DELAY_MS) {
                        console.log("Triggering Background Update...");
                        
                        await env.KV_STORE.put(CACHE_LOCK_KEY, now.toString(), { expirationTtl: Math.floor(LOCK_TIMEOUT_MS / 1000) });
                        
                        ctx.waitUntil(
                            updateMarketDataSafe(env, cachedData, true)
                                .finally(() => env.KV_STORE.delete(CACHE_LOCK_KEY).catch(() => {}))
                        );
                        
                        return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-Proactive", "X-Update-Triggered": "Deep-Scan" } });
                    } else {
                        return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-RateLimited" } });
                    }
                }

                console.log("Cache empty. Starting Sprint...");
                await env.KV_STORE.put(CACHE_LOCK_KEY, now.toString(), { expirationTtl: Math.floor(LOCK_TIMEOUT_MS / 1000) });
                
                try {
                    const freshJson = await fetchWithTimeout(env, false);
                    
                    await env.KV_STORE.put(CACHE_KEY, freshJson, { expirationTtl: 172800 });
                    await env.KV_STORE.delete(CACHE_LOCK_KEY).catch(() => {});
                    
                    return new Response(freshJson, { headers: { ...HEADERS, "X-Source": "Live-Fetch-Sprint" } });
                } catch (error) {
                    await env.KV_STORE.delete(CACHE_LOCK_KEY).catch(() => {});
                    
                    if (cachedData) {
                        return new Response(JSON.stringify(cachedData), { headers: { ...HEADERS, "X-Source": "Cache-Fallback-Error" } });
                    }
                    throw error;
                }

            } catch (err) {
                return new Response(JSON.stringify({ error: true, message: err.message }), { status: 500, headers: HEADERS });
            }
        }
        
        return env.ASSETS.fetch(request);
    }
};

// HELPERS

// === NEW: FETCH EXCLUSION LISTS ===
async function getExclusions(env) {
    const exclusionSet = new Set();
    const baseUrl = "http://placeholder"; // Internal fetch base

    await Promise.all(EXCLUSION_FILES.map(async (filePath) => {
        try {
            const res = await env.ASSETS.fetch(new URL(filePath, baseUrl));
            if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list)) {
                    // Add all to Set, normalized to lowercase
                    list.forEach(item => exclusionSet.add(item.toLowerCase()));
                }
            }
        } catch (e) {
            console.warn(`Failed to load exclusion list: ${filePath}`, e);
        }
    }));
    
    return exclusionSet;
}

async function updateMarketDataSafe(env, existingData, isDeepScan) {
    try { await updateMarketData(env, existingData, isDeepScan); } catch (e) { console.error("Background update failed:", e); }
}

async function fetchWithTimeout(env, isDeepScan) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    
    try {
        const result = await updateMarketData(env, null, isDeepScan, controller.signal);
        clearTimeout(timeoutId);
        return result;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error("Request timeout. Try again.");
        if (err.message.includes("Rate Limit") || err.message.includes("429")) throw new Error("CoinGecko Busy (429). Wait 1 min.");
        throw err;
    }
}

async function updateMarketData(env, existingData, isDeepScan, signal = null) {
    const updateAttemptTime = Date.now();
    const pages = isDeepScan ? [1, 2, 3, 4, 5, 6] : [1];
    const perPage = 250; 
    let allCoins = [];
    let hitRateLimit = false;
    let lastError = null;
    
    // 1. Fetch Exclusion Lists FIRST
    const exclusionSet = await getExclusions(env);
    console.log(`Loaded ${exclusionSet.size} exclusions.`);

    const config = { headers: API_HEADERS };
    if (signal) config.signal = signal;

    for (const page of pages) {
        if (hitRateLimit) break;
        
        let success = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 2;

        while (attempts < MAX_ATTEMPTS && !success && !hitRateLimit) {
            attempts++;
            try {
                const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=24h,7d,30d,1y`, config);
                
                if (res.status === 429) {
                    if (attempts >= MAX_ATTEMPTS) {
                        hitRateLimit = true;
                        lastError = "Rate limit reached";
                    }
                    throw new Error("Rate Limit");
                }
                
                if (!res.ok) throw new Error(`API Error: ${res.status}`);
                
                const data = await res.json();
                if (!Array.isArray(data)) throw new Error("Invalid Data");
                
                allCoins = allCoins.concat(data);
                success = true;
                
                if (pages.length > 1 && page < pages.length) await new Promise(r => setTimeout(r, 2000));

            } catch (innerErr) {
                lastError = innerErr.message;
                if (attempts < MAX_ATTEMPTS && !hitRateLimit) {
                    await new Promise(r => setTimeout(r, 2000 * attempts));
                }
            }
        }
    }

    if (allCoins.length === 0) {
        if (existingData) {
            const fallback = JSON.stringify({
                ...existingData,
                lastUpdateAttempt: updateAttemptTime,
                lastUpdateFailed: true,
                lastError: lastError || "Fetch failed",
                timestamp: existingData.timestamp
            });
            await env.KV_STORE.put(CACHE_KEY, fallback, { expirationTtl: 300 });
            return fallback;
        }
        throw new Error(`Market data unavailable: ${lastError}`);
    }

    // 2. Filter using the Exclusion Set
    const valid = allCoins.filter(c => {
        // Basic Checks
        if (!c || !c.symbol || c.price_change_percentage_24h == null || c.current_price == null) return false;
        
        // Exclusion Check (Case Insensitive)
        const symbol = c.symbol.toLowerCase();
        if (exclusionSet.has(symbol)) return false;

        return true;
    });
    
    // Format Data
    const formatCoin = (coin) => ({
        id: coin.id,
        symbol: coin.symbol,
        name: coin.name,
        image: coin.image, 
        current_price: coin.current_price,
        market_cap: coin.market_cap,
        total_volume: coin.total_volume, 
        price_change_percentage_24h: coin.price_change_percentage_24h,
        price_change_percentage_7d: coin.price_change_percentage_7d_in_currency,
        price_change_percentage_30d: coin.price_change_percentage_30d_in_currency,
        price_change_percentage_1y: coin.price_change_percentage_1y_in_currency
    });

    const gainers = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 50).map(formatCoin);
    const losers = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 50).map(formatCoin);

    const finalObject = {
        timestamp: Date.now(),
        lastUpdateAttempt: updateAttemptTime,
        lastUpdateFailed: false,
        totalScanned: allCoins.length,
        excludedCount: allCoins.length - valid.length, // Added stat for debugging
        isPartial: hitRateLimit,
        gainers,
        losers
    };

    const jsonString = JSON.stringify(finalObject);
    await env.KV_STORE.put(CACHE_KEY, jsonString, { expirationTtl: 172800 });
    return jsonString;
}