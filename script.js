let globalMarketData = null;
let globalDexData = null;
let currentNetwork = 'all';

async function init() {
    setupMenu();
    
    // DETECT PAGE: Check URL to decide which engine to load
    const isDexPage = window.location.pathname.includes('dex-movers');
    
    if (isDexPage) {
        await initDex();
    } else {
        await initCex();
    }
}

// ==========================================
// 1. CEX ENGINE (Home Page)
// ==========================================

async function initCex() {
    if (!document.getElementById('gainers-list')) return;
    const loader = document.getElementById('loader');

    try {
        const response = await fetch('/api/stats?t=' + Date.now());
        
        if (!response.ok) {
            let errorText = `Server Error (${response.status})`;
            try {
                const errJson = await response.json();
                if (errJson.message) errorText = errJson.message;
            } catch (e) {}
            throw new Error(errorText);
        }

        const text = await response.text();
        if (text.trim().startsWith('<')) throw new Error("Server Timeout. Please Reload.");
        
        const data = JSON.parse(text);
        if (data.error) throw new Error(data.message);

        globalMarketData = data;
        updateDisplay(20);

    } catch (e) {
        console.error("CEX Init Error:", e);
        if (loader) {
            loader.innerHTML = `
                <div style="text-align:center; padding:20px;">
                    <h3 style="color:#ef4444">⚠️ Connection Failed</h3>
                    <p style="color:#64748b; margin:10px 0;">${e.message}</p>
                    <button onclick="location.reload()" class="btn" style="background:var(--dark)">Retry</button>
                </div>`;
        }
    }
}

