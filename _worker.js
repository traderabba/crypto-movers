// _worker.js (MERGED VERSION)

// === SHARED CONFIGURATION ===
const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
};

const IMG_CACHE_PREFIX = "img_";

// === CRYPTO (COINGECKO) CONFIG ===
const CRYPTO_CACHE_KEY = "market_data_v7";
const CRYPTO_LOCK_KEY = "market_data_lock";
const CRYPTO_UPDATE_INTERVAL_MS = 15 * 60 * 1000;
const CRYPTO_SOFT_REFRESH_MS = 12 * 60 * 1000;
const CRYPTO_MIN_RETRY_DELAY_MS = 2 * 60 * 1000;
const CRYPTO_TIMEOUT_MS = 45000;
const CRYPTO_LOCK_TIMEOUT_MS = 120000;

const CRYPTO_EXCLUSION_FILES = [
    "/exclusions/stablecoins-exclusion-list.json",
    "/exclusions/wrapped-tokens-exclusion-list.json"
];

const CRYPTO_API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.coingecko.com/"
};

// === DEX (GEKKOTERMINAL) CONFIG ===
const DEX_CACHE_PREFIX = "dex_cache_";
const DEX_SOFT_REFRESH_MS = 4 * 60 * 1000;
const DEX_HARD_REFRESH_MS = 5 * 60 * 1000;

const NETWORK_MAP = {
    'solana': 'solana',
    'ethereum': 'eth',
    'bnb': 'bsc',
    'base': 'base'
};

// DEX stealth headers to prevent 403
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

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // === ROUTE 1: DYNAMIC SITEMAP (CRYPTO) ===
        if (url.pathname === "/sitemap.xml") {
            return handleSitemap(request, env);
        }

        // === ROUTE 2: IMAGE PROXY (SHARED) ===
        if (url.pathname === "/api/image-proxy") {
            return handleImageProxy(request, env, url);
        }

        // === ROUTE 3: SMART MARKET DATA ROUTING ===
        if (url.pathname === "/api/stats") {
            const network = url.searchParams.get("network");
            
            if (network) {
                // This is DEX page calling (has network parameter)
                console.log(`[ROUTER] DEX request for network: ${network}`);
                return handleDexStats(request, env, ctx, network);
            } else {
                // This is HOMEPAGE calling (no network parameter)
                console.log(`[ROUTER] Crypto request (homepage)`);
                return handleCryptoStats(request, env, ctx);
            }
        }

        // Fallback to assets
        return env.ASSETS.fetch(request);
    }
};

// ============================================
// CRYPTO (COINGECKO) FUNCTIONS
// ============================================
async function handleCryptoStats(request, env, ctx) {
    if (!env.KV_STORE) {
        return new Response(JSON.stringify({ error: true, message: "KV_STORE binding missing" }), { status: 500, headers: HEADERS });
    }

    try {
        const [cachedRaw, lock] = await Promise.all([
            env.KV_STORE.get(CRYPTO_CACHE_KEY),
            env.KV_STORE.get(CRYPTO_LOCK_KEY)
        ]);
        
        let cachedData = null;
        let dataAge = 0;
        const now = Date.now();

        if (cachedRaw) {
            try {
                cachedData = JSON.parse(cachedRaw);
                dataAge = now - (cachedData.timestamp || 0);
            } catch (e) { console.error("Crypto cache corrupted:", e); }
        }

        const isUpdating = lock && (now - parseInt(lock)) < CRYPTO_LOCK_TIMEOUT_MS;

        if (cachedData && dataAge < CRYPTO_SOFT_REFRESH_MS) {
            return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Crypto-Cache-Fresh" } });
        }

        if (isUpdating && cachedData) {
            return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Crypto-Cache-UpdateInProgress" } });
        }

        if (cachedData && dataAge >= CRYPTO_SOFT_REFRESH_MS) {
            const lastAttemptAge = now - (cachedData.lastUpdateAttempt || 0);
            
            if (lastAttemptAge >= CRYPTO_MIN_RETRY_DELAY_MS) {
                console.log("Crypto: Triggering Background Update...");
                
                await env.KV_STORE.put(CRYPTO_LOCK_KEY, now.toString(), { 
                    expirationTtl: Math.floor(CRYPTO_LOCK_TIMEOUT_MS / 1000) 
                });
                
                ctx.waitUntil(
                    updateCryptoMarketDataSafe(env, cachedData, true)
                        .finally(() => env.KV_STORE.delete(CRYPTO_LOCK_KEY).catch(() => {}))
                );
                
                return new Response(cachedRaw, { 
                    headers: { ...HEADERS, "X-Source": "Crypto-Cache-Proactive", "X-Update-Triggered": "Deep-Scan" } 
                });
            } else {
                return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Crypto-Cache-RateLimited" } });
            }
        }

        console.log("Crypto: Cache empty. Starting Sprint...");
        await env.KV_STORE.put(CRYPTO_LOCK_KEY, now.toString(), { 
            expirationTtl: Math.floor(CRYPTO_LOCK_TIMEOUT_MS / 1000) 
        });
        
        try {
            const freshJson = await fetchCryptoWithTimeout(env, false);
            
            await env.KV_STORE.put(CRYPTO_CACHE_KEY, freshJson, { expirationTtl: 172800 });
            await env.KV_STORE.delete(CRYPTO_LOCK_KEY).catch(() => {});
            
            return new Response(freshJson, { headers: { ...HEADERS, "X-Source": "Crypto-Live-Fetch-Sprint" } });
        } catch (error) {
            await env.KV_STORE.delete(CRYPTO_LOCK_KEY).catch(() => {});
            
            if (cachedData) {
                return new Response(JSON.stringify(cachedData), { 
                    headers: { ...HEADERS, "X-Source": "Crypto-Cache-Fallback-Error" } 
                });
            }
            throw error;
        }

    } catch (err) {
        return new Response(JSON.stringify({ error: true, message: err.message }), { 
            status: 500, headers: HEADERS 
        });
    }
}

