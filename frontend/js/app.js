let showOnlyFavorites = false;
let currentHeroIndex = 0;
let gamesGridCleared = false;
let noxIdentity = null;
let noxWhitelisted = false;
let noxAccessStatus = 'unknown';

const NOX_ID_STORAGE = 'nox_user_id';
const NOX_NAME_STORAGE = 'nox_username';
const NOX_WINDOW_NAME_PREFIX = 'nox-identity:';
const NOX_HASH_USER = 'nox-user';
const NOX_HASH_NAME = 'nox-name';

function backendPath(path) {
    if (!path) return path;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(path) || path.indexOf('data:') === 0) return path;
    const backend = window.NOX_BACKEND || '';
    return backend + '/' + path.replace(/^\/+/, '');
}

function gameFile(name) {
    // The backend expects the approved user ID as the first path segment so the
    // game and every relative asset it requests are whitelist-checked.
    const identity = getIdentity();
    if (!identity) return '';
    return backendPath('gamefiles/' + encodeURIComponent(identity.userID) + '/' + name);
}
function gameImage(name) {
    return backendPath('gameimages/' + name);
}
function mediaImage(name) {
    return (window.NOX_MEDIA_IMAGES || 'mediaimages/') + name;
}

function getCookie(name) {
    try {
        const cookies = document.cookie.split('; ');

        for (const cookie of cookies) {
            const [key, ...value] = cookie.split('=');

            if (key === name) {
                return decodeURIComponent(value.join('='));
            }
        }
    } catch (error) {
        // Cookies are not always available on file:// pages.
    }

    return null;
}

function setCookie(name, value) {
    try {
        document.cookie = name + '=' + encodeURIComponent(value) + '; path=/; max-age=31536000; SameSite=Lax';
    } catch (error) {
        // Cookies are not always available on file:// pages; localStorage is the fallback.
    }
}

function readStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        return null;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        // Ignore storage failures and keep the in-memory identity.
    }
}

function generateUserID(username) {
    const slug =
        (username || 'user')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 24) || 'user';
    let suffix;

    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        suffix = window.crypto.randomUUID().slice(0, 8);
    } else {
        suffix = Math.random().toString(36).slice(2, 10);
    }

    return slug + '-' + suffix;
}



function readWindowNameIdentity() {
    try {
        if (!window.name || window.name.indexOf(NOX_WINDOW_NAME_PREFIX) !== 0) return null;

        const parsed = JSON.parse(window.name.slice(NOX_WINDOW_NAME_PREFIX.length));
        if (!parsed || !parsed.userID) return null;

        return {
            userID: String(parsed.userID),
            username: String(parsed.username || parsed.userID),
        };
    } catch (error) {
        return null;
    }
}

// `file://` pages are often treated as opaque origins, so localStorage and
// cookies can be unavailable. Keep a copy in the URL hash and window.name so
// the generated ID survives a reload.
function persistIdentityFallbacks(identity) {
    try {
        window.name = NOX_WINDOW_NAME_PREFIX + JSON.stringify(identity);
    } catch (error) {
        // Ignore restricted window.name.
    }

    if (!window.NOX_IS_FILE) return;

    let hash = '';
    try {
        const params = new URLSearchParams();
        params.set(NOX_HASH_USER, identity.userID);
        params.set(NOX_HASH_NAME, identity.username);
        hash = '#' + params.toString();
        window.history.replaceState(null, '', hash);
    } catch (error) {
        if (hash) {
            try {
                window.location.hash = hash;
            } catch (hashError) {
                // Ignore unavailable history APIs.
            }
        }
    }
}

function readIdentity() {
    let userID = readStorage(NOX_ID_STORAGE) || getCookie('userID');
    let username = readStorage(NOX_NAME_STORAGE) || getCookie('username');

    if (!userID) {
        const remembered = readWindowNameIdentity();
        if (!remembered) return null;

        userID = remembered.userID;
        username = remembered.username;

        // Best-effort copy back into normal storage.
        writeStorage(NOX_ID_STORAGE, userID);
        writeStorage(NOX_NAME_STORAGE, username);
        setCookie('userID', userID);
        setCookie('username', username);
    }

    if (!username) username = userID;

    // The old prompt implementation fell back to "guest" when the prompt was
    // blocked. Treat that leftover as unset so the username form can take over.
    if (username.toLowerCase() === 'guest' && userID.toLowerCase().indexOf('guest-') === 0) {
        return null;
    }

    return { userID: userID, username: username };
}

