// _worker.js

// === CONFIGURATION ===
const CACHE_KEY = "market_data_v7"; 
const CACHE_LOCK_KEY = "market_data_lock";
const UPDATE_INTERVAL_MS = 15 * 60 * 1000; 
const SOFT_REFRESH_MS = 12 * 60 * 1000;    
const MIN_RETRY_DELAY_MS = 2 * 60 * 1000;  

// DEX Config
const DEX_CACHE_KEY = "dex_stats_v3"; 
const DEX_LOCK_KEY = "dex_stats_lock";
const DEX_SOFT_REFRESH_MS = 5 * 60 * 1000; 

const TIMEOUT_MS = 45000; 
const LOCK_TIMEOUT_MS = 120000; 

// === FILTER SETTINGS (Spam Filter) ===
const STABLECOINS = new Set([
    "USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "PYUSD", "FRAX", "LUSD", "USDD", "WETH", "WBNB", "WSOL", "CBETH", "STETH"
]);
const MIN_LIQUIDITY = 5000; // Ignore pools under $5k
const MIN_VOLUME = 1000;    // Ignore dead pools

const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate"
};

const API_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*"
};

// === MAIN ROUTER ===
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname === "/sitemap.xml") return handleSitemap(request, env);
        if (url.pathname === "/api/stats") return handleGenericStats(env, ctx, CACHE_KEY, CACHE_LOCK_KEY, SOFT_REFRESH_MS, updateMarketDataSafe);
        if (url.pathname === "/api/dex-stats") return handleGenericStats(env, ctx, DEX_CACHE_KEY, DEX_LOCK_KEY, DEX_SOFT_REFRESH_MS, updateDexData);
        return env.ASSETS.fetch(request);
    }
};

// === GENERIC HANDLER ===
async function handleGenericStats(env, ctx, key, lockKey, softRefresh, updateFunc) {
    if (!env.KV_STORE) return new Response(JSON.stringify({ error: true }), { status: 500, headers: HEADERS });

    try {
        const [cachedRaw, lock] = await Promise.all([ env.KV_STORE.get(key), env.KV_STORE.get(lockKey) ]);
        let cachedData = null;
        if (cachedRaw) try { cachedData = JSON.parse(cachedRaw); } catch(e) {}

        const now = Date.now();
        const dataAge = cachedData ? (now - (cachedData.timestamp || 0)) : 999999999;
        const isUpdating = lock && (now - parseInt(lock)) < LOCK_TIMEOUT_MS;

        if (cachedData && dataAge < softRefresh) return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-Fresh" } });
        if (isUpdating && cachedData) return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-UpdateInProgress" } });
        
        if (cachedData && dataAge >= softRefresh) {
            await env.KV_STORE.put(lockKey, now.toString(), { expirationTtl: 120 });
            ctx.waitUntil(updateFunc(env).finally(() => env.KV_STORE.delete(lockKey).catch(()=>{})));
            return new Response(cachedRaw, { headers: { ...HEADERS, "X-Source": "Cache-Proactive" } });
        }
        
        await env.KV_STORE.put(lockKey, now.toString(), { expirationTtl: 120 });
        const fresh = await updateFunc(env);
        await env.KV_STORE.delete(lockKey).catch(()=>{});
        return new Response(fresh, { headers: { ...HEADERS, "X-Source": "Live-Fetch" } });

    } catch (e) { return new Response(JSON.stringify({ error: true, msg: e.message }), { status: 500, headers: HEADERS }); }
}

// === CEX ENGINE (Original Logic) ===
async function updateMarketDataSafe(env) {
    try { return await updateMarketData(env); } catch (e) { console.error(e); throw e; }
}

