// _worker.js - Merged Logic (Primary + DEX)

// ==========================================
// 1. CEX (PRIMARY) CONFIGURATION
// ==========================================
const CEX_CACHE_KEY = "market_data_v7"; 
const CEX_CACHE_LOCK_KEY = "market_data_lock";
const CEX_UPDATE_INTERVAL_MS = 15 * 60 * 1000; 
const CEX_SOFT_REFRESH_MS = 12 * 60 * 1000;    
const CEX_MIN_RETRY_DELAY_MS = 2 * 60 * 1000;  
const CEX_TIMEOUT_MS = 45000; 
const CEX_LOCK_TIMEOUT_MS = 120000; 

const CEX_EXCLUSION_FILES = [
    "/exclusions/stablecoins-exclusion-list.json",
    "/exclusions/wrapped-tokens-exclusion-list.json"
];

const CEX_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
};

const CEX_API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.coingecko.com/"
};

// ==========================================
// 2. DEX CONFIGURATION
// ==========================================
const DEX_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=30", 
};

const DEX_KV_KEY_PREFIX = "dex_cache_";
const DEX_IMG_CACHE_PREFIX = "img_";
const DEX_SOFT_REFRESH_MS = 4 * 60 * 1000;   // 4 Minutes
const DEX_HARD_REFRESH_MS = 5 * 60 * 1000;   // 5 Minutes

const DEX_NETWORK_MAP = {
    'solana': 'solana',
    'ethereum': 'eth',
    'bnb': 'bsc',
    'base': 'base'
};

// ==========================================
// MAIN ROUTER
// ==========================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // --- ROUTE A: SITEMAP (CEX Feature) ---
        if (url.pathname === "/sitemap.xml") {
            return handleSitemap(request, env);
        }

        // --- ROUTE B: IMAGE PROXY (DEX Feature) ---
        if (url.pathname === "/api/image-proxy") {
            return handleImageProxy(request, env, url);
        }

        // --- ROUTE C: MARKET DATA API (Shared Endpoint) ---
        if (url.pathname === "/api/stats") {
            // PROPOSAL 1 LOGIC:
            // If "network" param exists, it's the DEX page asking for data.
            // Otherwise, it's the Home page asking for CEX data.
            if (url.searchParams.has("network")) {
                const network = url.searchParams.get("network");
                return handleDexStatsWithCache(request, env, ctx, network);
            } else {
                return handleCexStats(request, env, ctx);
            }
        }
        
        // Fallback: Serve static assets
        return env.ASSETS.fetch(request);
    }
};

// ==========================================
// LOGIC: CEX (PRIMARY)
// ==========================================