function saveIdentity(username) {
    const cleanName =
        String(username || '')
            .trim()
            .slice(0, 32) || 'guest';
    const identity = { userID: generateUserID(cleanName), username: cleanName };

    writeStorage(NOX_ID_STORAGE, identity.userID);
    writeStorage(NOX_NAME_STORAGE, identity.username);
    setCookie('userID', identity.userID);
    setCookie('username', identity.username);
    persistIdentityFallbacks(identity);

    noxIdentity = identity;
    return identity;
}

function getIdentity() {
    if (!noxIdentity) noxIdentity = readIdentity();
    return noxIdentity;
}

function showIdentityModal(message) {
    const modal = document.getElementById('identity-modal');
    if (!modal) return;

    const wasHidden = modal.hidden;
    const error = document.getElementById('identity-error');
    if (error && (message || wasHidden)) error.textContent = message || '';

    modal.hidden = false;

    const input = document.getElementById('identity-username');
    if (wasHidden && input) {
        input.value = '';
        setTimeout(function () {
            input.focus();
        }, 0);
    }
}

function hideIdentityModal() {
    const modal = document.getElementById('identity-modal');
    if (modal) modal.hidden = true;
}

function submitIdentity(event) {
    event.preventDefault();

    const input = document.getElementById('identity-username');
    const error = document.getElementById('identity-error');
    const username = (input ? input.value : '').trim();

    if (username.length < 2) {
        if (error) error.textContent = 'Enter a username with at least 2 characters.';
        if (input) input.focus();
        return;
    }

    if (username.toLowerCase() === 'guest') {
        if (error) error.textContent = 'Please choose a name other than "guest".';
        if (input) input.focus();
        return;
    }

    const identity = saveIdentity(username);
    hideIdentityModal();
    updateProfile(identity, 'unknown');

    const grid = document.querySelector('#games-section .media-grid');
    if (grid) grid.innerHTML = '<div class="empty-note">Checking whitelist...</div>';

    initWhitelistGate();
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function updateProfile(identity, status) {
    const avatar = document.getElementById('profile-avatar');
    const name = document.getElementById('profile-name');
    const sub = document.getElementById('profile-sub');

    if (avatar) {
        avatar.innerText = (identity.username || 'NX').slice(0, 2).toUpperCase();
    }
    if (name) {
        name.innerText = identity.username || 'Player';
    }
    if (sub) {
        const labels = {
            approved: 'Whitelisted',
            pending: 'Pending approval',
            denied: 'Access denied',
            unknown: 'Checking access',
        };
        sub.innerText = labels[status] || 'Checking access';
        sub.style.color = status === 'approved' ? '#34d399' : status === 'denied' ? '#f87171' : '#fbbf24';
    }
}

async function fetchWhitelistStatus(userID) {
    const response = await fetch(backendPath('api/whitelist/status') + '?userID=' + encodeURIComponent(userID), {
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error('Could not check whitelist status');
    }

    return response.json();
}

async function requestWhitelistAccess(identity) {
    const response = await fetch(backendPath('api/whitelist/request'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userID: identity.userID, username: identity.username }),
    });

    if (!response.ok) {
        throw new Error('Could not request whitelist access');
    }

    return response.json();
}

function renderWhitelistGate(identity, status) {
    const grid = document.querySelector('#games-section .media-grid');
    if (!grid) return;

    let title = 'Whitelist required';
    let message =
        'Nox is invite-only. Your access request has been recorded. An admin must approve your user ID from the terminal.';

    if (status === 'pending') {
        title = 'Access pending';
        message = 'Your access request is waiting for approval. An admin must approve your user ID from the terminal.';
    } else if (status === 'denied') {
        title = 'Access denied';
        message = 'An admin denied access for this user ID. Contact the admin if you think this is a mistake.';
    }

    const userID = escapeHtml(identity.userID);
    grid.innerHTML =
        '<div class="whitelist-gate">' +
        '<div class="whitelist-gate-icon"></div>' +
        '<h3>' +
        escapeHtml(title) +
        '</h3>' +
        '<p>' +
        escapeHtml(message) +
        '</p>' +
        '<p class="whitelist-id">User ID: <code>' +
        userID +
        '</code></p>' +
        '<button class="whitelist-retry" onclick="refreshWhitelistStatus()">Check again</button>' +
        '</div>';

    updateProfile(identity, status);

    const libText = document.getElementById('library-count-text');
    if (libText) libText.innerText = title;

    const badge = document.getElementById('total-games-badge');
    if (badge) badge.innerText = 'Locked';
}

