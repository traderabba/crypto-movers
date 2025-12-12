// _worker.js

// === CONFIGURATION ===
const CACHE_KEY = "market_data_v7"; 
const CACHE_LOCK_KEY = "market_data_lock";

// --- CEX TIMERS ---
const CEX_SOFT_REFRESH_MS = 12 * 60 * 1000;    
const CEX_RETRY_DELAY_MS = 2 * 60 * 1000;      
const TIMEOUT_MS = 45000; 

// --- DEX TIMERS ---
const DEX_CACHE_KEY = "dex_data_v7"; // Version bump      
const DEX_LOCK_KEY = "dex_data_lock";
const NETWORKS_CACHE_KEY = "dex_networks_map"; // Cache for network slugs          
const DEX_SOFT_REFRESH_MS = 18 * 60 * 1000;    
const DEX_LOCK_TIMEOUT_MS = 120000;            

// === EXCLUSION FILES ===
const EXCLUSION_FILES = [
    "/exclusions/stablecoins-exclusion-list.json",
    "/exclusions/wrapped-tokens-exclusion-list.json",
    "/exclusions/rewards-tokens-exclusion-list.json"
];

const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    "Pragma": "no-cache",
    "Expires": "0"
};

const API_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json",
    "Referer": "https://www.coingecko.com/"
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // === ROUTE 1: SITEMAP ===
        if (url.pathname === "/sitemap.xml") {
            return handleSitemap(request, env);
        }

        // === ROUTE 2: CEX MARKET DATA ===
        if (url.pathname === "/api/stats") {
            if (!env.KV_STORE) return new Response(JSON.stringify({ error: true, message: "KV_STORE binding missing" }), { status: 500, headers: HEADERS });
            return handleCexStats(request, env, ctx);
        }

        // === ROUTE 3: DEX DATA (CMC) ===
        if (url.pathname === "/api/dex-stats") {
            if (!env.CMC_PRO_API_KEY) {
                return new Response(JSON.stringify({ error: true, message: "Server Config Error: Missing CMC Key" }), { status: 500, headers: HEADERS });
            }
            return handleDexStats(request, env, ctx);
        }
        
        return env.ASSETS.fetch(request);
    }
};

// ==========================================
// 1. CEX HANDLER (CoinGecko Logic)
// ==========================================
async function handleCexStats(request, env, ctx) {
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
            } catch (e) {}
        }

        const isUpdating = lock && (now - parseInt(lock)) < DEX_LOCK_TIMEOUT_MS;

        if (cachedData && dataAge < CEX_SOFT_REFRESH_MS) {
            return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-Fresh" } });
        }
        if (isUpdating && cachedData) {
            return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-UpdateInProgress" } });
        }
        if (cachedData && dataAge >= CEX_SOFT_REFRESH_MS) {
            const lastAttemptAge = now - (cachedData.lastUpdateAttempt || 0);
            if (lastAttemptAge >= CEX_RETRY_DELAY_MS) {
                await env.KV_STORE.put(CACHE_LOCK_KEY, now.toString(), { expirationTtl: 120 });
                ctx.waitUntil(updateMarketDataSafe(env, cachedData, true).finally(() => env.KV_STORE.delete(CACHE_LOCK_KEY).catch(() => {})));
                return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-Proactive" } });
            }
            return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-RateLimited" } });
        }

        await env.KV_STORE.put(CACHE_LOCK_KEY, now.toString(), { expirationTtl: 120 });
        try {
            const freshJson = await fetchWithTimeout(env, false);
            await env.KV_STORE.put(CACHE_KEY, freshJson, { expirationTtl: 172800 });
            await env.KV_STORE.delete(CACHE_LOCK_KEY).catch(() => {});
            return new Response(freshJson, { headers: { ...HEADERS, "X-Source": "Live-Fetch-Sprint" } });
        } catch (error) {
            await env.KV_STORE.delete(CACHE_LOCK_KEY).catch(() => {});
            if (cachedData) return new Response(JSON.stringify(cachedData), { headers: { ...HEADERS, "X-Source": "Cache-Fallback-Error" } });
            throw error;
        }
    } catch (err) {
        return new Response(JSON.stringify({ error: true, message: err.message }), { status: 500, headers: HEADERS });
    }
}

