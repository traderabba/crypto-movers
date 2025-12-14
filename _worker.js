// _worker.js - FINAL MERGED VERSION
// Status: Production Ready - All fixes applied

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    SHARED: {
        HEADERS_JSON: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        },
        HEADERS_IMG: {
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=604800", // 7 Days
            "X-Source": "Worker-KV-Cache"
        }
    },
    CEX: {
        CACHE_KEY: "market_data_v7",
        LOCK_KEY: "market_data_lock",
        SOFT_REFRESH: 12 * 60 * 1000,     // 12 minutes
        MIN_RETRY_DELAY: 2 * 60 * 1000,   // 2 minutes
        TIMEOUT: 45000,                   // 45 seconds
        LOCK_TIMEOUT: 120000,             // 2 minutes
        UPDATE_INTERVAL: 15 * 60 * 1000,  // 15 minutes
        EXCLUSIONS: [
            "/exclusions/stablecoins-exclusion-list.json",
            "/exclusions/wrapped-tokens-exclusion-list.json"
        ],
        API_HEADERS: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.coingecko.com/"
        }
    },
    DEX: {
        CACHE_PREFIX: "dex_cache_",
        IMG_PREFIX: "img_",
        SOFT_REFRESH: 4 * 60 * 1000,   // 4 minutes
        HARD_REFRESH: 5 * 60 * 1000,   // 5 minutes
        NETWORKS: { 
            'solana': 'solana', 
            'ethereum': 'eth', 
            'bnb': 'bsc', 
            'base': 'base' 
        }
    }
};

