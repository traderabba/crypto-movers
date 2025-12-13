// dex-movers.js

let globalMarketData = null;
let currentNetwork = 'solana'; 
let currentLimit = 20;

// === NEW: FREEZE GIF ANIMATION ===
// This function takes a GIF, draws the first frame to a canvas, 
// and replaces the image with a static PNG. No more flickering.
window.freezeGif = function(img) {
    if (img.dataset.frozen) return; // Already processed
    
    // Check if the original URL (inside the proxy param) is a GIF
    const originalUrl = decodeURIComponent(img.src).split('url=')[1] || img.src;
    if (!originalUrl.match(/\.gif($|\?)/i)) return; // Only affect GIFs

    try {
        // Create a canvas to capture the frame
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || 40; 
        c.height = img.naturalHeight || 40;
        
        // Draw the current (first) frame
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        
        // Replace the animated GIF with the static PNG
        img.src = c.toDataURL('image/png');
        img.dataset.frozen = "true"; // Mark as done
    } catch (e) {
        // Silently fail if CORS blocks it (but our Proxy handles CORS, so this works!)
        console.warn("Could not freeze GIF:", e);
    }
};

async function init() {
    if (typeof setupMenu === 'function') setupMenu();
    const select = document.getElementById('network-select');
    if (select) currentNetwork = select.value;
    await fetchData(currentNetwork);
}

async function changeNetwork(network) {
    currentNetwork = network;
    const loader = document.getElementById('loader');
    if (loader) {
        loader.style.display = 'flex';
        const p = loader.querySelector('p');
        if(p) p.innerText = `Scanning ${network.toUpperCase()}...`;
    }
    await fetchData(network);
}

async function fetchData(network) {
    const loader = document.getElementById('loader');
    try {
        // Add timestamp to prevent browser caching
        const response = await fetch(`/api/stats?network=${network}&t=${Date.now()}`);

        // Handle Errors (Backend or 403)
        if (!response.ok) {
            const errJson = await response.json().catch(() => ({}));
            throw new Error(errJson.message || "Server Error");
        }

        const data = await response.json();
        if (data.error) throw new Error(data.message);

        globalMarketData = data;
        updateDisplay(currentLimit);

        // Update Timestamp UI
        const timestampEl = document.getElementById('timestamp');
        if (timestampEl) {
            const date = new Date(data.timestamp);
            const isStale = (Date.now() - data.timestamp) > 5 * 60 * 1000;
            timestampEl.innerHTML = `
                <span style="color:${isStale ? '#f59e0b' : '#10b981'}">● ${isStale ? 'Cached' : 'Live'}</span> &nbsp;|&nbsp; 
                Network: <strong>${network.toUpperCase()}</strong> &nbsp;|&nbsp; 
                Updated: ${date.toLocaleTimeString()}
            `;
        }
        if (loader) loader.style.display = 'none';

    } catch (e) {
        console.error("Fetch Error:", e);
        if (loader) {
            loader.innerHTML = `
                <div style="text-align:center; padding:30px;">
                    <i class="fas fa-exclamation-triangle" style="font-size:40px; color:#ef4444; margin-bottom:15px;"></i>
                    <h3 style="margin-bottom:15px;">Data Source Issue</h3>
                    <p style="color:#64748b; margin-bottom:20px;">${e.message}</p>
                    <button onclick="location.reload()" class="btn" style="background:var(--dark); margin:0 auto;">Try Again</button>
                </div>`;
            loader.style.display = 'flex';
        }
    }
}

function handleSortChange(limit) {
    currentLimit = parseInt(limit);
    updateDisplay(currentLimit);
}