function updateDisplay(limit) {
    if (!globalMarketData) return;

    const maxAvailable = globalMarketData.gainers.length;
    const safeLimit = Math.min(limit, maxAvailable);
    
    const gainersToShow = globalMarketData.gainers.slice(0, safeLimit);
    const losersToShow = globalMarketData.losers.slice(0, safeLimit);

    const createBubble = (c, colorClass) => {
        // Prepare CEX object for modal
        const safeCoin = {
            ...c,
            isDex: false 
        };
        const coinData = JSON.stringify(safeCoin).replace(/"/g, '&quot;');
        
        return `
        <div class="bubble" onclick="openModal(${coinData})">
            <img src="${c.image}" crossorigin="anonymous" alt="${c.symbol}" onerror="this.src='/images/error.png'">
            <div class="symbol">${c.symbol}</div>
            <div class="percent ${colorClass}">${c.price_change_percentage_24h.toFixed(2)}%</div>
        </div>`;
    };

    document.getElementById('gainers-list').innerHTML = gainersToShow.map(c => createBubble(c, 'gainer-percent')).join('');
    document.getElementById('losers-list').innerHTML = losersToShow.map(c => createBubble(c, 'loser-percent')).join('');

    // Timestamp & Status
    if (globalMarketData.timestamp) {
        const date = new Date(globalMarketData.timestamp);
        const timeEl = document.getElementById('timestamp');
        if (timeEl) timeEl.innerText = "Last Updated: " + date.toLocaleTimeString();
    }
    
    const statusMsg = document.getElementById('status-msg');
    if(statusMsg) {
        if (safeLimit < limit) statusMsg.innerText = `⚠️ Only found ${safeLimit} coins (Deep scan running...)`;
        else statusMsg.innerText = `🟢 Showing Top ${limit}`;
    }
    
    const loader = document.getElementById('loader');
    if (loader) loader.style.display = 'none';
}

// ==========================================
// 2. DEX ENGINE (DEX Movers Page)
// ==========================================

async function initDex() {
    const loader = document.getElementById('loader');
    if(loader) loader.style.display = 'flex';

    try {
        const response = await fetch('/api/dex-stats?t=' + Date.now());
        if (!response.ok) throw new Error("DEX API Error");
        const data = await response.json();
        
        globalDexData = data;
        
        // Render Default (All Networks)
        updateDexDisplay('all', 20);
        
        if (data.timestamp) {
            const timeEl = document.getElementById('timestamp');
            if (timeEl) timeEl.innerText = "Last Updated: " + new Date(data.timestamp).toLocaleTimeString();
        }

        if(loader) loader.style.display = 'none';

    } catch (e) {
        console.error("DEX Init Error:", e);
        if(loader) loader.innerHTML = `<div style="text-align:center"><h3 style="color:#ef4444">Connection Failed</h3><button onclick="location.reload()" class="btn">Retry</button></div>`;
    }
}

function handleNetworkChange(network) {
    currentNetwork = network;
    const limit = document.getElementById('sort-select').value;
    updateDexDisplay(network, parseInt(limit));
}

function updateDexDisplay(network, limit) {
    if (!globalDexData || !globalDexData[network]) return;

    const data = globalDexData[network];
    const gainersList = document.getElementById('gainers-list');
    const losersList = document.getElementById('losers-list');

    // Update Section Labels
    const netLabel = network === 'all' ? '(Global)' : `(${network.toUpperCase()})`;
    const gLabel = document.getElementById('gainers-network-label');
    const lLabel = document.getElementById('losers-network-label');
    if(gLabel) gLabel.innerText = netLabel;
    if(lLabel) lLabel.innerText = netLabel;

    const createDexBubble = (c, colorClass) => {
        // Prepare DEX object for modal (map fields to match openModal expectations)
        const safeCoin = {
            name: c.name,
            symbol: c.symbol,
            image: c.image || '/images/bullish.png',
            current_price: parseFloat(c.price),
            market_cap: c.liquidity, // Use Liquidity for Cap slot
            total_volume: c.volume_24h,
            price_change_percentage_24h: c.price_change_24h,
            id: c.id, 
            network: c.network,
            address: c.address,
            isDex: true
        };
        const coinData = JSON.stringify(safeCoin).replace(/"/g, '&quot;');
        
        return `
        <div class="bubble" onclick="openModal(${coinData})">
            <img src="${c.image}" crossorigin="anonymous" alt="${c.symbol}" onerror="this.src='/images/bullish.png'">
            <div class="symbol">${c.symbol}</div>
            <div class="percent ${colorClass}">${c.price_change_24h.toFixed(2)}%</div>
            <div style="font-size:9px; color:#64748b; margin-top:2px;">${c.network.toUpperCase()}</div>
        </div>`;
    };

    gainersList.innerHTML = data.gainers.slice(0, limit).map(c => createDexBubble(c, 'gainer-percent')).join('');
    losersList.innerHTML = data.losers.slice(0, limit).map(c => createDexBubble(c, 'loser-percent')).join('');
}

// ==========================================
// 3. SHARED HELPERS (Sort, Snap, Modal)
// ==========================================

function handleSortChange(limit) {
    // Route to correct display function
    if (window.location.pathname.includes('dex-movers')) {
        updateDexDisplay(currentNetwork, parseInt(limit));
    } else {
        updateDisplay(parseInt(limit));
    }
}

function setupMenu() {
    const hamburger = document.getElementById('mobile-menu');
    const navMenu = document.querySelector('.nav-menu');
    const navLinks = document.querySelectorAll('.nav-link');

    if(hamburger && navMenu) {
        const newHamburger = hamburger.cloneNode(true);
        hamburger.parentNode.replaceChild(newHamburger, hamburger);
        
        newHamburger.addEventListener('click', (e) => {
            e.stopPropagation();
            newHamburger.classList.toggle('active');
            navMenu.classList.toggle('active');
        });

        document.addEventListener('click', (e) => {
            if(navMenu.classList.contains('active') && !navMenu.contains(e.target) && !newHamburger.contains(e.target)) {
                newHamburger.classList.remove('active');
                navMenu.classList.remove('active');
            }
        });

        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                newHamburger.classList.remove('active');
                navMenu.classList.remove('active');
            });
        });
    }
}

