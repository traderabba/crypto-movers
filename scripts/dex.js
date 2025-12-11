// dex.js - DEX Movers Logic

let globalDexData = null;
let currentNetwork = 'all';

document.addEventListener('DOMContentLoaded', initDex);

async function initDex() {
    if (!document.getElementById('gainers-list')) return;
    
    // Check URL params for network (optional deep linking)
    const urlParams = new URLSearchParams(window.location.search);
    const netParam = urlParams.get('network');
    if(netParam) {
        currentNetwork = netParam;
        const select = document.getElementById('network-select');
        if(select) select.value = netParam;
    }

    await fetchDexData();
}

async function handleNetworkChange(network) {
    currentNetwork = network;
    await fetchDexData();
}

async function fetchDexData() {
    const loader = document.getElementById('loader');
    if(loader) loader.style.display = 'flex';
    
    const statusMsg = document.getElementById('status-msg');
    if(statusMsg) statusMsg.innerText = `Scanning ${currentNetwork.toUpperCase()} Chain...`;

    try {
        // Fetch from Worker with Network Param
        const response = await fetch(`/api/dex-stats?network=${currentNetwork}&t=` + Date.now());
        
        // === UPDATED ERROR HANDLING START ===
        if (!response.ok) {
            let errorMsg = `Server Error (${response.status})`;
            try {
                // Try to parse the specific JSON error from the worker
                const errJson = await response.json();
                if (errJson.message) errorMsg = errJson.message;
                else if (errJson.error) errorMsg = errJson.error;
            } catch (jsonErr) {
                // If JSON fails, read text (useful for 404/500 html errors)
                const text = await response.text();
                if (text) errorMsg = `Server Error: ${text.substring(0, 50)}...`;
            }
            throw new Error(errorMsg);
        }
        // === UPDATED ERROR HANDLING END ===

        const data = await response.json();
        
        // Handle logical errors inside a 200 OK response
        if (data.error) throw new Error(data.message || "Unknown API Error");

        globalDexData = data;
        updateDexDisplay();

    } catch (e) {
        console.error("DEX Init Error:", e);
        if (loader) {
             loader.innerHTML = `
                <div style="text-align:center; padding:20px;">
                    <h3 style="color:#ef4444">⚠️ Connection Failed</h3>
                    <p style="color:#e2e8f0; margin:10px auto; font-family:monospace; background:#1e293b; padding:10px; border-radius:5px; max-width: 90%; word-break: break-word;">${e.message}</p>
                    <button onclick="location.reload()" style="padding:10px 20px; background:#3b82f6; color:white; border:none; border-radius:8px; cursor:pointer;">Retry</button>
                    <div style="margin-top:10px; font-size:12px; color:#94a3b8;">Check Console (F12) for details</div>
                </div>`;
        }
    }
}

function updateDexDisplay() {
    if (!globalDexData) return;

    const createCard = (token, colorClass) => {
        // Prepare safe data for modal
        const safeToken = JSON.stringify(token).replace(/"/g, '&quot;');
        
        // Truncate name if too long
        const displayName = token.symbol.length > 8 ? token.symbol.substring(0,8) + '..' : token.symbol;

        return `
        <div class="bubble" onclick="openDexModal(${safeToken})">
            <img src="${token.image}" crossorigin="anonymous" onerror="this.src='/images/bullish.png'">
            <div class="symbol">${displayName}</div>
            <div class="percent ${colorClass}">${token.change_24h > 0 ? '+' : ''}${token.change_24h.toFixed(2)}%</div>
            <div style="font-size:10px; opacity:0.6; margin-top:4px;">${token.platform}</div>
        </div>`;
    };

    const gainersList = document.getElementById('gainers-list');
    const losersList = document.getElementById('losers-list');

    if (gainersList) gainersList.innerHTML = globalDexData.gainers.map(t => createCard(t, 'gainer-percent')).join('');
    if (losersList) losersList.innerHTML = globalDexData.losers.map(t => createCard(t, 'loser-percent')).join('');

    // Update Timestamp
    if (globalDexData.timestamp) {
        const date = new Date(globalDexData.timestamp);
        const timeEl = document.getElementById('timestamp');
        if(timeEl) timeEl.innerText = "Last Updated: " + date.toLocaleTimeString();
    }
    
    // Update Status
    const statusMsg = document.getElementById('status-msg');
    if(statusMsg) statusMsg.innerText = `🟢 Showing Top Movers (${currentNetwork.toUpperCase()})`;

    const loader = document.getElementById('loader');
    if (loader) loader.style.display = 'none';
}

// === DEX MODAL FUNCTIONS ===
function openDexModal(token) {
    const modal = document.getElementById('coin-modal');
    if (!modal) return;

    document.getElementById('m-img').src = token.image;
    document.getElementById('m-name').innerText = token.name;
    document.getElementById('m-symbol').innerText = token.symbol;
    
    // Price formatting
    let priceStr = '$' + token.price.toFixed(2);
    if(token.price < 0.01) priceStr = '$' + token.price.toFixed(6);
    if(token.price < 0.000001) priceStr = '$' + token.price.toExponential(4);
    document.getElementById('m-price').innerText = priceStr;

    // Use Modal Slots for DEX Data
    // Slot 1: Contract
    const box1 = document.querySelector('.modal-grid .stat-box:nth-child(1)');
    if(box1) {
        box1.querySelector('.label').innerText = "Contract";
        // Shorten address
        const addr = token.contract || "N/A";
        const shortAddr = addr.length > 10 ? addr.substring(0,6) + '...' + addr.substring(addr.length-4) : addr;
        box1.querySelector('.value').innerText = shortAddr;
        box1.querySelector('.value').title = addr; // Tooltip
    }

    // Slot 2: Volume
    const box2 = document.querySelector('.modal-grid .stat-box:nth-child(2)');
    if(box2) {
        box2.querySelector('.label').innerText = "24h Volume";
        box2.querySelector('.value').innerText = '$' + Math.floor(token.volume_24h).toLocaleString();
    }

    // Hide History (Not available in basic DEX endpoint)
    const history = document.querySelector('.modal-history');
    if(history) history.style.display = 'none';

    // Actions
    const actionContainer = document.querySelector('.modal-actions');
    if(actionContainer) {
        // Construct Scan Link
        let scanUrl = "#";
        if (token.platform.toLowerCase().includes("solana")) scanUrl = `https://solscan.io/token/${token.contract}`;
        else if (token.platform.toLowerCase().includes("eth")) scanUrl = `https://etherscan.io/token/${token.contract}`;
        else if (token.platform.toLowerCase().includes("bsc") || token.platform.toLowerCase().includes("bnb")) scanUrl = `https://bscscan.com/token/${token.contract}`;
        else if (token.platform.toLowerCase().includes("base")) scanUrl = `https://basescan.org/token/${token.contract}`;

        actionContainer.innerHTML = `
            <a href="${scanUrl}" target="_blank" class="action-btn tv-btn" style="width:100%">
                <i class="fas fa-search"></i> View on Explorer
            </a>
        `;
    }

    modal.classList.add('active');
}