function updateDisplay(limit) {
    if (!globalMarketData) return;

    const rawGainers = globalMarketData.gainers || [];
    const rawLosers = globalMarketData.losers || [];

    const gainersToShow = rawGainers.slice(0, Math.min(limit, rawGainers.length));
    const losersToShow = rawLosers.slice(0, Math.min(limit, rawLosers.length));

    const gainerContainer = document.getElementById('gainers-list');
    const loserContainer = document.getElementById('losers-list');

    const formatPercent = (val) => {
        if (Math.abs(val) > 100) return (val / 100).toFixed(1) + 'x';
        return val.toFixed(2) + '%';
    };

    // --- OPTIMIZED BUBBLE CREATION ---
    const createBubble = (c, colorClass, index) => {
        const coinData = JSON.stringify(c).replace(/"/g, '&quot;');
        
        let imageUrl = c.image;
        if (imageUrl.startsWith('http')) {
            // Use our Proxy
            imageUrl = `/api/image-proxy?url=${encodeURIComponent(c.image)}`;
        }

        // Priority Loading for top items
        const loadingType = index < 12 ? "eager" : "lazy";

        return `
        <div class="bubble" onclick="openDexModal(${coinData})">
            <img 
                src="${imageUrl}" 
                width="40" 
                height="40" 
                loading="${loadingType}" 
                decoding="async" 
                crossorigin="anonymous" 
                alt="${c.symbol}" 
                onerror="this.src='/images/bullish.png'"
                onload="window.freezeGif(this)" 
                style="transform: translateZ(0); backface-visibility: hidden; object-fit: cover;"
            >
            <div class="symbol">${c.symbol.substring(0, 8)}</div>
            <div class="percent ${colorClass}">
                ${c.change_24h > 0 && c.change_24h <= 100 ? '+' : ''}${formatPercent(c.change_24h)}
            </div>
        </div>`;
    };

    if (gainerContainer) {
        gainerContainer.innerHTML = gainersToShow.length > 0 
            ? gainersToShow.map((c, i) => createBubble(c, 'gainer-percent', i)).join('')
            : `<div style="width:100%; text-align:center; padding:30px; color:#94a3b8;">No Gainers Found</div>`;
    }

    if (loserContainer) {
        loserContainer.innerHTML = losersToShow.length > 0 
            ? losersToShow.map((c, i) => createBubble(c, 'loser-percent', i)).join('')
            : `<div style="width:100%; text-align:center; padding:30px; color:#94a3b8;">No Losers Found</div>`;
    }
}

// === MODAL LOGIC ===
function openDexModal(coin) {
    const modal = document.getElementById('coin-modal');
    if(!modal) return;

    const setContent = (id, text) => { 
        const el = document.getElementById(id); 
        if(el) el.innerText = text; 
    };
    
    const imgEl = document.getElementById('m-img');
    let imageUrl = coin.image || '/images/bullish.png';
    if (imageUrl.startsWith('http')) {
        imageUrl = `/api/image-proxy?url=${encodeURIComponent(coin.image)}`;
    }
    imgEl.src = imageUrl;
    
    // Freeze modal GIF too
    imgEl.dataset.frozen = ""; // Reset frozen state
    imgEl.onload = function() { window.freezeGif(this); };

    setContent('m-name', coin.name || coin.symbol);
    setContent('m-symbol', coin.symbol.toUpperCase());

    let price = coin.price < 0.01 ? '$' + coin.price.toFixed(8) : '$' + coin.price.toLocaleString();
    setContent('m-price', price);

    const formatMoney = (num) => {
        if (!num) return 'N/A';
        if (num > 1000000) return '$' + (num / 1000000).toFixed(2) + 'M';
        if (num > 1000) return '$' + (num / 1000).toFixed(2) + 'K';
        return '$' + num.toLocaleString();
    };

    setContent('m-cap', formatMoney(coin.fdv));
    setContent('m-vol', formatMoney(coin.volume_24h));

    const setPercent = (id, val) => {
        const el = document.getElementById(id);
        if(!el) return;
        if (val === undefined || val === null) {
            el.innerText = "-";
            el.className = 'percent-tag gray';
            return;
        }
        el.innerText = (val > 0 ? '+' : '') + val.toFixed(2) + "%";
        el.className = 'percent-tag ' + (val >= 0 ? 'green' : 'red');
    };

    setPercent('m-30m', coin.change_30m);
    setPercent('m-1h', coin.change_1h);
    setPercent('m-6h', coin.change_6h);
    setPercent('m-24h', coin.change_24h);

    const btn = document.getElementById('m-link-pool');
    if (btn) {
        const netSlug = currentNetwork === 'ethereum' ? 'eth' : 
                        currentNetwork === 'bnb' ? 'bsc' : 
                        currentNetwork;
        btn.href = `https://www.geckoterminal.com/${netSlug}/pools/${coin.address}`;
    }

    modal.classList.add('active');
}

function closeModal() {
    const modal = document.getElementById('coin-modal');
    if (modal) modal.classList.remove('active');
}

window.onclick = function(event) {
    const modal = document.getElementById('coin-modal');
    if (event.target === modal) closeModal();
}

// === SNAPSHOT LOGIC (ALREADY USING PROXY) ===
async function captureSection(type) {
    if (typeof html2canvas === 'undefined') {
        alert("Error: html2canvas library missing. Please reload.");
        return;
    }

    const btn = document.getElementById(type === 'gainers' ? 'btn-gain' : 'btn-lose');
    const originalText = btn.innerHTML;
    const sourceListId = type === 'gainers' ? 'gainers-list' : 'losers-list';
    
    const listEl = document.getElementById(sourceListId);
    if (!listEl || listEl.querySelectorAll('.bubble').length === 0) {
        alert("No data to snapshot!");
        return;
    }

    const count = listEl.querySelectorAll('.bubble').length;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    btn.disabled = true;

    try {
        const reportCard = document.createElement('div');
        Object.assign(reportCard.style, {
            position: 'fixed', left: '0', top: '0', zIndex: '-9999',
            width: '1200px', padding: '60px', borderRadius: '30px',
            fontFamily: "'Inter', sans-serif", display: 'flex', flexDirection: 'column', alignItems: 'center',
            background: type === 'gainers' ? '#f0fdf4' : '#fef2f2'
        });

        const titleIcon = type === 'gainers' ? '🔥' : '💀';
        const netName = currentNetwork.charAt(0).toUpperCase() + currentNetwork.slice(1);
        
        reportCard.innerHTML = `
            <div style="text-align: center; margin-bottom: 50px;">
                <h1 style="font-size: 56px; color: #0f172a; margin: 0; font-weight: 800; letter-spacing: -2px;">
                    ${titleIcon} ${netName} Top ${count} ${type === 'gainers' ? 'Gainers' : 'Losers'}
                </h1>
                <div style="width: 120px; height: 8px; background: ${type === 'gainers' ? '#15803d' : '#b91c1c'}; margin: 25px auto 0; border-radius: 10px;"></div>
            </div>
        `;

        const gridContainer = document.createElement('div');
        Object.assign(gridContainer.style, {
            display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '35px', width: '100%', marginBottom: '40px'
        });

        const bubbles = listEl.querySelectorAll('.bubble');
        
        for (const b of bubbles) {
            const clone = b.cloneNode(true);
            clone.removeAttribute('onclick'); 

            Object.assign(clone.style, { 
                width: '100%', height: '180px', margin: '0', 
                boxShadow: '0 15px 30px rgba(0,0,0,0.08)',
                background: '#ffffff', borderWidth: '4px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'
            });

            if (type === 'gainers') {
                clone.style.backgroundColor = '#ecfdf5';
                clone.style.borderColor = '#6ee7b7';
            } else {
                clone.style.backgroundColor = '#fef2f2';
                clone.style.borderColor = '#fca5a5';
            }

            const img = clone.querySelector('img');
            if(img && img.src) {
                const originalUrl = img.src;
                // Ensure proxy is used
                if(originalUrl.startsWith('http') && !originalUrl.includes('image-proxy')) {
                     img.src = `/api/image-proxy?url=${encodeURIComponent(originalUrl)}`;
                }
                img.crossOrigin = "anonymous"; 
                img.style.width = '72px'; 
                img.style.height = '72px'; 
                img.style.marginBottom = '15px';
                
                // Ensure snapshot uses the FROZEN image if available
                // (Note: cloneNode copies the current src, which might already be the dataURL png from the freeze)
            }
            
            const symbol = clone.querySelector('.symbol');
            if(symbol) symbol.style.fontSize = '24px';
            const percent = clone.querySelector('.percent');
            if(percent) percent.style.fontSize = '24px';
            
            gridContainer.appendChild(clone);
        }

        reportCard.appendChild(gridContainer);
        reportCard.insertAdjacentHTML('beforeend', `
            <div style="font-size: 20px; color: #64748b; font-weight: 600; margin-top: 40px; display:flex; align-items:center; gap:12px; opacity:0.8;">
                <img src="/images/bullish.png" style="width:32px;">
                Generated by Crypto Movers | Data: GeckoTerminal
            </div>
        `);

        document.body.appendChild(reportCard);
        
        await new Promise(r => setTimeout(r, 1500)); 

        const canvas = await html2canvas(reportCard, { 
            scale: 2, 
            useCORS: true, 
            allowTaint: true,
            backgroundColor: null 
        });

        const link = document.createElement('a');
        link.download = `${currentNetwork}_${type}_Top${count}_${new Date().toISOString().split('T')[0]}.png`;
        link.href = canvas.toDataURL("image/png");
        link.click();
        
        document.body.removeChild(reportCard);

    } catch (err) {
        console.error("Snapshot failed:", err);
        alert(`Snapshot Error: ${err.message}`);
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

window.addEventListener('DOMContentLoaded', init);