function loadGamesGrid(identity) {
    const grid = document.querySelector('#games-section .media-grid');
    if (!grid) return;

    gamesGridCleared = false;
    grid.innerHTML = '<div class="empty-note">Loading games...</div>';

    const url = backendPath('api/games') + '?userID=' + encodeURIComponent(identity.userID);

    if (window.htmx) {
        htmx.ajax('GET', url, { target: grid, swap: 'innerHTML' });
        return;
    }

    fetch(url)
        .then(function (response) {
            if (!response.ok) throw new Error('Could not load games');
            return response.text();
        })
        .then(function (html) {
            grid.innerHTML = html;
            updateGameCounts();
        })
        .catch(showGamesLoadError);
}

async function initWhitelistGate() {
    const grid = document.querySelector('#games-section .media-grid');
    if (!grid) return;

    gamesGridCleared = false;

    const identity = getIdentity();
    if (!identity) {
        grid.innerHTML = '<div class="empty-note">Enter a username to request access.</div>';
        showIdentityModal();
        return;
    }

    updateProfile(identity, 'unknown');
    grid.innerHTML = '<div class="empty-note">Checking whitelist...</div>';

    try {
        let status = await fetchWhitelistStatus(identity.userID);

        if (status.status === 'unknown') {
            status = await requestWhitelistAccess(identity);
        }

        if (status.whitelisted) {
            noxWhitelisted = true;
            updateProfile(identity, 'approved');
            renderHomeWidgets();
            renderRecentGames();
            loadGamesGrid(identity);
        } else {
            noxWhitelisted = false;
            renderWhitelistGate(identity, status.status);
            renderHomeWidgets();
            renderRecentGames();
        }
    } catch (error) {
        noxWhitelisted = false;
        updateProfile(identity, 'unknown');
        showGamesLoadError();
        renderHomeWidgets();
        renderRecentGames();
    }
}

function refreshWhitelistStatus() {
    initWhitelistGate();
}

const heroSlides = [
    {
        title: 'Hollow Knight',
        file: 'hollowknight.html',
        img: gameImage('hollowknight.png'),
        tags: ['Action', 'Metroidvania', 'Indie'],
        meta: '★ 4.9  •  Featured Pick',
        desc: 'Explore twisting caverns, battle tainted creatures, and uncover ancient mysteries in a vast hand-drawn subterranean kingdom.',
    },
    {
        title: 'Celeste',
        file: 'celeste.html',
        img: gameImage('celeste.png'),
        tags: ['Platformer', 'Precision', 'Story'],
        meta: '★ 4.9  •  Top Rated',
        desc: 'Help Madeline survive her inner demons on her journey to the top of Celeste Mountain in this tight, hand-crafted platformer.',
    },
    {
        title: 'ULTRAKILL',
        file: 'ultrakill.html',
        img: gameImage('ultrakill.jpg'),
        tags: ['FPS', 'Fast-Paced', 'Retro'],
        meta: '★ 4.8  •  Trending #1',
        desc: 'Mankind is dead. Blood is fuel. Hell is full. Chain relentless movement and combos in a high-speed retro shooter.',
    },
    {
        title: 'Minecraft 1.12.2',
        file: 'minecraft1.12.2.html',
        img: gameImage('minecraftindev.webp'),
        tags: ['Sandbox', 'Survival', 'Open World'],
        meta: '★ 4.9  •  Classic',
        desc: 'Build anything you can imagine, mine deep underground, and survive the night in an infinite blocky world.',
    },
];

const featuredGamesData = [
    {
        title: 'Pizza Tower',
        file: 'pizzatower.html',
        img: gameImage('pizzatower.png'),
        genre: 'Platformer',
        badge: 'HOT',
    },
    {
        title: 'Deltarune',
        file: 'deltarune.html',
        img: gameImage('deltarune.png'),
        genre: 'RPG',
        badge: 'TOP',
    },
    {
        title: 'Balatro',
        file: 'balatro.html',
        img: gameImage('balatro.jpg'),
        genre: 'Card Roguelike',
        badge: 'NEW',
    },
    {
        title: 'Cuphead',
        file: 'cuphead.html',
        img: gameImage('cuphead.png'),
        genre: 'Run & Gun',
        badge: 'CLASSIC',
    },
];