// ==========================================
// 2. DEX HANDLER (CMC Logic)
// ==========================================
async function handleDexStats(request, env, ctx) {
    const url = new URL(request.url);
    const requestedNetwork = url.searchParams.get("network") || "all";

    try {
        const [cachedRaw, lock] = await Promise.all([
            env.KV_STORE.get(DEX_CACHE_KEY),
            env.KV_STORE.get(DEX_LOCK_KEY)
        ]);

        let dexData = null;
        let dataAge = 0;
        const now = Date.now();

        if (cachedRaw) {
            try {
                dexData = JSON.parse(cachedRaw);
                dataAge = now - (dexData.timestamp || 0);
            } catch (e) { console.error("DEX Cache Corrupt"); }
        }

        const isUpdating = lock && (now - parseInt(lock)) < DEX_LOCK_TIMEOUT_MS;

        // Filter Logic
        const filterResponse = (fullData, source) => {
            const mappings = { "solana": "Solana", "eth": "Ethereum", "bsc": "BNB Smart Chain (BEP20)", "base": "Base" };
            const target = mappings[requestedNetwork];
            
            let pairs = fullData.pairs || [];
            if (target) pairs = pairs.filter(p => p.platform === target || p.platform.includes(target));

            const gainers = [...pairs].sort((a, b) => b.change_24h - a.change_24h).slice(0, 20);
            const losers = [...pairs].sort((a, b) => a.change_24h - b.change_24h).slice(0, 20);

            return new Response(JSON.stringify({
                timestamp: fullData.timestamp,
                network: requestedNetwork,
                gainers,
                losers
            }), { headers: { ...HEADERS, "X-Source": source } });
        };

        if (dexData && dataAge < DEX_SOFT_REFRESH_MS) {
            return filterResponse(dexData, "Cache-Fresh");
        }
        if (isUpdating && dexData) {
            return filterResponse(dexData, "Cache-UpdateInProgress");
        }
        if (dexData && dataAge >= DEX_SOFT_REFRESH_MS) {
            await env.KV_STORE.put(DEX_LOCK_KEY, now.toString(), { expirationTtl: 120 });
            ctx.waitUntil(
                fetchCMC_DEX(env)
                    .then(newData => env.KV_STORE.put(DEX_CACHE_KEY, JSON.stringify(newData), { expirationTtl: 172800 }))
                    .catch(e => console.error("DEX BG Fail", e))
                    .finally(() => env.KV_STORE.delete(DEX_LOCK_KEY).catch(() => {}))
            );
            return filterResponse(dexData, "Cache-Proactive"); 
        }

        // Blocking Fetch
        await env.KV_STORE.put(DEX_LOCK_KEY, now.toString(), { expirationTtl: 120 });
        try {
            const freshData = await fetchCMC_DEX(env);
            await env.KV_STORE.put(DEX_CACHE_KEY, JSON.stringify(freshData), { expirationTtl: 172800 });
            await env.KV_STORE.delete(DEX_LOCK_KEY).catch(() => {});
            return filterResponse(freshData, "Live-Fetch-Sprint");
        } catch (e) {
            await env.KV_STORE.delete(DEX_LOCK_KEY).catch(() => {});
            if (dexData) return filterResponse(dexData, "Cache-Fallback-Error");
            return new Response(JSON.stringify({ error: true, message: e.message }), { status: 500, headers: HEADERS });
        }

    } catch (e) {
        return new Response(JSON.stringify({ error: true, message: e.message }), { status: 500, headers: HEADERS });
    }
}

