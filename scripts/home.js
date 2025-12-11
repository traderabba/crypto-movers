// Logic for Index.html (CEX Data) - Fixed Modal Interaction

let globalMarketData = null;

// Auto-start when page loads
document.addEventListener('DOMContentLoaded', initHome);

async function initHome() {
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
        console.error("Init Error:", e);
        if (loader) {
            loader.innerHTML = `
                <div style="text-align:center; padding:20px;">
                    <h3 style="color:#ef4444">⚠️ Connection Failed</h3>
                    <p style="color:#64748b; margin:10px 0;">${e.message}</p>
                    <button onclick="location.reload()" style="padding:10px 20px; background:#3b82f6; color:white; border:none; border-radius:8px;">Retry</button>
                </div>`;
        }
    }
}

function handleSortChange(limit) {
    updateDisplay(parseInt(limit));
}

function updateDisplay(limit) {
    if (!globalMarketData) return;

    const maxAvailable = globalMarketData.gainers.length;
    const safeLimit = Math.min(limit, maxAvailable);
    
    const gainersToShow = globalMarketData.gainers.slice(0, safeLimit);
    const losersToShow = globalMarketData.losers.slice(0, safeLimit);

    // Helper to generate the bubble HTML with the Click Event
    const createBubble = (c, colorClass) => {
        // We must serialize the data safely to pass it into the onclick function
        const safeCoin = {
            name: c.name,
            symbol: c.symbol,
            image: c.image,
            current_price: c.current_price || c.price,
            market_cap: c.market_cap,
            total_volume: c.total_volume,
            price_change_percentage_24h: c.price_change_percentage_24h,
            price_change_percentage_7d: c.price_change_percentage_7d_in_currency, 
            price_change_percentage_30d: c.price_change_percentage_30d_in_currency,
            id: c.id
        };
        
        // Escape quotes so the HTML doesn't break
        const coinData = JSON.stringify(safeCoin).replace(/"/g, '&quot;');

        return `
        <div class="bubble" onclick="openHomeModal(${coinData})">
            <img src="${c.image}" crossorigin="anonymous" alt="${c.symbol}" onerror="this.src='/images/error.png'">
            <div class="symbol">${c.symbol}</div>
            <div class="percent ${colorClass}">${c.price_change_percentage_24h.toFixed(2)}%</div>
        </div>`;
    };

    document.getElementById('gainers-list').innerHTML = gainersToShow.map(c => createBubble(c, 'gainer-percent')).join('');
    document.getElementById('losers-list').innerHTML = losersToShow.map(c => createBubble(c, 'loser-percent')).join('');

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

// === CEX SPECIFIC MODAL ===
function openHomeModal(coin) {
    const modal = document.getElementById('coin-modal');
    if(!modal) return;

    // 1. Basic Info
    document.getElementById('m-img').src = coin.image || '/images/bullish.png';
    document.getElementById('m-name').innerText = coin.name;
    document.getElementById('m-symbol').innerText = coin.symbol.toUpperCase();
    
    let price = coin.current_price < 0.01 ? '$' + coin.current_price.toFixed(8) : '$' + coin.current_price.toLocaleString();
    document.getElementById('m-price').innerText = price;

    // 2. Stats (Market Cap & Volume)
    const formatMoney = (num) => num ? '$' + num.toLocaleString() : 'N/A';
    
    // Ensure labels are correct for CEX
    const statBoxes = document.querySelectorAll('.stat-box');
    if(statBoxes[0]) statBoxes[0].querySelector('.label').innerText = "Market Cap";
    if(statBoxes[1]) statBoxes[1].querySelector('.label').innerText = "24h Volume";

    document.getElementById('m-cap').innerText = formatMoney(coin.market_cap);
    document.getElementById('m-vol').innerText = formatMoney(coin.total_volume);

    // 3. History (24h, 7d, 30d)
    const historySection = document.querySelector('.modal-history');
    if(historySection) {
        historySection.innerHTML = `
            <h3>Price Performance</h3>
            <div class="history-row"><span>24h</span> <span id="m-24h" class="percent-tag"></span></div>
            <div class="history-row"><span>7d</span> <span id="m-7d" class="percent-tag"></span></div>
            <div class="history-row"><span>30d</span> <span id="m-30d" class="percent-tag"></span></div>`;
    }

    const setPercent = (id, val) => {
        const el = document.getElementById(id);
        if(el && val !== undefined && val !== null) {
            el.innerText = val.toFixed(2) + "%";
            el.className = `percent-tag ${val >= 0 ? 'green' : 'red'}`;
        } else if (el) {
            el.innerText = "-";
            el.className = "percent-tag gray";
        }
    };

    setPercent('m-24h', coin.price_change_percentage_24h);
    setPercent('m-7d', coin.price_change_percentage_7d);
    setPercent('m-30d', coin.price_change_percentage_30d);

    // 4. Action Buttons
    const cgBtn = document.getElementById('m-link-cg'); // Ensure this ID exists in your HTML or use class selector
    const actionContainer = document.querySelector('.modal-actions');
    
    // Rebuild buttons to ensure they are correct for CEX
    if(actionContainer) {
        actionContainer.innerHTML = `
            <a href="https://www.coingecko.com/en/coins/${coin.id}" target="_blank" class="action-btn cg-btn">
                <i class="fas fa-coins"></i> CoinGecko
            </a>
            <a href="https://www.tradingview.com/symbols/${coin.symbol.toUpperCase()}USD/?exchange=CRYPTO" target="_blank" class="action-btn tv-btn">
                <i class="fas fa-chart-line"></i> TradingView
            </a>
        `;
    }

    modal.classList.add('active');
}