// Universal UI Logic

document.addEventListener('DOMContentLoaded', () => {
    setupMenu();
    setupModalClosers();
});

// MENU LOGIC
function setupMenu() {
    const hamburger = document.getElementById('mobile-menu');
    const navMenu = document.querySelector('.nav-menu');
    const navLinks = document.querySelectorAll('.nav-link');

    if (hamburger && navMenu) {
        const newHamburger = hamburger.cloneNode(true);
        hamburger.parentNode.replaceChild(newHamburger, hamburger);

        newHamburger.addEventListener('click', (e) => {
            e.stopPropagation();
            newHamburger.classList.toggle('active');
            navMenu.classList.toggle('active');
        });

        document.addEventListener('click', (e) => {
            if (navMenu.classList.contains('active') && 
                !navMenu.contains(e.target) && 
                !newHamburger.contains(e.target)) {
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

// MODAL LOGIC
function setupModalClosers() {
    const modal = document.getElementById('coin-modal');
    const closeBtn = document.querySelector('.close-modal'); 

    // Click the "X" Button
    if (closeBtn) {
        closeBtn.onclick = function() {
            closeModal();
        }
    }

    // Click Outsie
    if (modal) {
        window.onclick = function(event) {
           
            if (event.target === modal) {
                closeModal();
            }
        }
        
        // C. Escape Key Support (Bonus accessibility)
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });
    }
}

function closeModal() {
    const modal = document.getElementById('coin-modal');
    if(modal) modal.classList.remove('active');
}

// SNAPSHOT LOGIC
async function captureSection(type) {
    const btn = document.getElementById(type === 'gainers' ? 'btn-gain' : 'btn-lose');
    if (!btn) return;

    const originalText = btn.innerHTML;
    const sourceListId = type === 'gainers' ? 'gainers-list' : 'losers-list';
    const listElement = document.getElementById(sourceListId);
    
    if (!listElement) return;

    const count = listElement.children.length;

    // --- SMART TITLE DETECTION ---
    const isDexPage = window.location.pathname.includes('dex-movers');
    const pageLabel = isDexPage ? 'DEX' : 'Crypto';
    
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
        const titleText = `${pageLabel} Top ${count} ${type === 'gainers' ? 'Gainers' : 'Losers'} (24H)`;
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

        const bubbles = listElement.querySelectorAll('.bubble');

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
        
        // FOOTER
        reportCard.insertAdjacentHTML('beforeend', `
            <div style="font-size: 18px; color: #64748b; font-weight: 600; margin-top: 30px; display:flex; align-items:center; gap:10px;">
                <img src="/images/bullish.png" style="width:30px;">
         Generated on https://cryptomovers.pages.dev | by @heisbuba
            </div>
        `);

        document.body.appendChild(reportCard);
        
        const canvas = await html2canvas(reportCard, { scale: 3, useCORS: true, backgroundColor: null });
        const link = document.createElement('a');
        link.download = `CTDGL_${pageLabel}_Top${count}_${new Date().toISOString().split('T')[0]}.png`;
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