const quickLaunchData = [
    { title: 'Geometry Dash', file: 'geometrydash.html', img: gameImage('geometrydash.png'), tag: 'Rhythm' },
    { title: 'Retro Bowl', file: 'retrobowl.html', img: gameImage('retrobowl.png'), tag: 'Sports' },
    {
        title: 'Subway Surfers',
        file: 'subwaysurfers.html',
        img: gameImage('subwaysurfers.png'),
        tag: 'Runner',
    },
    { title: 'Terraria', file: 'terraria.html', img: gameImage('terraria.png'), tag: 'Adventure' },
    { title: 'Slope 1', file: 'slope1.html', img: gameImage('slope1.png'), tag: 'Arcade' },
];

const topMediaCache = { anime: null, manga: null };

const fallbackTopMedia = {
    anime: [
        { title: "Frieren: Beyond Journey's End", score: '9.32', sub: '28 eps', img: mediaImage('frieren.jpg') },
        { title: 'Fullmetal Alchemist: Brotherhood', score: '9.09', sub: '64 eps', img: mediaImage('fmab.jpg') },
        { title: 'Steins;Gate', score: '9.07', sub: '24 eps', img: mediaImage('steinsgate.jpg') },
        { title: 'Attack on Titan', score: '8.95', sub: 'Final Season', img: mediaImage('aot.jpg') },
        { title: 'Hunter x Hunter (2011)', score: '9.03', sub: '148 eps', img: mediaImage('hxh.jpg') },
        { title: 'Bleach: TYBW', score: '9.02', sub: 'Part 3', img: mediaImage('bleach.jpg') },
    ],
    manga: [
        { title: 'Berserk', score: '9.47', sub: '375+ ch', img: mediaImage('berserk.jpg') },
        { title: 'JoJo Part 7: Steel Ball Run', score: '9.30', sub: '95 ch', img: mediaImage('sbr.jpg') },
        { title: 'Vagabond', score: '9.25', sub: '327 ch', img: mediaImage('vagabond.jpg') },
        { title: 'One Piece', score: '9.22', sub: '1100+ ch', img: mediaImage('onepiece.jpg') },
        { title: 'Monster', score: '9.15', sub: '162 ch', img: mediaImage('monster.jpg') },
        { title: 'Vinland Saga', score: '9.06', sub: '210+ ch', img: mediaImage('vinlandsaga.jpg') },
    ],
};

function renderHeroSlide(index) {
    currentHeroIndex = (index + heroSlides.length) % heroSlides.length;
    const slide = heroSlides[currentHeroIndex];

    const banner = document.getElementById('hero-banner');
    if (banner) {
        banner.style.backgroundImage =
            "linear-gradient(to right, rgba(12, 16, 26, 0.96) 36%, rgba(19, 25, 43, 0.35)), url('" + slide.img + "')";
    }
    const tagsEl = document.getElementById('hero-tags');
    if (tagsEl) {
        tagsEl.innerHTML = slide.tags
            .map(function (t) {
                return '<span>' + t + '</span>';
            })
            .join('');
    }
    const titleEl = document.getElementById('hero-title');
    if (titleEl) titleEl.innerText = slide.title;

    const descEl = document.getElementById('hero-desc');
    if (descEl) descEl.innerText = slide.desc;

    const metaEl = document.getElementById('hero-meta');
    if (metaEl) metaEl.innerText = slide.meta;

    const playBtn = document.getElementById('hero-play-btn');
    if (playBtn) {
        playBtn.onclick = function () {
            launchStreamPortal(slide.title, gameFile(slide.file), slide.img);
        };
    }

    document.querySelectorAll('.hero-thumb-card').forEach(function (card, i) {
        card.classList.toggle('active', i === currentHeroIndex);
    });
}

function cycleHero(delta) {
    renderHeroSlide(currentHeroIndex + delta);
}

function renderHeroSelectors() {
    const row = document.getElementById('hero-selector-row');
    if (!row) return;
    row.innerHTML = '';
    heroSlides.forEach(function (slide, i) {
        const card = document.createElement('div');
        card.className = 'hero-thumb-card' + (i === 0 ? ' active' : '');
        card.innerHTML =
            '<img src="' +
            slide.img +
            '" alt="' +
            slide.title +
            '">' +
            '<div>' +
            '<div class="hero-thumb-title">' +
            slide.title +
            '</div>' +
            '<div class="hero-thumb-sub">' +
            slide.tags +
            '</div>' +
            '</div>';
        card.addEventListener('click', function () {
            renderHeroSlide(i);
        });
        row.appendChild(card);
    });
}