// Crypto Helpers
async function getCryptoExclusions(env) {
    const exclusionSet = new Set();
    const baseUrl = "http://placeholder";

    await Promise.all(CRYPTO_EXCLUSION_FILES.map(async (filePath) => {
        try {
            const res = await env.ASSETS.fetch(new URL(filePath, baseUrl));
            if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list)) {
                    list.forEach(item => exclusionSet.add(item.toLowerCase()));
                }
            }
        } catch (e) {
            console.warn(`Failed to load crypto exclusion list: ${filePath}`, e);
        }
    }));
    
    return exclusionSet;
}

async function updateCryptoMarketDataSafe(env, existingData, isDeepScan) {
    try { 
        await updateCryptoMarketData(env, existingData, isDeepScan); 
    } catch (e) { 
        console.error("Crypto background update failed:", e); 
    }
}

async function fetchCryptoWithTimeout(env, isDeepScan) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CRYPTO_TIMEOUT_MS);
    
    try {
        const result = await updateCryptoMarketData(env, null, isDeepScan, controller.signal);
        clearTimeout(timeoutId);
        return result;
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error("Crypto request timeout. Try again.");
        if (err.message.includes("Rate Limit") || err.message.includes("429")) {
            throw new Error("CoinGecko Busy (429). Wait 1 min.");
        }
        throw err;
    }
}