// === NEW: NETWORK SLUG DISCOVERY ===
async function getNetworkSlugsString(env) {
    // 1. Check Cache
    const cached = await env.KV_STORE.get(NETWORKS_CACHE_KEY);
    if(cached) return cached;

    // 2. Fetch from CMC
    try {
        const res = await fetch('https://pro-api.coinmarketcap.com/v4/dex/networks/list', {
            headers: { 'X-CMC_PRO_API_KEY': env.CMC_PRO_API_KEY }
        });
        
        if(!res.ok) throw new Error("Failed to fetch networks");
        
        const json = await res.json();
        const networks = json.data || [];
        
        // Find our target slugs
        const targetNames = ["Ethereum", "BNB", "Solana", "Base"];
        const foundSlugs = [];

        networks.forEach(n => {
            // Check if name matches any target (Case insensitive check)
            const name = n.name.toLowerCase();
            const slug = n.network_slug;
            
            if (name.includes("ethereum") || name.includes("bnb") || name.includes("solana") || name.includes("base") || name.includes("binance")) {
                if(slug) foundSlugs.push(slug);
            }
        });

        // Ensure we at least have safe defaults if detection fails slightly
        const finalString = foundSlugs.length > 0 ? foundSlugs.join(',') : "ethereum,solana,bnb,base";
        
        // Cache for 24 Hours
        await env.KV_STORE.put(NETWORKS_CACHE_KEY, finalString, { expirationTtl: 86400 });
        return finalString;

    } catch(e) {
        console.error("Network Discovery Failed:", e);
        return "ethereum,solana,bnb,base"; // Fallback
    }
}

// === CMC FETCH FUNCTION (AUTO-DETECTED SLUGS) ===
async function fetchCMC_DEX(env) {
    const apiKey = env.CMC_PRO_API_KEY;
    const exclusionSet = await getExclusions(env);
    
    // 1. GET CORRECT NETWORK SLUGS DYNAMICALLY
    const networkSlugs = await getNetworkSlugsString(env);
    console.log("Using Network Slugs:", networkSlugs);

    const PAGES_TO_FETCH = 3; 
    let allPairs = [];
    let nextScrollId = null;

    for (let i = 0; i < PAGES_TO_FETCH; i++) {
        try {
            let url = `https://pro-api.coinmarketcap.com/v4/dex/spot-pairs/latest?limit=100&sort=percent_change_24h&sort_dir=desc&network_slug=${networkSlugs}&liquidity_min=20000`;
            
            if (nextScrollId) {
                url += `&scroll_id=${nextScrollId}`;
            }

            const dexRes = await fetch(url, {
                headers: { 'X-CMC_PRO_API_KEY': apiKey }
            });

            if (!dexRes.ok) {
                 if(i===0) {
                     const txt = await dexRes.text();
                     try {
                        const errObj = JSON.parse(txt);
                        throw new Error(`CMC Error: ${errObj.status?.error_message || txt}`);
                     } catch(e) {
                        throw new Error(`CMC Error: ${txt}`);
                     }
                 }
                 break; 
            }

            const dexJson = await dexRes.json();
            const pairs = dexJson.data || [];
            
            if (pairs.length === 0) break;

            allPairs = allPairs.concat(pairs);
            nextScrollId = dexJson.status?.scroll_id || dexJson.scroll_id; 
            if (!nextScrollId) break; 

        } catch (e) {
            console.error(`Page ${i+1} fetch failed:`, e);
            if(i===0) throw e; 
            break; 
        }
    }

    // 2. FILTERING LOGIC (With FAKE MC Trap)
    const filteredRaw = allPairs.filter(p => {
        const symbol = p.base_asset_symbol || "";
        if (exclusionSet.has(symbol.toLowerCase())) return false;
        
        // Liquidity Check > 20k
        const liquidity = parseFloat(p.liquidity || 0);
        if (liquidity < 20000) return false;

        // FAKE MC Trap: MC > 3M but Liq < 150k
        const mc = parseFloat(p.fully_diluted_value || p.market_cap || 0);
        if (mc > 3000000 && liquidity < 150000) return false;

        return true;
    });

    // 3. Side-load Metadata
    const top100ForMetadata = filteredRaw.slice(0, 100);
    const assetIds = [...new Set(top100ForMetadata.map(p => p.base_asset_id))].filter(id => id);
    
    let logoMap = {};
    if (assetIds.length > 0) {
        try {
            const metaRes = await fetch(`https://pro-api.coinmarketcap.com/v2/cryptocurrency/info?id=${assetIds.join(',')}`, {
                headers: { 'X-CMC_PRO_API_KEY': apiKey }
            });
            if (metaRes.ok) {
                const metaJson = await metaRes.json();
                Object.values(metaJson.data || {}).forEach(info => { logoMap[info.id] = info.logo; });
            }
        } catch (e) { console.error("Metadata fetch failed", e); }
    }

    const formattedPairs = filteredRaw.map(p => ({
        name: p.base_asset_name,
        symbol: p.base_asset_symbol,
        contract: p.base_asset_contract_address,
        platform: p.platform ? p.platform.name : "Unknown",
        price: p.price,
        change_24h: p.percent_change_24h,
        volume_24h: p.volume_24h,
        dex_url: p.dex_url, 
        image: logoMap[p.base_asset_id] || "https://cryptomovers.pages.dev/images/generic-coin.png"
    }));

    return {
        timestamp: Date.now(),
        pairs: formattedPairs
    };
}