function switchTab(sectionId, buttonElement) {
    closeStreamPortal();
    document.querySelectorAll('.tab-content').forEach(function (panel) {
        panel.style.display = 'none';
    });
    const targetSection = document.getElementById(sectionId);
    if (targetSection) targetSection.style.display = 'block';

    document.querySelectorAll('.nav-tab-btn').forEach(function (btn) {
        btn.classList.remove('active');
    });
    if (buttonElement) {
        buttonElement.classList.add('active');
    }
}

function releaseGamesGrid() {
    const grid = document.querySelector('#games-section .media-grid');
    if (!grid || gamesGridCleared) return;

    // Abort any in-flight catalog request and drop every card/image from the DOM
    // so the browser can release the list and thumbnail memory while a game runs.
    gamesGridCleared = true;
    if (window.htmx) htmx.trigger(grid, 'htmx:abort');
    grid.querySelectorAll('img').forEach(function (img) {
        img.src = '';
    });
    grid.innerHTML = '<div class="empty-note">Playing game...</div>';
}

function restoreGamesGrid() {
    if (!gamesGridCleared) return;
    gamesGridCleared = false;
    initWhitelistGate();
}

function launchStreamPortal(name, hostUrl, imgSrc) {
    if (!hostUrl || hostUrl === 'URL_HERE') return;

    const isGameFile = hostUrl.indexOf('/gamefiles/') !== -1;

    // Never open a game from the UI unless the whitelist check passed. The
    // backend also rejects the game file itself, so this is only a UX guard.
    if (isGameFile && !noxWhitelisted) {
        switchTab('games-section', document.getElementById('nav-games'));
        initWhitelistGate();
        return;
    }

    if (isGameFile) releaseGamesGrid();

    document.getElementById('active-stream-title').innerText = name;
    document.getElementById('nox-secure-iframe').src = hostUrl;
    document.getElementById('inline-stream-layer').style.display = 'flex';

    if (isGameFile) {
        saveRecentGame(name, hostUrl, imgSrc || '');
    }
}

function closeStreamPortal() {
    const iframe = document.getElementById('nox-secure-iframe');
    if (iframe) iframe.src = '';
    document.getElementById('inline-stream-layer').style.display = 'none';
    restoreGamesGrid();
}

function reloadStreamPortal() {
    const iframe = document.getElementById('nox-secure-iframe');
    if (!iframe || !iframe.src) return;
    const src = iframe.src;
    iframe.src = 'about:blank';
    setTimeout(function () {
        iframe.src = src;
    }, 50);
}

function togglePlayerFullscreen() {
    const layer = document.getElementById('inline-stream-layer');
    if (!layer) return;
    if (document.fullscreenElement) {
        document.exitFullscreen();
    } else if (layer.requestFullscreen) {
        layer.requestFullscreen();
    }
}

function loadSpotifyEmbed() {
    const input = document.getElementById('spotify-url-input');
    const frame = document.getElementById('spotify-embed-frame');
    if (!input || !frame) return;

    const value = input.value.trim();
    const match = value.match(/spotify\.com\/(?:intl-[^/]+\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]+)/);
    if (!match) {
        frame.src = 'about:blank';
        return;
    }

    frame.src = 'https://open.spotify.com/embed/' + match[1] + '/' + match[2];
}

function readRecentGames() {
    try {
        return JSON.parse(readStorage('nox_recent_games')) || [];
    } catch (error) {
        return [];
    }
}

function saveRecentGame(title, href, img) {
    let recent = readRecentGames();
    recent = recent.filter(function (item) {
        return item.title !== title;
    });
    recent.unshift({ title: title, href: href, img: img || gameImage('minecraftindev.webp') });
    recent = recent.slice(0, 4);
    writeStorage('nox_recent_games', JSON.stringify(recent));
    renderRecentGames();
}

function renderRecentGames() {
    const list = document.getElementById('recent-games-list');
    if (!list) return;

    if (!noxWhitelisted) {
        list.innerHTML = '<div class="empty-note">Whitelist required to resume games.</div>';
        return;
    }

    const recent = readRecentGames();
    if (!recent.length) {
        list.innerHTML = '<div class="empty-note">Nothing played yet.</div>';
        return;
    }

    list.innerHTML = '';
    recent.forEach(function (item) {
        const row = document.createElement('div');
        row.className = 'recent-item';
        row.innerHTML =
            '<img src="' +
            item.img +
            '" alt="' +
            item.title +
            '">' +
            '<div>' +
            '<div class="recent-item-title">' +
            item.title +
            '</div>' +
            '<div class="recent-item-sub">Resume</div>' +
            '</div>';
        row.addEventListener('click', function () {
            launchStreamPortal(item.title, item.href, item.img);
        });
        list.appendChild(row);
    });
}