async function handleSitemap(request, env) {
    const baseUrl = "https://cryptomovers.pages.dev";
    const now = new Date().toISOString();
    
    try {
        const manifestRes = await env.ASSETS.fetch(new URL("/urls.json", request.url));
        if (!manifestRes.ok) return new Response("Error: urls.json not found", { status: 500 });

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

async function handleCexStats(request, env, ctx) {
    if (!env.KV_STORE) {
        return new Response(JSON.stringify({ error: true, message: "KV_STORE binding missing" }), { status: 500, headers: CEX_HEADERS });
    }

    try {
        const [cachedRaw, lock] = await Promise.all([
            env.KV_STORE.get(CEX_CACHE_KEY),
            env.KV_STORE.get(CEX_CACHE_LOCK_KEY)
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

        const isUpdating = lock && (now - parseInt(lock)) < CEX_LOCK_TIMEOUT_MS;

        if (cachedData && dataAge < CEX_SOFT_REFRESH_MS) {
            return new Response(cachedRaw, { headers: { ...CEX_HEADERS, "X-Source": "Cache-Fresh" } });
        }

        if (isUpdating && cachedData) {
            return new Response(cachedRaw, { headers: { ...CEX_HEADERS, "X-Source": "Cache-UpdateInProgress" } });
        }

        if (cachedData && dataAge >= CEX_SOFT_REFRESH_MS) {
            const lastAttemptAge = now - (cachedData.lastUpdateAttempt || 0);
            
            if (lastAttemptAge >= CEX_MIN_RETRY_DELAY_MS) {
                console.log("Triggering Background Update...");
                
                await env.KV_STORE.put(CEX_CACHE_LOCK_KEY, now.toString(), { expirationTtl: Math.floor(CEX_LOCK_TIMEOUT_MS / 1000) });
                
                ctx.waitUntil(
                    updateCexDataSafe(env, cachedData, true)
                        .finally(() => env.KV_STORE.delete(CEX_CACHE_LOCK_KEY).catch(() => {}))
                );
                
                return new Response(cachedRaw, { headers: { ...CEX_HEADERS, "X-Source": "Cache-Proactive", "X-Update-Triggered": "Deep-Scan" } });
            } else {
                return new Response(cachedRaw, { headers: { ...CEX_HEADERS, "X-Source": "Cache-RateLimited" } });
            }
        }

        console.log("Cache empty. Starting Sprint...");
        await env.KV_STORE.put(CEX_CACHE_LOCK_KEY, now.toString(), { expirationTtl: Math.floor(CEX_LOCK_TIMEOUT_MS / 1000) });
        
        try {
            const freshJson = await fetchCexWithTimeout(env, false);
            await env.KV_STORE.put(CEX_CACHE_KEY, freshJson, { expirationTtl: 172800 });
            await env.KV_STORE.delete(CEX_CACHE_LOCK_KEY).catch(() => {});
            return new Response(freshJson, { headers: { ...CEX_HEADERS, "X-Source": "Live-Fetch-Sprint" } });
        } catch (error) {
            await env.KV_STORE.delete(CEX_CACHE_LOCK_KEY).catch(() => {});
            if (cachedData) {
                return new Response(JSON.stringify(cachedData), { headers: { ...CEX_HEADERS, "X-Source": "Cache-Fallback-Error" } });
            }
            throw error;
        }

    } catch (err) {
        return new Response(JSON.stringify({ error: true, message: err.message }), { status: 500, headers: CEX_HEADERS });
    }
}

async function getCexExclusions(env) {
    const exclusionSet = new Set();
    const baseUrl = "http://placeholder"; 

    await Promise.all(CEX_EXCLUSION_FILES.map(async (filePath) => {
        try {
            const res = await env.ASSETS.fetch(new URL(filePath, baseUrl));
            if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list)) {
                    list.forEach(item => exclusionSet.add(item.toLowerCase()));
                }
            }
        } catch (e) {
            console.warn(`Failed to load exclusion list: ${filePath}`, e);
        }
    }));
    return exclusionSet;
}

async function updateCexDataSafe(env, existingData, isDeepScan) {
    try { await updateCexData(env, existingData, isDeepScan); } catch (e) { console.error("Background update failed:", e); }
}

async function fetchCexWithTimeout(env, isDeepScan) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CEX_TIMEOUT_MS);
    
    try {
        const result = await updateCexData(env, null, isDeepScan, controller.signal);
        clearTimeout(timeoutId);
        return result;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error("Request timeout. Try again.");
        if (err.message.includes("Rate Limit") || err.message.includes("429")) throw new Error("CoinGecko Busy (429). Wait 1 min.");
        throw err;
    }
}