async function updateMarketData(env) {
    const updateAttemptTime = Date.now();
    const pages = [1]; // CEX Page 1 Only
    const perPage = 250; 
    let allCoins = [];
    const config = { headers: API_HEADERS };

    for (const page of pages) {
        try {
            const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&price_change_percentage=24h,7d,30d,1y`, config);
            if (!res.ok) throw new Error("API Error");
            const data = await res.json();
            allCoins = allCoins.concat(data);
        } catch (e) { console.error(e); }
    }

    if (allCoins.length === 0) throw new Error("CEX Fetch failed");

    const valid = allCoins.filter(c => c && c.price_change_percentage_24h != null && c.symbol && c.current_price != null);
    
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

    const jsonString = JSON.stringify({ timestamp: Date.now(), gainers, losers });
    await env.KV_STORE.put(CACHE_KEY, jsonString, { expirationTtl: 172800 });
    return jsonString;
}

// === DEX ENGINE (Filtered) ===
async function updateDexData(env) {
    const NETWORKS = ['solana', 'eth', 'bsc', 'base'];
    const results = { timestamp: Date.now(), all: [], solana: [], eth: [], bsc: [], base: [] };
    let allPools = [];

    const promises = NETWORKS.map(async (net) => {
        try {
            const fetchPage = async (p) => {
                const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools?page=${p}&include=base_token&sort=h24_volume_usd_desc`, { headers: API_HEADERS });
                if(!res.ok) return [];
                const json = await res.json();
                return { data: json.data || [], included: json.included || [] };
            };

            const [p1, p2] = await Promise.all([fetchPage(1), fetchPage(2)]);
            const rawItems = [...p1.data, ...p2.data];
            const included = [...p1.included, ...p2.included];

            const processed = rawItems.map(item => {
                const attr = item.attributes;
                const tokenId = item.relationships?.base_token?.data?.id;
                const tokenObj = included.find(inc => inc.id === tokenId && inc.type === 'token');
                const symbol = (tokenObj?.attributes?.symbol || attr.name.split('/')[0]).toUpperCase();
                
                return {
                    id: item.id, 
                    address: attr.address,
                    name: attr.name.split('/')[0],
                    symbol: symbol,
                    image: tokenObj?.attributes?.image_url || null,
                    price: parseFloat(attr.base_token_price_usd || 0),
                    price_change_24h: parseFloat(attr.price_change_percentage?.h24 || 0),
                    volume_24h: parseFloat(attr.volume_usd?.h24 || 0),
                    liquidity: parseFloat(attr.reserve_in_usd || 0),
                    network: net,
                    is_stable: STABLECOINS.has(symbol)
                };
            }).filter(p => {
                if (p.is_stable) return false; 
                if (p.liquidity < MIN_LIQUIDITY) return false; 
                if (p.volume_24h < MIN_VOLUME) return false;
                if (Math.abs(p.price_change_24h) < 0.1) return false; 
                return true;
            });

            // Network Deduplication
            const uniqueMap = new Map();
            processed.forEach(p => {
                const existing = uniqueMap.get(p.symbol);
                if (!existing || p.liquidity > existing.liquidity) uniqueMap.set(p.symbol, p);
            });
            const uniquePools = Array.from(uniqueMap.values());

            results[net] = { 
                gainers: [...uniquePools].sort((a,b) => b.price_change_24h - a.price_change_24h).slice(0, 20),
                losers: [...uniquePools].sort((a,b) => a.price_change_24h - b.price_change_24h).slice(0, 20)
            };
            return uniquePools;
        } catch (e) { return []; }
    });

    const networkData = await Promise.all(promises);
    networkData.forEach(p => allPools.push(...p));

    // Global Deduplication
    const globalUniqueMap = new Map();
    allPools.forEach(p => {
        const existing = globalUniqueMap.get(p.symbol);
        if (!existing || p.volume_24h > existing.volume_24h) globalUniqueMap.set(p.symbol, p);
    });
    const finalGlobal = Array.from(globalUniqueMap.values());

    results.all = {
        gainers: [...finalGlobal].sort((a,b) => b.price_change_24h - a.price_change_24h).slice(0, 50),
        losers: [...finalGlobal].sort((a,b) => a.price_change_24h - b.price_change_24h).slice(0, 50)
    };

    const jsonString = JSON.stringify(results);
    await env.KV_STORE.put(DEX_CACHE_KEY, jsonString, { expirationTtl: 172800 });
    return jsonString;
}

// === SITEMAP HELPER ===
async function handleSitemap(request, env) {
    try {
        const manifestRes = await env.ASSETS.fetch(new URL("/urls.json", request.url));
        if (!manifestRes.ok) return new Response("Error", { status: 500 });
        const pages = await manifestRes.json();
        let sitemap = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;
        pages.forEach(p => sitemap += `<url><loc>https://cryptomovers.pages.dev${p.path}</loc><lastmod>${new Date().toISOString()}</lastmod></url>`);
        sitemap += `</urlset>`;
        return new Response(sitemap, { headers: { "Content-Type": "application/xml" } });
    } catch (e) { return new Response("Error", { status: 500 }); }
}