// === SHARED HELPERS ===
async function handleSitemap(request, env) {
    const baseUrl = "https://cryptomovers.pages.dev";
    try {
        const manifestRes = await env.ASSETS.fetch(new URL("/urls.json", request.url));
        if (!manifestRes.ok) return new Response("Error", { status: 500 });
        const pages = await manifestRes.json();
        let sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
        pages.forEach(p => sitemap += `<url><loc>${baseUrl}${p.path}</loc><lastmod>${new Date().toISOString()}</lastmod><changefreq>${p.changefreq}</changefreq></url>`);
        return new Response(sitemap + `</urlset>`, { headers: { "Content-Type": "application/xml" } });
    } catch (e) { return new Response("Error", { status: 500 }); }
}

async function getExclusions(env) {
    const exclusionSet = new Set();
    const baseUrl = "http://placeholder"; 
    await Promise.all(EXCLUSION_FILES.map(async (filePath) => {
        try {
            const res = await env.ASSETS.fetch(new URL(filePath, baseUrl));
            if (res.ok) {
                const list = await res.json();
                if (Array.isArray(list)) list.forEach(item => exclusionSet.add(item.toLowerCase()));
            }
        } catch (e) {}
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
        throw err;
    }
}

// === CEX FETCH LOGIC ===
async function updateMarketData(env, existingData, isDeepScan, signal = null) {
    const perPage = 250; 
    let allCoins = [];
    const exclusionSet = await getExclusions(env);
    
    const pages = isDeepScan ? [1, 2, 3, 4, 5, 6] : [1];
    let hitRateLimit = false;
    const config = { headers: API_HEADERS };
    if (signal) config.signal = signal;

    for (const page of pages) {
        if (hitRateLimit) break;
        let attempts = 0;
        let success = false;
        while(attempts < 2 && !success) {
            attempts++;
            try {
                const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=24h,7d,30d,1y`, config);
                if (res.status === 429) { hitRateLimit = true; break; }
                if (!res.ok) throw new Error("API Error");
                const data = await res.json();
                allCoins = allCoins.concat(data);
                success = true;
                if(pages.length > 1) await new Promise(r => setTimeout(r, 2000));
            } catch(e) { if(attempts==2) console.log(e); else await new Promise(r => setTimeout(r, 2000)); }
        }
    }

    if (allCoins.length === 0 && existingData) return existingData; 
    
    const valid = allCoins.filter(c => c && c.symbol && !exclusionSet.has(c.symbol.toLowerCase()));
    
    const formatCoin = (coin) => ({
        id: coin.id, symbol: coin.symbol, name: coin.name, image: coin.image, 
        current_price: coin.current_price, market_cap: coin.market_cap, total_volume: coin.total_volume, 
        price_change_percentage_24h: coin.price_change_percentage_24h,
        price_change_percentage_7d: coin.price_change_percentage_7d_in_currency,
        price_change_percentage_30d: coin.price_change_percentage_30d_in_currency,
        price_change_percentage_1y: coin.price_change_percentage_1y_in_currency
    });
    
    return JSON.stringify({
        timestamp: Date.now(),
        gainers: [...valid].sort((a,b)=>b.price_change_percentage_24h-a.price_change_percentage_24h).slice(0,50).map(formatCoin),
        losers: [...valid].sort((a,b)=>a.price_change_percentage_24h-b.price_change_percentage_24h).slice(0,50).map(formatCoin)
    });
}