async function updateCryptoMarketData(env, existingData, isDeepScan, signal = null) {
    const updateAttemptTime = Date.now();
    const pages = isDeepScan ? [1, 2, 3, 4, 5, 6] : [1];
    const perPage = 250;
    let allCoins = [];
    let hitRateLimit = false;
    let lastError = null;
    
    // Fetch exclusion lists
    const exclusionSet = await getCryptoExclusions(env);
    console.log(`Crypto: Loaded ${exclusionSet.size} exclusions.`);

    const config = { headers: CRYPTO_API_HEADERS };
    if (signal) config.signal = signal;

    for (const page of pages) {
        if (hitRateLimit) break;
        
        let success = false;
        let attempts = 0;
        const MAX_ATTEMPTS = 2;

        while (attempts < MAX_ATTEMPTS && !success && !hitRateLimit) {
            attempts++;
            try {
                const res = await fetch(
                    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=24h,7d,30d,1y`, 
                    config
                );
                
                if (res.status === 429) {
                    if (attempts >= MAX_ATTEMPTS) {
                        hitRateLimit = true;
                        lastError = "Rate limit reached";
                    }
                    throw new Error("Rate Limit");
                }
                
                if (!res.ok) throw new Error(`Crypto API Error: ${res.status}`);
                
                const data = await res.json();
                if (!Array.isArray(data)) throw new Error("Invalid Crypto Data");
                
                allCoins = allCoins.concat(data);
                success = true;
                
                if (pages.length > 1 && page < pages.length) {
                    await new Promise(r => setTimeout(r, 2000));
                }

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
                lastError: lastError || "Crypto fetch failed",
                timestamp: existingData.timestamp
            });
            await env.KV_STORE.put(CRYPTO_CACHE_KEY, fallback, { expirationTtl: 300 });
            return fallback;
        }
        throw new Error(`Crypto data unavailable: ${lastError}`);
    }

    // Filter using exclusion set
    const valid = allCoins.filter(c => {
        if (!c || !c.symbol || c.price_change_percentage_24h == null || c.current_price == null) {
            return false;
        }
        
        const symbol = c.symbol.toLowerCase();
        if (exclusionSet.has(symbol)) return false;

        return true;
    });
    
    // Format data for crypto frontend
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

    const gainers = [...valid].sort((a, b) => 
        b.price_change_percentage_24h - a.price_change_percentage_24h
    ).slice(0, 50).map(formatCoin);
    
    const losers = [...valid].sort((a, b) => 
        a.price_change_percentage_24h - b.price_change_percentage_24h
    ).slice(0, 50).map(formatCoin);

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
    await env.KV_STORE.put(CRYPTO_CACHE_KEY, jsonString, { expirationTtl: 172800 });
    return jsonString;
}

// ============================================
// DEX (GEKKOTERMINAL) FUNCTIONS
// ============================================
async function handleDexStats(request, env, ctx, network) {
    if (!env.KV_STORE) {
        return handleDexStatsDirect(network); // Fallback if no KV
    }

    const cacheKey = `${DEX_CACHE_PREFIX}${network}`;
    const now = Date.now();
    let cached = null;
    let age = 0;

    // Try to read cache
    try {
        const raw = await env.KV_STORE.get(cacheKey);
        if (raw) {
            cached = JSON.parse(raw);
            age = now - (cached.timestamp || 0);
        }
    } catch (e) { 
        console.error("DEX KV Error", e); 
    }

    // Strategy A: Fresh Cache (0-4 mins)
    if (cached && age < DEX_SOFT_REFRESH_MS) {
        return new Response(JSON.stringify(cached), { 
            headers: { ...HEADERS, "X-Source": "DEX-Cache-Fresh" } 
        });
    }

    // Strategy B: Stale Cache (4-5 mins) -> Return old data, update in background
    if (cached && age < DEX_HARD_REFRESH_MS) {
        ctx.waitUntil(refreshDexData(env, network, cacheKey, ctx));
        return new Response(JSON.stringify(cached), { 
            headers: { ...HEADERS, "X-Source": "DEX-Cache-Stale-Background" } 
        });
    }

    // Strategy C: Expired (>5 mins) -> Blocking update
    console.log(`DEX: Cache expired for ${network}. Fetching live...`);
    try {
        const freshData = await refreshDexData(env, network, cacheKey, ctx);
        return new Response(JSON.stringify(freshData), { 
            headers: { ...HEADERS, "X-Source": "DEX-Live-Fetch" } 
        });
    } catch (e) {
        if (cached) {
            return new Response(JSON.stringify(cached), { 
                headers: { ...HEADERS, "X-Source": "DEX-Cache-Fallback" } 
            });
        }
        return new Response(JSON.stringify({ error: true, message: e.message }), { 
            status: 200, headers: HEADERS 
        });
    }
}

async function refreshDexData(env, network, key, ctx) {
    const data = await handleDexStatsDirect(network); 
    
    if (data && !data.error && data.gainers) {
        // Save JSON data
        await env.KV_STORE.put(key, JSON.stringify(data), { expirationTtl: 1800 });
        
        // Trigger background image caching for top tokens
        if (ctx && ctx.waitUntil) {
            const topTokens = [
                ...data.gainers.slice(0, 20), 
                ...data.losers.slice(0, 20)
            ];
            ctx.waitUntil(backgroundCacheImages(env, topTokens));
        }
    }
    return data;
}

async function handleDexStatsDirect(networkKey) {
    const apiSlug = NETWORK_MAP[networkKey];
    if (!apiSlug) throw new Error("Invalid Network");

    try {
        // Fetch 5 pages to get deep data
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

        if (allPools.length === 0) throw new Error("GeckoTerminal API: No Pools Found");

        // Format for DEX frontend
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

        // FILTER: Remove scams ($0 price or <$1000 volume)
        formatted = formatted.filter(p => p.price > 0 && p.volume_24h > 1000);

        // Deduplicate
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
        throw new Error(`DEX Worker Error: ${e.message}`);
    }
}

// ============================================
// SHARED FUNCTIONS
// ============================================

// IMAGE PROXY (from DEX worker)
async function handleImageProxy(request, env, url) {
    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) return new Response("Missing URL", { status: 400 });

    // 1. Try to get from KV
    if (env.KV_STORE) {
        const imgKey = IMG_CACHE_PREFIX + btoa(targetUrl);
        
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

    // 2. If not in KV, download live
    try {
        const imgRes = await fetch(decodeURIComponent(targetUrl), {
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        
        const newHeaders = new Headers(imgRes.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Cache-Control", "public, max-age=86400");

        return new Response(imgRes.body, {
            status: imgRes.status,
            headers: newHeaders
        });
    } catch (e) {
        return new Response("Proxy Error", { status: 500 });
    }
}

// BACKGROUND IMAGE CACHING (from DEX worker)
async function backgroundCacheImages(env, tokens) {
    if (!env.KV_STORE) return;

    const fetches = tokens.map(async (token) => {
        if (!token.image || token.image.includes("bullish.png")) return;

        const imgUrl = token.image;
        const imgKey = IMG_CACHE_PREFIX + btoa(imgUrl);

        try {
            const res = await fetch(imgUrl, { 
                headers: { "User-Agent": "Mozilla/5.0" } 
            });

            if (res.ok) {
                const blob = await res.arrayBuffer();
                const type = res.headers.get("Content-Type") || "image/png";

                await env.KV_STORE.put(imgKey, blob, { 
                    expirationTtl: 604800, 
                    metadata: { contentType: type } 
                });
            }
        } catch (err) {
            console.log(`Failed to cache image for ${token.symbol}`);
        }
    });

    await Promise.all(fetches);
}

// SITEMAP (from Crypto worker)
async function handleSitemap(request, env) {
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