function renderLockedHome() {
    const featuredRow = document.getElementById('featured-games-row');
    if (featuredRow) {
        featuredRow.innerHTML = '<div class="empty-note">Whitelist required to load games.</div>';
    }

    const quickList = document.getElementById('quick-launch-list');
    if (quickList) {
        quickList.innerHTML = '<div class="empty-note">Whitelist required.</div>';
    }
}

function renderHomeWidgets() {
    if (!noxWhitelisted) {
        renderLockedHome();
        return;
    }

    const featuredRow = document.getElementById('featured-games-row');
    if (featuredRow) {
        featuredRow.innerHTML = '';
        featuredGamesData.forEach(function (g) {
            const card = document.createElement('div');
            card.className = 'featured-poster';
            card.innerHTML =
                '<img src="' +
                g.img +
                '" alt="' +
                g.title +
                '">' +
                '<span class="featured-badge">' +
                g.badge +
                '</span>' +
                '<div class="featured-poster-overlay">' +
                '<div class="featured-poster-title">' +
                g.title +
                '</div>' +
                '<div class="featured-poster-genre">' +
                g.genre +
                '</div>' +
                '</div>';
            card.addEventListener('click', function () {
                launchStreamPortal(g.title, gameFile(g.file), g.img);
            });
            featuredRow.appendChild(card);
        });
    }

    const quickList = document.getElementById('quick-launch-list');
    if (quickList) {
        quickList.innerHTML = '';
        quickLaunchData.forEach(function (q) {
            const item = document.createElement('div');
            item.className = 'quick-item';
            item.innerHTML =
                '<img src="' +
                q.img +
                '" alt="' +
                q.title +
                '">' +
                '<div>' +
                '<div class="quick-item-title">' +
                q.title +
                '</div>' +
                '<div class="quick-item-status">' +
                q.tag +
                '</div>' +
                '</div>';
            item.addEventListener('click', function () {
                launchStreamPortal(q.title, gameFile(q.file), q.img);
            });
            quickList.appendChild(item);
        });
    }
}

function initGamesGrid() {
    const gridContainer = document.querySelector('#games-section .media-grid');
    if (!gridContainer || gridContainer.dataset.noxBound === 'true') return;
    gridContainer.dataset.noxBound = 'true';

    gridContainer.addEventListener('click', function (e) {
        if (e.target.closest('.gams-star')) return;
        const link = e.target.closest('.game-link');
        if (!link) return;

        e.preventDefault();
        const titleEl = link.querySelector('div');
        const title = link.getAttribute('data-title') || (titleEl ? titleEl.innerText : '');
        const url = link.getAttribute('href');
        const imgEl = link.querySelector('img');
        const imgSrc = imgEl ? imgEl.getAttribute('src') : '';
        launchStreamPortal(title, url, imgSrc);
    });
}

function updateGameCounts() {
    if (gamesGridCleared) return;

    const gridContainer = document.querySelector('#games-section .media-grid');
    if (!gridContainer) return;

    const totalCount = gridContainer.querySelectorAll('.game-link').length;
    const countBadge = document.getElementById('total-games-badge');
    if (countBadge && totalCount > 0) countBadge.innerText = totalCount;

    applyGameFilters();
}

function showGamesLoadError() {
    if (gamesGridCleared) return;

    const gridContainer = document.querySelector('#games-section .media-grid');
    if (!gridContainer) return;
    gridContainer.innerHTML =
        '<div class="empty-note">Could not load games from the server. Is the backend running?</div>';

    const libText = document.getElementById('library-count-text');
    if (libText) libText.innerText = 'Catalog unavailable';
}

document.addEventListener('htmx:configRequest', function (event) {
    const detail = event.detail;
    if (!detail || typeof detail.path !== 'string') return;
    if (!/\/api\/games$/.test(detail.path)) return;
    if (detail.parameters && detail.parameters.userID) return;

    const identity = getIdentity();
    if (!identity) {
        // Wait for the username form before touching the whitelist API.
        event.preventDefault();
        showIdentityModal();
        return;
    }

    if (!detail.parameters) detail.parameters = {};
    detail.parameters.userID = identity.userID;
});

