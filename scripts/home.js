// home.js

document.addEventListener('DOMContentLoaded', () => {
    console.log("CryptoMovers: Home.js loaded");

    // === CONFIGURATION ===
    const REFRESH_INTERVAL = 60000; // 1 minute
    let currentNetwork = 'main';    
    let isLoading = false;

    // === DOM ELEMENTS ===
    const gainersList = document.getElementById('gainers-list');
    const losersList = document.getElementById('losers-list');
    const lastUpdatedEl = document.getElementById('last-updated');
    const refreshTimerEl = document.getElementById('refresh-timer');
    
    // Select all buttons that act as network switchers
    const networkButtons = document.querySelectorAll('.network-btn, button[data-network]');

    // === SAFETY CHECK ===
    if (!gainersList || !losersList) {
        console.error("CRITICAL ERROR: Missing HTML elements 'gainers-list' or 'losers-list'");
        alert("Error: The website HTML is missing 'gainers-list' or 'losers-list' IDs. Check index.html.");
        return;
    }

    // === INITIALIZATION ===
    init();

    function init() {
        // Setup Buttons
        if (networkButtons.length > 0) {
            networkButtons.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    // Get network from data-network attribute OR value attribute
                    const selected = e.target.getAttribute('data-network') || e.target.value || 'main';
                    switchNetwork(selected, e.target);
                });
            });
        }

        // Initial Fetch
        fetchData();

        // Start Timer
        startTimer();
    }

    // === NETWORK SWITCHING ===
    function switchNetwork(network, btnElement) {
        if (isLoading || currentNetwork === network) return;
        
        console.log(`Switching network to: ${network}`);
        currentNetwork = network;

        // Update Button UI
        if (networkButtons) {
            networkButtons.forEach(b => b.classList.remove('active'));
            if (btnElement) btnElement.classList.add('active');
        }

        // Show Spinners
        gainersList.innerHTML = '<div class="loading-spinner">Loading data...</div>';
        losersList.innerHTML = '<div class="loading-spinner">Loading data...</div>';
        
        fetchData();
    }

    // === DATA FETCHING ===
    async function fetchData() {
        if (isLoading) return;
        isLoading = true;

        try {
            console.log("Fetching data...");
            
            // Build URL based on network
            let url = '/api/stats';
            if (currentNetwork !== 'main') {
                url += `?network=${currentNetwork}`;
            }

            // Fetch with a 15-second timeout to prevent infinite hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);

            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                if (response.status === 429) throw new Error("API Busy (Rate Limit)");
                if (response.status === 500) throw new Error("Worker Error (Check KV Binding)");
                throw new Error(`Server Error: ${response.status}`);
            }

            const data = await response.json();

            if (data.error) throw new Error(data.message || "API reported an error");

            renderLists(data);
            updateStatus(data.timestamp, data.isPartial);

        } catch (err) {
            console.error("Fetch Error:", err);
            renderError(err.name === 'AbortError' ? "Network Timeout" : err.message);
        } finally {
            isLoading = false;
        }
    }

    // === RENDERING ===
    function renderLists(data) {
        gainersList.innerHTML = '';
        losersList.innerHTML = '';

        const gainers = data.gainers || [];
        const losers = data.losers || [];

        if (gainers.length === 0) {
            gainersList.innerHTML = '<div class="empty-state">No gainers found</div>';
        } else {
            gainers.forEach(coin => gainersList.appendChild(createCard(coin)));
        }

        if (losers.length === 0) {
            losersList.innerHTML = '<div class="empty-state">No losers found</div>';
        } else {
            losers.forEach(coin => losersList.appendChild(createCard(coin)));
        }
    }

    function createCard(coin) {
        const card = document.createElement('div');
        card.className = 'coin-card';
        
        // Image Logic
        let imgUrl = coin.image;
        if (currentNetwork !== 'main') {
            imgUrl = `/api/image-proxy?url=${encodeURIComponent(coin.image)}`;
        }

        // Link Logic
        let linkUrl = '#';
        if (currentNetwork === 'main') {
            linkUrl = `https://www.coingecko.com/en/coins/${coin.id}`;
        } else {
            linkUrl = `https://www.geckoterminal.com/${currentNetwork}/pools/${coin.address}`;
        }

        const price = coin.current_price || coin.price || 0;
        const displayPrice = price < 1 ? price.toFixed(6) : price.toFixed(2);
        
        // Handle different property names from the two APIs
        const change = coin.price_change_percentage_24h || coin.change_24h || 0;
        const changeClass = change >= 0 ? 'positive' : 'negative';
        const changeSign = change >= 0 ? '+' : '';

        card.innerHTML = `
            <a href="${linkUrl}" target="_blank" rel="noopener" class="card-link">
                <div class="card-header">
                    <img src="${imgUrl}" alt="${coin.symbol}" loading="lazy" onerror="this.src='https://placehold.co/32x32?text=?'">
                    <div class="card-info">
                        <span class="coin-symbol">${coin.symbol.toUpperCase()}</span>
                        <span class="coin-name">${coin.name}</span>
                    </div>
                </div>
                <div class="card-stats">
                    <span class="price">$${displayPrice}</span>
                    <span class="change ${changeClass}">${changeSign}${change.toFixed(2)}%</span>
                </div>
            </a>
        `;
        return card;
    }

    function renderError(msg) {
        const errorHtml = `<div class="error-message" style="color: red; padding: 20px; text-align: center;">⚠️ ${msg}</div>`;
        gainersList.innerHTML = errorHtml;
        losersList.innerHTML = errorHtml;
    }

    function updateStatus(timestamp, isPartial) {
        if (!lastUpdatedEl) return;
        const date = new Date(timestamp);
        let text = `Updated: ${date.toLocaleTimeString()}`;
        if (isPartial) text += ' (Partial Data)';
        lastUpdatedEl.textContent = text;
    }

    function startTimer() {
        if (!refreshTimerEl) return;
        let seconds = REFRESH_INTERVAL / 1000;
        setInterval(() => {
            seconds--;
            if (seconds <= 0) {
                seconds = REFRESH_INTERVAL / 1000;
                fetchData();
            }
            refreshTimerEl.textContent = `Next update: ${seconds}s`;
        }, 1000);
    }
});