async function updateCexData(env, existingData, isDeepScan, signal = null) {
    const updateAttemptTime = Date.now();
    const pages = isDeepScan ? [1, 2, 3, 4, 5, 6] : [1];
    const perPage = 250; 
    let allCoins = [];
    let hitRateLimit = false;
    let lastError = null;
    
    const exclusionSet = await getCexExclusions(env);
    console.log(`Loaded ${exclusionSet.size} exclusions.`);

    const config = { headers: CEX_API_HEADERS };
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
                if (attempts < MAX_ATTEMPTS && !hitRateLimit) await new Promise(r => setTimeout(r, 2000 * attempts));
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
            await env.KV_STORE.put(CEX_CACHE_KEY, fallback, { expirationTtl: 300 });
            return fallback;
        }
        throw new Error(`Market data unavailable: ${lastError}`);
    }

    // Filter
    const valid = allCoins.filter(c => {
        if (!c || !c.symbol || c.price_change_percentage_24h == null || c.current_price == null) return false;
        const symbol = c.symbol.toLowerCase();
        if (exclusionSet.has(symbol)) return false;
        return true;
    });
    
    // Format
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
        excludedCount: allCoins.length - valid.length,
        isPartial: hitRateLimit,
        gainers,
        losers
    };

    const jsonString = JSON.stringify(finalObject);
    await env.KV_STORE.put(CEX_CACHE_KEY, jsonString, { expirationTtl: 172800 });
    return jsonString;
}

// ==========================================
// LOGIC: DEX
// ==========================================

function getDexStealthHeaders() {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    ];
    return {
        "User-Agent": agents[Math.floor(Math.random() * agents.length)],
        "Accept": "application/json",
        "Referer": "https://www.geckoterminal.com/",
        "Origin": "https://www.geckoterminal.com"
    };
}