async function captureSection(type) {
    const btn = document.getElementById(type === 'gainers' ? 'btn-gain' : 'btn-lose');
    const originalText = btn.innerHTML;
    
    // Dynamic Title Generation
    const isDex = window.location.pathname.includes('dex-movers');
    const netText = isDex ? (currentNetwork === 'all' ? 'Global DEX' : currentNetwork.toUpperCase()) : 'Crypto';
    
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating HD...';
    btn.disabled = true;

    try {
        const reportCard = document.createElement('div');
        Object.assign(reportCard.style, {
            position: 'absolute', left: '-9999px', top: '0',
            width: '1200px', padding: '60px', borderRadius: '30px',
            fontFamily: "'Inter', sans-serif", display: 'flex', flexDirection: 'column', alignItems: 'center',
            background: type === 'gainers' ? '#f0fdf4' : '#fef2f2'
        });

        const titleIcon = type === 'gainers' ? '🔥' : '💀';
        const titleText = `${netText} Top ${type === 'gainers' ? 'Gainers' : 'Losers'} (24H)`;
        const titleColor = type === 'gainers' ? '#15803d' : '#b91c1c';

        reportCard.innerHTML = `
            <div style="text-align: center; margin-bottom: 50px;">
                <h1 style="font-size: 48px; color: #0f172a; margin: 0; font-weight: 800; letter-spacing: -1px;">
                    ${titleIcon} ${titleText}
                </h1>
                <div style="width: 100px; height: 6px; background: ${titleColor}; margin: 20px auto 0; border-radius: 10px;"></div>
            </div>
        `;

        const gridContainer = document.createElement('div');
        Object.assign(gridContainer.style, {
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '35px', width: '100%', marginBottom: '40px'
        });

        const sourceListId = type === 'gainers' ? 'gainers-list' : 'losers-list';
        const originalContainer = document.getElementById(sourceListId);
        const bubbles = originalContainer.querySelectorAll('.bubble');

        bubbles.forEach(b => {
            const clone = b.cloneNode(true);
            if (type === 'gainers') clone.classList.add('force-gainer');
            else clone.classList.add('force-loser');
            Object.assign(clone.style, { width: '100%', height: '180px', margin: '0', boxShadow: '0 15px 30px rgba(0,0,0,0.08)' });
            
            const img = clone.querySelector('img');
            Object.assign(img.style, { width: '64px', height: '64px', marginBottom: '12px' });
            
            const symbol = clone.querySelector('.symbol');
            symbol.style.fontSize = '22px';
            
            const percent = clone.querySelector('.percent');
            percent.style.fontSize = '20px';
            
            // Remove the tiny network label for snapshot clarity
            const netLabel = clone.querySelector('div[style*="font-size:9px"]');
            if(netLabel) netLabel.remove();

            gridContainer.appendChild(clone);
        });

        reportCard.appendChild(gridContainer);
        reportCard.insertAdjacentHTML('beforeend', `
            <div style="font-size: 18px; color: #64748b; font-weight: 600; margin-top: 30px; display:flex; align-items:center; gap:10px;">
                <img src="/images/bullish.png" style="width:30px;">
         Generated on https://cryptomovers.pages.dev | by @TraderAbba
            </div>
        `);

        document.body.appendChild(reportCard);
        const canvas = await html2canvas(reportCard, { scale: 3, useCORS: true, backgroundColor: null });
        const link = document.createElement('a');
        link.download = `Movers_${netText}_${type}_${new Date().toISOString().split('T')[0]}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        document.body.removeChild(reportCard);
    } catch (err) {
        console.error("Snapshot failed:", err);
        alert("Failed to create report.");
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// === SMART MODAL (Handles both CEX and DEX data) ===
function openModal(coin) {
    const modal = document.getElementById('coin-modal');
    if(!modal) return;

    // 1. Header
    document.getElementById('m-img').src = coin.image;
    document.getElementById('m-name').innerText = coin.name;
    document.getElementById('m-symbol').innerText = coin.symbol.toUpperCase();
    
    // Price Formatting
    let price = "$0.00";
    if (coin.current_price < 0.01) price = '$' + coin.current_price.toFixed(8);
    else price = '$' + coin.current_price.toLocaleString('en-US');
    document.getElementById('m-price').innerText = price;

    // 2. Stats (Cap/Liq & Volume)
    const formatMoney = (num) => num ? '$' + num.toLocaleString() : 'N/A';
    document.getElementById('m-cap').innerText = formatMoney(coin.market_cap);
    document.getElementById('m-vol').innerText = formatMoney(coin.total_volume);

    // 3. Labels & History
    const labelBox = document.querySelector('.stat-box .label');
    const historySection = document.querySelector('.modal-history');
    
    if (coin.isDex) {
        // DEX MODE
        labelBox.innerText = "Pool Liquidity";
        // Show Network instead of 7d/30d
        historySection.innerHTML = `
            <h3>Pool Performance</h3>
            <div class="history-row"><span>24h Change</span> <span class="percent-tag ${coin.price_change_percentage_24h >= 0 ? 'green':'red'}">${coin.price_change_percentage_24h.toFixed(2)}%</span></div>
            <div class="history-row"><span>Network</span> <span class="percent-tag gray">${coin.network.toUpperCase()}</span></div>
        `;
    } else {
        // CEX MODE
        labelBox.innerText = "Market Cap";
        historySection.innerHTML = `
            <h3>Price Performance</h3>
            <div class="history-row"><span>24h</span> <span id="m-24h" class="percent-tag"></span></div>
            <div class="history-row"><span>7d</span> <span id="m-7d" class="percent-tag"></span></div>
            <div class="history-row"><span>30d</span> <span id="m-30d" class="percent-tag"></span></div>
            <div class="history-row"><span>1y</span> <span id="m-1y" class="percent-tag"></span></div>
        `;
        
        // Populate CEX percentages
        const setPercent = (id, val) => {
            const el = document.getElementById(id);
            if(!el) return;
            if (val === undefined || val === null) { el.innerText = "-"; el.className = "percent-tag gray"; return; }
            el.innerText = val.toFixed(2) + "%";
            el.className = `percent-tag ${val >= 0 ? 'green' : 'red'}`;
        };
        setPercent('m-24h', coin.price_change_percentage_24h);
        setPercent('m-7d', coin.price_change_percentage_7d);
        setPercent('m-30d', coin.price_change_percentage_30d);
        setPercent('m-1y', coin.price_change_percentage_1y);
    }

    // 4. Links
    const cgBtn = document.getElementById('m-link-cg');
    const tvBtn = document.getElementById('m-link-tv'); // TradingView button (might be hidden for DEX)

    if (coin.isDex) {
        cgBtn.href = `https://www.geckoterminal.com/${coin.network}/pools/${coin.address}`;
        cgBtn.innerHTML = '<i class="fas fa-circle-nodes"></i> GeckoTerminal';
        if(tvBtn) tvBtn.style.display = 'none'; // Hide TV for DEX as address might not match
    } else {
        cgBtn.href = `https://www.coingecko.com/en/coins/${coin.id}`;
        cgBtn.innerHTML = '<i class="fas fa-coins"></i> CoinGecko';
        if(tvBtn) {
            tvBtn.style.display = 'flex';
            tvBtn.href = `https://www.tradingview.com/symbols/${coin.symbol.toUpperCase()}USD/?exchange=CRYPTO`;
        }
    }

    modal.classList.add('active');
}

function closeModal() {
    const modal = document.getElementById('coin-modal');
    if(modal) modal.classList.remove('active');
}

const modalEl = document.getElementById('coin-modal');
if(modalEl) {
    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) closeModal();
    });
}

window.addEventListener('DOMContentLoaded', init);

