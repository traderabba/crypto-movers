// _worker.js
// Architecture: Single-File Modular (Class-Based)
// Status: Ready for Production

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
        SOFT_REFRESH: 12 * 60 * 1000,
        TIMEOUT: 45000,
        LOCK_TIMEOUT: 120000,
        EXCLUSIONS: [
            "/exclusions/stablecoins-exclusion-list.json",
            "/exclusions/wrapped-tokens-exclusion-list.json"
        ],
        API_HEADERS: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json, text/plain, */*",
            "Referer": "https://www.coingecko.com/"
        }
    },
    DEX: {
        CACHE_PREFIX: "dex_cache_",
        IMG_PREFIX: "img_",
        SOFT_REFRESH: 4 * 60 * 1000,
        HARD_REFRESH: 5 * 60 * 1000,
        NETWORKS: { 
            'solana': 'solana', 
            'ethereum': 'eth', 
            'bnb': 'bsc', 
            'base': 'base' 
        }
    }
};

// ============================================================================
// MODULE 1: SHARED UTILITIES (Sitemap & Tools)
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
// MODULE 2: CEX WORKER (Homepage Logic)
// ============================================================================
class CexWorker {
    constructor(env) {
        this.env = env;
    }

    async handleRequest(ctx) {
        if (!this.env.KV_STORE) return this.#error("KV_STORE binding missing");

        try {
            const [cachedRaw, lock] = await Promise.all([
                this.env.KV_STORE.get(CONFIG.CEX.CACHE_KEY),
                this.env.KV_STORE.get(CONFIG.CEX.LOCK_KEY)
            ]);

            const now = Date.now();
            let cached = null;
            let age = 0;

            if (cachedRaw) {
                try {
                    cached = JSON.parse(cachedRaw);
                    age = now - (cached.timestamp || 0);
                } catch (e) { console.error("Cache corrupted:", e); }
            }

            const isUpdating = lock && (now - parseInt(lock)) < CONFIG.CEX.LOCK_TIMEOUT;

            // Strategy 1: Fresh Cache
            if (cached && age < CONFIG.CEX.SOFT_REFRESH) {
                return this.#json(cachedRaw, "Cache-Fresh");
            }

            // Strategy 2: Update in Progress
            if (isUpdating && cached) {
                return this.#json(cachedRaw, "Cache-UpdateInProgress");
            }

            // Strategy 3: Stale -> Background Update
            if (cached) {
                const lastAttemptAge = now - (cached.lastUpdateAttempt || 0);
                if (lastAttemptAge >= (2 * 60 * 1000)) { // Min retry delay
                    await this.env.KV_STORE.put(CONFIG.CEX.LOCK_KEY, now.toString(), { expirationTtl: 120 });
                    ctx.waitUntil(
                        this.#updateData(cached, true)
                            .finally(() => this.env.KV_STORE.delete(CONFIG.CEX.LOCK_KEY).catch(() => {}))
                    );
                    return this.#json(cachedRaw, "Cache-Proactive");
                }
                return this.#json(cachedRaw, "Cache-RateLimited");
            }

            // Strategy 4: No Cache -> Live Fetch (Sprint)
            await this.env.KV_STORE.put(CONFIG.CEX.LOCK_KEY, now.toString(), { expirationTtl: 120 });
            try {
                const fresh = await this.#fetchWithTimeout(false);
                await this.env.KV_STORE.put(CONFIG.CEX.CACHE_KEY, fresh, { expirationTtl: 172800 });
                await this.env.KV_STORE.delete(CONFIG.CEX.LOCK_KEY).catch(() => {});
                return this.#json(fresh, "Live-Fetch-Sprint");
            } catch (error) {
                await this.env.KV_STORE.delete(CONFIG.CEX.LOCK_KEY).catch(() => {});
                if (cached) return this.#json(cached, "Cache-Fallback-Error");
                throw error;
            }

        } catch (e) {
            return this.#error(e.message);
        }
    }

    async #updateData(existingData, isDeepScan) {
        try {
            const fresh = await this.#fetchWithTimeout(isDeepScan);
            await this.env.KV_STORE.put(CONFIG.CEX.CACHE_KEY, fresh, { expirationTtl: 172800 });
        } catch (e) { console.error("CEX Background Update Failed", e); }
    }

    async #fetchWithTimeout(isDeepScan) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), CONFIG.CEX.TIMEOUT);
        try {
            const res = await this.#performFetch(isDeepScan, controller.signal);
            clearTimeout(id);
            return res;
        } catch (e) {
            clearTimeout(id);
            if (e.name === 'AbortError') throw new Error("Request timeout");
            throw e;
        }
    }

    async #performFetch(isDeepScan, signal) {
        const pages = isDeepScan ? [1, 2, 3, 4, 5, 6] : [1];
        let allCoins = [];
        let hitRateLimit = false;
        
        // Load Exclusions
        const exclusionSet = await this.#getExclusions();
        const config = { headers: CONFIG.CEX.API_HEADERS, signal };

        for (const page of pages) {
            if (hitRateLimit) break;
            try {
                const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&price_change_percentage=24h,7d,30d,1y`;
                const res = await fetch(url, config);
                
                if (res.status === 429) { hitRateLimit = true; break; }
                if (!res.ok) continue;
                
                const data = await res.json();
                if (Array.isArray(data)) allCoins = allCoins.concat(data);
                
                if (pages.length > 1 && page < pages.length) await new Promise(r => setTimeout(r, 2000));
            } catch (e) { break; }
        }

        if (allCoins.length === 0) throw new Error("No CEX data fetched");

        // Filter
        const valid = allCoins.filter(c => {
            if (!c || !c.symbol || !c.current_price) return false;
            return !exclusionSet.has(c.symbol.toLowerCase());
        });

        // Format
        const formatCoin = (c) => ({
            id: c.id, symbol: c.symbol, name: c.name, image: c.image,
            current_price: c.current_price, market_cap: c.market_cap,
            total_volume: c.total_volume,
            price_change_percentage_24h: c.price_change_percentage_24h,
            price_change_percentage_7d: c.price_change_percentage_7d_in_currency,
            price_change_percentage_30d: c.price_change_percentage_30d_in_currency,
            price_change_percentage_1y: c.price_change_percentage_1y_in_currency
        });

        const gainers = [...valid].sort((a, b) => b.price_change_percentage_24h - a.price_change_percentage_24h).slice(0, 50).map(formatCoin);
        const losers = [...valid].sort((a, b) => a.price_change_percentage_24h - b.price_change_percentage_24h).slice(0, 50).map(formatCoin);

        return JSON.stringify({
            timestamp: Date.now(),
            totalScanned: allCoins.length,
            isPartial: hitRateLimit,
            gainers, losers
        });
    }

    async #getExclusions() {
        const set = new Set();
        const baseUrl = "http://placeholder"; // Internal fetch
        await Promise.all(CONFIG.CEX.EXCLUSIONS.map(async (filePath) => {
            try {
                const res = await this.env.ASSETS.fetch(new URL(filePath, baseUrl));
                if (res.ok) {
                    const list = await res.json();
                    if (Array.isArray(list)) list.forEach(i => set.add(i.toLowerCase()));
                }
            } catch (e) { /* ignore missing */ }
        }));
        return set;
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
// MODULE 3: DEX WORKER (DexMovers Logic)
// ============================================================================
class DexWorker {
    constructor(env) {
        this.env = env;
    }