document.addEventListener('htmx:afterSwap', function (event) {
    if (event.target && event.target.classList && event.target.classList.contains('media-grid')) {
        const identity = getIdentity();
        if (identity) {
            noxWhitelisted = true;
            noxAccessStatus = 'approved';
            updateProfile(identity, 'approved');
        }
        updateGameCounts();
        renderHomeWidgets();
        renderRecentGames();
    }
});

document.addEventListener('htmx:responseError', function (event) {
    if (event.detail && event.detail.xhr && event.detail.xhr.status === 403) {
        initWhitelistGate();
        return;
    }
    showGamesLoadError();
});
document.addEventListener('htmx:sendError', showGamesLoadError);

function loadStreamsGrid() {
    if (typeof streamsList === 'undefined') return;

    const defaultMeta = {
        'anime-section': { tag: 'ANIME', desc: 'Stream episodes directly inside your active browser tab.' },
        'manga-section': { tag: 'MANGA', desc: 'Read chapters and series inside your active browser tab.' },
        'video-section': { tag: 'PLAYER', desc: 'Watch embeds or load local video files seamlessly.' },
    };

    streamsList.forEach(function (item) {
        const container = document.querySelector('#' + item.section + ' .portal-grid');
        if (!container) return;

        const meta = defaultMeta[item.section] || { tag: 'PORTAL', desc: 'Open directly inside Nox.' };
        const tag = item.tag || meta.tag;
        const desc = item.desc || meta.desc;
        const initial = item.title.charAt(0).toUpperCase();

        const card = document.createElement('div');
        card.className = 'portal-card';
        card.innerHTML =
            '<div class="portal-card-top">' +
            '<div class="portal-icon-box">' +
            initial +
            '</div>' +
            '<span class="portal-tag">' +
            tag +
            '</span>' +
            '</div>' +
            '<div class="portal-card-title">' +
            item.title +
            '</div>' +
            '<div class="portal-card-desc">' +
            desc +
            '</div>' +
            '<div class="portal-card-footer">' +
            '<span>Launch Portal</span>' +
            '<span>→</span>' +
            '</div>';
        card.addEventListener('click', function () {
            launchStreamPortal(item.title, item.url);
        });
        container.appendChild(card);
    });
}

function handleGlobalSearch(query) {
    const gamesTab = document.getElementById('games-section');
    if (query.trim().length > 0 && gamesTab.style.display === 'none') {
        switchTab('games-section', document.getElementById('nav-games'));
    }
    applyGameFilters();
}

function setFavoritesMode(favState) {
    showOnlyFavorites = favState;
    const favBtn = document.getElementById('fav-filter-btn');
    const libFavBtn = document.getElementById('lib-fav-btn');
    const libAllBtn = document.getElementById('lib-all-btn');
    if (favBtn) favBtn.classList.toggle('active', showOnlyFavorites);
    if (libFavBtn) libFavBtn.classList.toggle('active', showOnlyFavorites);
    if (libAllBtn) libAllBtn.classList.toggle('active', !showOnlyFavorites);
    applyGameFilters();
}

function toggleFavoritesFilter() {
    const nextState = !showOnlyFavorites;
    const gamesTab = document.getElementById('games-section');
    if (nextState && gamesTab.style.display === 'none') {
        switchTab('games-section', document.getElementById('nav-games'));
    }
    setFavoritesMode(nextState);
}

function applyGameFilters() {
    const searchEl = document.getElementById('global-search');
    const query = (searchEl ? searchEl.value : '').toLowerCase();
    let visibleCount = 0;

    document.querySelectorAll('#games-section .game-link').forEach(function (card) {
        const title = card.querySelector('div').innerText.toLowerCase();
        const matchesSearch = title.indexOf(query) !== -1;
        const matchesFav = !showOnlyFavorites || card.classList.contains('is-bookmarked');
        const isVisible = matchesSearch && matchesFav;
        card.style.display = isVisible ? 'flex' : 'none';
        if (isVisible) visibleCount++;
    });

    const libText = document.getElementById('library-count-text');
    if (libText) {
        libText.innerText = showOnlyFavorites
            ? 'Showing ' + visibleCount + ' saved favorite' + (visibleCount === 1 ? '' : 's')
            : 'Showing ' + visibleCount + ' playable titles';
    }
}