async function handleImageProxy(request, env, url) {
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return new Response("Missing URL", { status: 400 });

    if (env.KV_STORE) {
        const imgKey = DEX_IMG_CACHE_PREFIX + btoa(targetUrl);
        const { value, metadata } = await env.KV_STORE.getWithMetadata(imgKey, { type: "stream" });
        if (value) {
            return new Response(value, {
                headers: {
                    "Content-Type": metadata?.contentType || "image/png",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "public, max-age=604800", 
                    "X-Source": "Worker-KV-Cache"
                }
            });
        }
    }

    try {
        const imgRes = await fetch(decodeURIComponent(targetUrl), {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        const newHeaders = new Headers(imgRes.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Cache-Control", "public, max-age=86400");
        return new Response(imgRes.body, { status: imgRes.status, headers: newHeaders });
    } catch (e) {
        return new Response("Proxy Error", { status: 500 });
    }
}

async function handleDexStatsWithCache(request, env, ctx, network) {
    if (!env.KV_STORE) {
        return handleDexStats(network); 
    }

    const cacheKey = `${DEX_KV_KEY_PREFIX}${network}`;
    const now = Date.now();
    let cached = null;
    let age = 0;

    try {
        const raw = await env.KV_STORE.get(cacheKey);
        if (raw) {
            cached = JSON.parse(raw);
            age = now - (cached.timestamp || 0);
        }
    } catch (e) { console.error("KV Error", e); }

    if (cached && age < DEX_SOFT_REFRESH_MS) {
        return new Response(JSON.stringify(cached), { headers: { ...DEX_HEADERS, "X-Source": "Cache-Fresh" } });
    }

    if (cached && age < DEX_HARD_REFRESH_MS) {
        ctx.waitUntil(refreshDexData(env, network, cacheKey, ctx));
        return new Response(JSON.stringify(cached), { headers: { ...DEX_HEADERS, "X-Source": "Cache-Stale-Background" } });
    }

    console.log(`Cache expired for ${network}. Fetching live...`);
    try {
        const freshData = await refreshDexData(env, network, cacheKey, ctx);
        return new Response(JSON.stringify(freshData), { headers: { ...DEX_HEADERS, "X-Source": "Live-Fetch" } });
    } catch (e) {
        if (cached) return new Response(JSON.stringify(cached), { headers: { ...DEX_HEADERS, "X-Source": "Cache-Fallback" } });
        return new Response(JSON.stringify({ error: true, message: e.message }), { status: 200, headers: DEX_HEADERS });
    }
}

async function refreshDexData(env, network, key, ctx) {
    const data = await handleDexStats(network); 
    if (data && !data.error && data.gainers) {
        await env.KV_STORE.put(key, JSON.stringify(data), { expirationTtl: 1800 });
        if (ctx && ctx.waitUntil) {
            const topTokens = [...data.gainers.slice(0, 20), ...data.losers.slice(0, 20)];
            ctx.waitUntil(backgroundDexCacheImages(env, topTokens));
        }
    }
    return data;
}

async function backgroundDexCacheImages(env, tokens) {
    if (!env.KV_STORE) return;
    const fetches = tokens.map(async (token) => {
        if (!token.image || token.image.includes("bullish.png")) return;
        const imgUrl = token.image;
        const imgKey = DEX_IMG_CACHE_PREFIX + btoa(imgUrl);
        try {
            const res = await fetch(imgUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (res.ok) {
                const blob = await res.arrayBuffer();
                const type = res.headers.get("Content-Type") || "image/png";
                await env.KV_STORE.put(imgKey, blob, { expirationTtl: 604800, metadata: { contentType: type } });
            }
        } catch (err) { console.log(`Failed to cache image for ${token.symbol}`); }
    });
    await Promise.all(fetches);
}

async function handleDexStats(networkKey) {
    const apiSlug = DEX_NETWORK_MAP[networkKey];
    if (!apiSlug) throw new Error("Invalid Network");

    try {
        const promises = [1, 2, 3, 4, 5].map(page => 
            fetch(`https://api.geckoterminal.com/api/v2/networks/${apiSlug}/trending_pools?include=base_token&page=${page}`, { 
                headers: getDexStealthHeaders() 
            })
        );

        const responses = await Promise.all(promises);
        let allPools = [];
        let allIncluded = [];

        for (const res of responses) {
            if (res.ok) {
                const data = await res.json();
                if (data.data) allPools = allPools.concat(data.data);
                if (data.included) allIncluded = allIncluded.concat(data.included);
            }
        }

        if (allPools.length === 0) throw new Error("Gecko API: No Pools Found");

        let formatted = allPools.map(pool => {
            const baseTokenId = pool.relationships?.base_token?.data?.id;
            const tokenData = allIncluded.find(i => i.id === baseTokenId && i.type === 'token');
            const attr = pool.attributes;
            const changes = attr.price_change_percentage || {};

            return {
                symbol: attr.name.split('/')[0].trim(),
                name: tokenData?.attributes?.name || attr.name,
                image: tokenData?.attributes?.image_url || "/images/bullish.png",
                price: parseFloat(attr.base_token_price_usd) || 0,
                change_30m: parseFloat(changes.m30) || 0,
                change_1h: parseFloat(changes.h1) || 0,
                change_6h: parseFloat(changes.h6) || 0,
                change_24h: parseFloat(changes.h24) || 0,
                volume_24h: parseFloat(attr.volume_usd?.h24) || 0,
                fdv: parseFloat(attr.fdv_usd) || 0,
                address: attr.address
            };
        });

        formatted = formatted.filter(p => p.price > 0 && p.volume_24h > 1000);

        const unique = [];
        const seen = new Set();
        for (const item of formatted) {
            if (!seen.has(item.symbol)) {
                seen.add(item.symbol);
                unique.push(item);
            }
        }

        const onlyGainers = unique.filter(x => x.change_24h > 0);
        const onlyLosers = unique.filter(x => x.change_24h < 0);

        const gainers = onlyGainers.sort((a, b) => b.change_24h - a.change_24h).slice(0, 50);
        const losers = onlyLosers.sort((a, b) => a.change_24h - b.change_24h).slice(0, 50);

        return {
            timestamp: Date.now(),
            network: networkKey,
            gainers,
            losers
        };

    } catch (e) {
        throw new Error(`Worker Error: ${e.message}`);
    }
}