    // --- SUB-FEATURE: IMAGE PROXY ---
    async handleImageProxy(urlStr) {
        const targetUrl = new URL(urlStr).searchParams.get("url");
        if (!targetUrl) return new Response("Missing URL", { status: 400 });

        // 1. Try KV Cache
        if (this.env.KV_STORE) {
            const key = CONFIG.DEX.IMG_PREFIX + btoa(targetUrl);
            const { value, metadata } = await this.env.KV_STORE.getWithMetadata(key, { type: "stream" });
            if (value) {
                return new Response(value, {
                    headers: { ...CONFIG.SHARED.HEADERS_IMG, "Content-Type": metadata?.contentType || "image/png" }
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

    // --- MAIN FEATURE: DEX STATS ---
    async handleStats(ctx, network) {
        if (!this.env.KV_STORE) return this.#fetchLive(network);

        const key = CONFIG.DEX.CACHE_PREFIX + network;
        const raw = await this.env.KV_STORE.get(key);
        let cached = null;
        let age = 999999;

        if (raw) {
            try {
                cached = JSON.parse(raw);
                age = Date.now() - (cached.timestamp || 0);
            } catch(e) {}
        }

        // 1. Fresh Cache
        if (cached && age < CONFIG.DEX.SOFT_REFRESH) {
            return this.#json(cached, "Cache-Fresh");
        }

        // 2. Stale Cache (Background Update)
        if (cached && age < CONFIG.DEX.HARD_REFRESH) {
            ctx.waitUntil(this.#bgRefresh(network, key, ctx));
            return this.#json(cached, "Cache-Stale-Background");
        }

        // 3. Live Fetch (Blocking)
        try {
            const fresh = await this.#fetchLive(network);
            await this.env.KV_STORE.put(key, JSON.stringify(fresh), { expirationTtl: 1800 });
            // Deep Scan Images
            if(ctx && ctx.waitUntil) ctx.waitUntil(this.#cacheImages(fresh));
            return this.#json(fresh, "Live-Fetch");
        } catch (e) {
            if (cached) return this.#json(cached, "Cache-Fallback");
            return this.#error(e.message);
        }
    }

    async #bgRefresh(network, key, ctx) {
        try {
            const data = await this.#fetchLive(network);
            await this.env.KV_STORE.put(key, JSON.stringify(data), { expirationTtl: 1800 });
            await this.#cacheImages(data);
        } catch (e) { console.log("DEX BG Update Failed"); }
    }

    async #cacheImages(data) {
        if (!this.env.KV_STORE) return;
        const tokens = [...data.gainers.slice(0, 20), ...data.losers.slice(0, 20)];
        const fetches = tokens.map(async (token) => {
            if (!token.image || token.image.includes("bullish.png")) return;
            const imgKey = CONFIG.DEX.IMG_PREFIX + btoa(token.image);
            try {
                const res = await fetch(token.image, { headers: { "User-Agent": "Mozilla/5.0" } });
                if (res.ok) {
                    const blob = await res.arrayBuffer();
                    const type = res.headers.get("Content-Type") || "image/png";
                    await this.env.KV_STORE.put(imgKey, blob, { expirationTtl: 604800, metadata: { contentType: type } });
                }
            } catch (err) {}
        });
        await Promise.all(fetches);
    }

    async #fetchLive(networkKey) {
        const slug = CONFIG.DEX.NETWORKS[networkKey];
        if (!slug) throw new Error("Invalid Network");

        // Stealth Headers
        const headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Referer": "https://www.geckoterminal.com/",
            "Origin": "https://www.geckoterminal.com"
        };

        const promises = [1, 2, 3, 4, 5].map(page => 
            fetch(`https://api.geckoterminal.com/api/v2/networks/${slug}/trending_pools?include=base_token&page=${page}`, { headers })
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

        if (allPools.length === 0) throw new Error("No Pools Found");

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

        // Filtering
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

        return {
            timestamp: Date.now(),
            network: networkKey,
            gainers: onlyGainers.sort((a, b) => b.change_24h - a.change_24h).slice(0, 50),
            losers: onlyLosers.sort((a, b) => a.change_24h - b.change_24h).slice(0, 50)
        };
    }

    #json(data, source) {
        return new Response(JSON.stringify(data), {
            headers: { ...CONFIG.SHARED.HEADERS_JSON, "X-Source": source }
        });
    }

    #error(msg) {
        return new Response(JSON.stringify({ error: true, message: msg }), { status: 500 });
    }
}

// ============================================================================
// MAIN ROUTER (Default Export)
// ============================================================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. Sitemap
        if (url.pathname === "/sitemap.xml") {
            return SharedTools.handleSitemap(request, env);
        }

        // 2. Image Proxy (Route to DEX Logic)
        if (url.pathname === "/api/image-proxy") {
            return new DexWorker(env).handleImageProxy(request.url);
        }

        // 3. Stats API (The Smart Switch)
        if (url.pathname === "/api/stats") {
            const network = url.searchParams.get("network");
            
            if (network) {
                // If "network" is present, it's definitely the DEX page
                return new DexWorker(env).handleStats(ctx, network);
            } else {
                // If no "network", it's the Homepage (CEX)
                return new CexWorker(env).handleRequest(ctx);
            }
        }

        // 4. Fallback to Static Assets
        return env.ASSETS.fetch(request);
    }
};