function launchRandomGame() {
    if (!noxWhitelisted) {
        switchTab('games-section', document.getElementById('nav-games'));
        initWhitelistGate();
        return;
    }

    const links = Array.from(document.querySelectorAll('#games-section .game-link')).filter(function (a) {
        const href = a.getAttribute('href') || '';
        return href.indexOf('/gamefiles/') !== -1;
    });
    if (!links.length) return;
    const pick = links[Math.floor(Math.random() * links.length)];
    const title = pick.querySelector('div').innerText;
    const url = pick.getAttribute('href');
    const imgEl = pick.querySelector('img');
    const imgSrc = imgEl ? imgEl.getAttribute('src') : '';
    launchStreamPortal(title, url, imgSrc);
}

async function fetchTopMediaData(type) {
    // Rankings are bundled locally so the page never needs the network.
    if (!topMediaCache[type]) {
        topMediaCache[type] = fallbackTopMedia[type];
    }
    return topMediaCache[type];
}

async function switchTopMedia(type) {
    const animeBtn = document.getElementById('top-anime-btn');
    const mangaBtn = document.getElementById('top-manga-btn');
    if (animeBtn) animeBtn.classList.toggle('active', type === 'anime');
    if (mangaBtn) mangaBtn.classList.toggle('active', type === 'manga');

    const listEl = document.getElementById('top-media-list');
    if (!listEl) return;

    if (!topMediaCache[type]) {
        listEl.innerHTML = '<div class="empty-note">Loading rankings...</div>';
    }

    const items = await fetchTopMediaData(type);
    renderTopMediaList(items.slice(0, 5), type);
}

function renderTopMediaList(items, type) {
    const listEl = document.getElementById('top-media-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    items.forEach(function (item, idx) {
        const row = document.createElement('div');
        row.className = 'top-media-item';
        const thumbHtml = item.img
            ? '<img src="' + item.img + '" alt="' + item.title + '" onerror="this.style.display=\'none\'">'
            : '';
        row.innerHTML =
            '<div class="top-rank-badge">' +
            (idx + 1) +
            '</div>' +
            thumbHtml +
            '<div class="top-media-info">' +
            '<div class="top-media-title" title="' +
            item.title +
            '">' +
            item.title +
            '</div>' +
            '<div class="top-media-meta">★ ' +
            item.score +
            '  •  ' +
            item.sub +
            '</div>' +
            '</div>';
        row.addEventListener('click', function () {
            switchTab(type === 'anime' ? 'anime-section' : 'manga-section', null);
        });
        listEl.appendChild(row);
    });
}

async function loadMediaSpotlight(type, containerId) {
    const grid = document.getElementById(containerId);
    if (!grid) return;

    const items = await fetchTopMediaData(type);
    grid.innerHTML = '';

    items.forEach(function (item, idx) {
        const card = document.createElement('div');
        card.className = 'anime-poster-card';
        const initial = item.title.charAt(0).toUpperCase();
        const imgHtml = item.img
            ? '<img src="' +
              item.img +
              '" alt="' +
              item.title +
              '" loading="lazy" onerror="this.style.display=\'none\'">'
            : '';

        card.innerHTML =
            '<div class="poster-fallback-bg">' +
            initial +
            '</div>' +
            imgHtml +
            '<span class="anime-poster-rank">#' +
            (idx + 1) +
            '</span>' +
            '<span class="anime-poster-score">★ ' +
            item.score +
            '</span>' +
            '<div class="anime-poster-overlay">' +
            '<div class="anime-poster-title">' +
            item.title +
            '</div>' +
            '<div class="anime-poster-sub">' +
            item.sub +
            '</div>' +
            '</div>';
        grid.appendChild(card);
    });
}

document.addEventListener('DOMContentLoaded', function () {
    const identityForm = document.getElementById('identity-form');
    if (identityForm) identityForm.addEventListener('submit', submitIdentity);

    const identity = getIdentity();
    if (identity) {
        updateProfile(identity, 'unknown');
    } else {
        showIdentityModal();
    }

    renderHeroSelectors();
    renderHeroSlide(0);
    initGamesGrid();
    // htmx auto-loads the catalog (hx-trigger="load"). Without htmx, fall back
    // to the manual whitelist check so the grid still resolves.
    initWhitelistGate();
    loadStreamsGrid();
    renderHomeWidgets();
    renderRecentGames();

    switchTopMedia('anime');
    loadMediaSpotlight('anime', 'anime-spotlight-grid');
    setTimeout(function () {
        loadMediaSpotlight('manga', 'manga-spotlight-grid');
    }, 1200);
});
