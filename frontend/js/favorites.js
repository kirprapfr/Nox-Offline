// GAMS PERSISTENT BOOKMARK SYSTEM
document.addEventListener('DOMContentLoaded', () => {
    // 1. Target Selector: Set this to match whatever class holds your individual game items
    const CARD_CLASS = '.game-link';

    let favorites = JSON.parse(localStorage.getItem('gams_bookmarks')) || [];

    // 2. Inject CSS rules for the stars dynamically
    const style = document.createElement('style');
    style.innerHTML = `
        ${CARD_CLASS} { position: relative !important; }
        .gams-star {
            position: absolute !important;
            top: 6px !important;
            right: 6px !important;
            z-index: 99999 !important;
            background: rgba(0, 0, 0, 0.8) !important;
            border: 1px solid rgba(255, 255, 255, 0.15) !important;
            border-radius: 50% !important;
            width: 26px !important;
            height: 26px !important;
            font-size: 14px !important;
            color: #777 !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: transform 0.1s ease, color 0.1s ease !important;
        }
        .gams-star:hover { transform: scale(1.15); }
        ${CARD_CLASS}.is-bookmarked .gams-star {
            color: #ffcc00 !important;
            text-shadow: 0 0 4px rgba(255, 204, 0, 0.6);
        }
    `;
    document.head.appendChild(style);

    // 3. Scan and initialize items dynamically
    const initFavorites = () => {
        const gameCards = document.querySelectorAll(CARD_CLASS);

        gameCards.forEach((card, index) => {
            if (card.querySelector('.gams-star')) return; // Skip if already starred

            // Use the title (or a fallback index) as the identity marker
            const textEl = card.querySelector('div') || card.querySelector('p') || card.querySelector('span');
            const gameId =
                card.getAttribute('data-id') ||
                (textEl ? textEl.innerText.trim().replace(/\s+/g, '-').toLowerCase() : `game-${index}`);
            card.setAttribute('data-id', gameId);

            const star = document.createElement('button');
            star.className = 'gams-star';
            star.innerHTML = '★';
            card.appendChild(star);

            if (favorites.includes(gameId)) {
                card.classList.add('is-bookmarked');
            }

            star.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (favorites.includes(gameId)) {
                    favorites = favorites.filter((id) => id !== gameId);
                    card.classList.remove('is-bookmarked');
                } else {
                    favorites.push(gameId);
                    card.classList.add('is-bookmarked');
                }

                localStorage.setItem('gams_bookmarks', JSON.stringify(favorites));
                applyLayoutSorting(gameCards);
            });
        });

        applyLayoutSorting(gameCards);
    };

    function applyLayoutSorting(cards) {
        cards.forEach((card) => {
            const gameId = card.getAttribute('data-id');
            if (favorites.includes(gameId)) {
                card.style.order = '-1'; // Natively pushes the item to the top of flex/grid layouts
            } else {
                card.style.order = '0';
            }
        });
    }

    // htmx replaces the library grid after this script loads, so re-scan then too.
    document.addEventListener('htmx:afterSwap', initFavorites);

    // Run sorting loop
    initFavorites();
    setInterval(initFavorites, 1000);
});