// ============================================================================
// MODULE 1: SHARED UTILITIES
// ============================================================================
class SharedTools {
    static async handleSitemap(request, env) {
        const baseUrl = "https://cryptomovers.pages.dev";
        const now = new Date().toISOString();
        
        try {
            const manifestRes = await env.ASSETS.fetch(new URL("/urls.json", request.url));
            if (!manifestRes.ok) return new Response("Error: urls.json not found", { status: 500 });

            const pages = await manifestRes.json();
            let sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

            pages.forEach(page => {
                sitemap += `\n  <url>\n    <loc>${baseUrl}${page.path}</loc>\n    <lastmod>${now}</lastmod>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>`;
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
}

// ============================================================================
// MODULE 2: CEX WORKER (Homepage Logic - CoinGecko)
// ============================================================================
class CexWorker {
    constructor(env) {
        this.env = env;
        this.updateAttemptTime = Date.now();
    }

    async handleRequest(ctx) {
        if (!this.env.KV_STORE) {
            return this.#error("KV_STORE binding missing");
        }

        try {
            const [cachedRaw, lock] = await Promise.all([
                this.env.KV_STORE.get(CONFIG.CEX.CACHE_KEY),
                this.env.KV_STORE.get(CONFIG.CEX.LOCK_KEY)
            ]);
            
            const now = Date.now();
            let cachedData = null;
            let dataAge = 0;

            if (cachedRaw) {
                try {
                    cachedData = JSON.parse(cachedRaw);
                    dataAge = now - (cachedData.timestamp || 0);
                } catch (e) { 
                    console.error("CEX: Cache corrupted:", e); 
                }
            }

            const isUpdating = lock && (now - parseInt(lock)) < CONFIG.CEX.LOCK_TIMEOUT;

            // Strategy 1: Fresh Cache
            if (cachedData && dataAge < CONFIG.CEX.SOFT_REFRESH) {
                return this.#json(cachedRaw, "Crypto-Cache-Fresh");
            }

            // Strategy 2: Update in Progress
            if (isUpdating && cachedData) {
                return this.#json(cachedRaw, "Crypto-Cache-UpdateInProgress");
            }

            // Strategy 3: Stale -> Trigger Background Update
            if (cachedData && dataAge >= CONFIG.CEX.SOFT_REFRESH) {
                const lastAttemptAge = now - (cachedData.lastUpdateAttempt || 0);
                
                if (lastAttemptAge >= CONFIG.CEX.MIN_RETRY_DELAY) {
                    console.log("Crypto: Triggering Background Update...");
                    
                    await this.env.KV_STORE.put(CONFIG.CEX.LOCK_KEY, now.toString(), { 
                        expirationTtl: Math.floor(CONFIG.CEX.LOCK_TIMEOUT / 1000) 
                    });
                    
                    ctx.waitUntil(
                        this.#updateMarketDataSafe(cachedData, true)
                            .finally(() => this.env.KV_STORE.delete(CONFIG.CEX.LOCK_KEY).catch(() => {}))
                    );
                    
                    return this.#json(cachedRaw, "Crypto-Cache-Proactive");
                } else {
                    return this.#json(cachedRaw, "Crypto-Cache-RateLimited");
                }
            }

            // Strategy 4: No Cache -> Live Fetch
            console.log("Crypto: Cache empty. Starting Sprint...");
            await this.env.KV_STORE.put(CONFIG.CEX.LOCK_KEY, now.toString(), { 
                expirationTtl: Math.floor(CONFIG.CEX.LOCK_TIMEOUT / 1000) 
            });
            
            try {
                const freshJson = await this.#fetchWithTimeout(false);
                
                await this.env.KV_STORE.put(CONFIG.CEX.CACHE_KEY, freshJson, { expirationTtl: 172800 });
                await this.env.KV_STORE.delete(CONFIG.CEX.LOCK_KEY).catch(() => {});
                
                return this.#json(freshJson, "Crypto-Live-Fetch-Sprint");
            } catch (error) {
                await this.env.KV_STORE.delete(CONFIG.CEX.LOCK_KEY).catch(() => {});
                
                if (cachedData) {
                    // Return cached data with error metadata
                    const fallback = {
                        ...cachedData,
                        lastUpdateAttempt: now,
                        lastUpdateFailed: true,
                        lastError: error.message
                    };
                    await this.env.KV_STORE.put(CONFIG.CEX.CACHE_KEY, JSON.stringify(fallback), { expirationTtl: 300 });
                    return this.#json(fallback, "Crypto-Cache-Fallback-Error");
                }
                throw error;
            }

        } catch (err) {
            return this.#error(err.message);
        }
    }

    async #updateMarketDataSafe(existingData, isDeepScan) {
        try { 
            await this.#updateMarketData(existingData, isDeepScan); 
        } catch (e) { 
            console.error("Crypto background update failed:", e); 
        }
    }

    async #fetchWithTimeout(isDeepScan) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), CONFIG.CEX.TIMEOUT);
        
        try {
            const result = await this.#updateMarketData(null, isDeepScan, controller.signal);
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

    async #updateMarketData(existingData, isDeepScan, signal = null) {
        const updateAttemptTime = Date.now();
        const pages = isDeepScan ? [1, 2, 3, 4, 5, 6] : [1];
        const perPage = 250;
        let allCoins = [];
        let hitRateLimit = false;
        let lastError = null;
        
        // Fetch exclusion lists
        const exclusionSet = await this.#getExclusions();
        console.log(`Crypto: Loaded ${exclusionSet.size} exclusions.`);

        const config = { headers: CONFIG.CEX.API_HEADERS };
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
                await this.env.KV_STORE.put(CONFIG.CEX.CACHE_KEY, fallback, { expirationTtl: 300 });
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
        await this.env.KV_STORE.put(CONFIG.CEX.CACHE_KEY, jsonString, { expirationTtl: 172800 });
        return jsonString;
    }

    async #getExclusions() {
        const exclusionSet = new Set();
        const baseUrl = "http://placeholder";

        await Promise.all(CONFIG.CEX.EXCLUSIONS.map(async (filePath) => {
            try {
                const res = await this.env.ASSETS.fetch(new URL(filePath, baseUrl));
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

    #json(data, source) {
        return new Response(typeof data === 'string' ? data : JSON.stringify(data), {
            headers: { ...CONFIG.SHARED.HEADERS_JSON, "X-Source": source }
        });
    }

    #error(msg) {
        return new Response(JSON.stringify({ error: true, message: msg }), {
            status: 500, headers: CONFIG.SHARED.HEADERS_JSON
        });
    }
}

// ============================================================================
// MODULE 3: DEX WORKER (DexMovers Logic - GeckoTerminal)
// ============================================================================
class DexWorker {
    constructor(env) {
        this.env = env;
    }

    // --- IMAGE PROXY ---
    async handleImageProxy(urlStr) {
        const targetUrl = new URL(urlStr).searchParams.get("url");
        if (!targetUrl) return new Response("Missing URL", { status: 400 });

        // 1. Try KV Cache
        if (this.env.KV_STORE) {
            const key = CONFIG.DEX.IMG_PREFIX + btoa(targetUrl);
            const { value, metadata } = await this.env.KV_STORE.getWithMetadata(key, { type: "stream" });
            if (value) {
                return new Response(value, {
                    headers: { 
                        ...CONFIG.SHARED.HEADERS_IMG, 
                        "Content-Type": metadata?.contentType || "image/png" 
                    }
                });
            }
        }

        // 2. Fetch Live
        try {
            const res = await fetch(decodeURIComponent(targetUrl), { 
                headers: { "User-Agent": "Mozilla/5.0" } 
            });
            const headers = new Headers(res.headers);
            headers.set("Access-Control-Allow-Origin", "*");
            headers.set("Cache-Control", "public, max-age=86400"); // Browser: 1 day
            return new Response(res.body, { status: res.status, headers });
        } catch (e) {
            return new Response("Proxy Error", { status: 500 });
        }
    }

    // --- DEX STATS ---
    async handleStats(ctx, network) {
        if (!this.env.KV_STORE) return this.#fetchLive(network);

        const cacheKey = `${CONFIG.DEX.CACHE_PREFIX}${network}`;
        const now = Date.now();
        let cached = null;
        let age = 0;

        // Try to read cache
        try {
            const raw = await this.env.KV_STORE.get(cacheKey);
            if (raw) {
                cached = JSON.parse(raw);
                age = now - (cached.timestamp || 0);
            }
        } catch (e) { 
            console.error("DEX KV Error", e); 
        }

        // Strategy A: Fresh Cache (0-4 mins)
        if (cached && age < CONFIG.DEX.SOFT_REFRESH) {
            return this.#json(cached, "DEX-Cache-Fresh");
        }

        // Strategy B: Stale Cache (4-5 mins) -> Return old data, update in background
        if (cached && age < CONFIG.DEX.HARD_REFRESH) {
            ctx.waitUntil(this.#refreshData(network, cacheKey, ctx));
            return this.#json(cached, "DEX-Cache-Stale-Background");
        }

        // Strategy C: Expired (>5 mins) -> Blocking update
        console.log(`DEX: Cache expired for ${network}. Fetching live...`);
        try {
            const freshData = await this.#refreshData(network, cacheKey, ctx);
            return this.#json(freshData, "DEX-Live-Fetch");
        } catch (e) {
            if (cached) {
                return this.#json(cached, "DEX-Cache-Fallback");
            }
            return this.#error(e.message);
        }
    }

    async #refreshData(network, key, ctx) {
        const data = await this.#fetchLive(network); 
        
        if (data && !data.error && data.gainers) {
            // Save JSON data
            await this.env.KV_STORE.put(key, JSON.stringify(data), { expirationTtl: 1800 });
            
            // Trigger background image caching for top tokens
            if (ctx && ctx.waitUntil) {
                const topTokens = [
                    ...data.gainers.slice(0, 20), 
                    ...data.losers.slice(0, 20)
                ];
                ctx.waitUntil(this.#backgroundCacheImages(topTokens));
            }
        }
        return data;
    }

    async #backgroundCacheImages(tokens) {
        if (!this.env.KV_STORE) return;

        const fetches = tokens.map(async (token) => {
            if (!token.image || token.image.includes("bullish.png")) return;

            const imgUrl = token.image;
            const imgKey = CONFIG.DEX.IMG_PREFIX + btoa(imgUrl);

            try {
                const res = await fetch(imgUrl, { 
                    headers: { "User-Agent": "Mozilla/5.0" } 
                });

                if (res.ok) {
                    const blob = await res.arrayBuffer();
                    const type = res.headers.get("Content-Type") || "image/png";

                    await this.env.KV_STORE.put(imgKey, blob, { 
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

    async #fetchLive(networkKey) {
        const apiSlug = CONFIG.DEX.NETWORKS[networkKey];
        if (!apiSlug) throw new Error("Invalid Network");

        // Stealth headers to prevent 403
        const getStealthHeaders = () => {
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
        };

        try {
            // Fetch 5 pages to get deep data
            const promises = [1, 2, 3, 4, 5].map(page => 
                fetch(`https://api.geckoterminal.com/api/v2/networks/${apiSlug}/trending_pools?include=base_token&page=${page}`, { 
                    headers: getStealthHeaders() 
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

    #json(data, source) {
        return new Response(JSON.stringify(data), {
            headers: { ...CONFIG.SHARED.HEADERS_JSON, "X-Source": source }
        });
    }

    #error(msg) {
        return new Response(JSON.stringify({ error: true, message: msg }), { 
            status: 500, 
            headers: CONFIG.SHARED.HEADERS_JSON 
        });
    }
}

// ============================================================================
// MAIN ROUTER
// ============================================================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. Sitemap
        if (url.pathname === "/sitemap.xml") {
            return SharedTools.handleSitemap(request, env);
        }

        // 2. Image Proxy
        if (url.pathname === "/api/image-proxy") {
            return new DexWorker(env).handleImageProxy(request.url);
        }

        // 3. Stats API (Smart Routing Based on Network Parameter)
        if (url.pathname === "/api/stats") {
            const network = url.searchParams.get("network");
            
            if (network) {
                // DEX Page Request (has network parameter)
                console.log(`[ROUTER] DEX request for network: ${network}`);
                return new DexWorker(env).handleStats(ctx, network);
            } else {
                // Homepage Request (no network parameter)
                console.log(`[ROUTER] Crypto request (homepage)`);
                return new CexWorker(env).handleRequest(ctx);
            }
        }

        // 4. Fallback to Static Assets
        return env.ASSETS.fetch(request);
    }
};