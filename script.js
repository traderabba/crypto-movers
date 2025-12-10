let globalMarketData = null;

async function init() {
    setupMenu();
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

    // UPDATED: Added onclick handler to open modal
    const createBubble = (c, colorClass) => {
        const coinData = JSON.stringify(c).replace(/"/g, '&quot;');
        return `
        <div class="bubble" onclick="openModal(${coinData})">
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
    const sourceListId = type === 'gainers' ? 'gainers-list' : 'losers-list';
    const count = document.getElementById(sourceListId).children.length;
    
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
        const titleText = type === 'gainers' ? `Top ${count} Gainers (24H)` : `Top ${count} Losers (24H)`;
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
        link.download = `CTDGL_${type}_Top${count}_${new Date().toISOString().split('T')[0]}.png`;
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

// === NEW: MODAL LOGIC ===
function openModal(coin) {
    const modal = document.getElementById('coin-modal');
    if(!modal) return;

    // 1. Populate Header
    document.getElementById('m-img').src = coin.image;
    document.getElementById('m-name').innerText = coin.name;
    document.getElementById('m-symbol').innerText = coin.symbol.toUpperCase();
    
    // Format Price
    const price = coin.current_price < 1 
        ? coin.current_price.toFixed(6) 
        : coin.current_price.toLocaleString('en-US', {style:'currency', currency:'USD'});
    document.getElementById('m-price').innerText = price;

    // 2. Populate Stats
    const formatMoney = (num) => num ? '$' + num.toLocaleString() : 'N/A';
    document.getElementById('m-cap').innerText = formatMoney(coin.market_cap);
    document.getElementById('m-vol').innerText = formatMoney(coin.total_volume);

    // 3. Populate History
    const setPercent = (id, val) => {
        const el = document.getElementById(id);
        if (val === null || val === undefined) {
            el.innerText = "-";
            el.className = "percent-tag gray";
            return;
        }
        el.innerText = val.toFixed(2) + "%";
        el.className = `percent-tag ${val >= 0 ? 'green' : 'red'}`;
    };

    setPercent('m-24h', coin.price_change_percentage_24h);
    setPercent('m-7d', coin.price_change_percentage_7d);
    setPercent('m-30d', coin.price_change_percentage_30d);
    setPercent('m-1y', coin.price_change_percentage_1y);

    // 4. Set Links
    document.getElementById('m-link-cg').href = `https://www.coingecko.com/en/coins/${coin.id}`;
    document.getElementById('m-link-tv').href = `https://www.tradingview.com/symbols/${coin.symbol.toUpperCase()}USD/?exchange=CRYPTO`;

    modal.classList.add('active');
}

function closeModal() {
    const modal = document.getElementById('coin-modal');
    if(modal) modal.classList.remove('active');
}

// Close on click outside
const modalEl = document.getElementById('coin-modal');
if(modalEl) {
    modalEl.addEventListener('click', (e) => {
        if (e.target === modalEl) {
            closeModal();
        }
    });
}

window.addEventListener('DOMContentLoaded', init);