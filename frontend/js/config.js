// Nox runtime configuration.
//
// The frontend is usable directly from disk (`file://`). In that case it talks
// to a locally running backend. When the backend serves the frontend itself the
// API is same-origin, so no host is needed.
(function () {
    'use strict';

    var script = document.currentScript;
    var scriptUrl = script && script.src ? script.src : '';
    var frontendRoot = '';
    if (scriptUrl) {
        // .../js/config.js -> .../
        frontendRoot = scriptUrl.replace(/\/js\/[^/?#]+(?:[?#].*)?$/, '/');
    }

    var isFile = window.location.protocol === 'file:';

    window.NOX_IS_FILE = isFile;
    window.NOX_BACKEND = isFile ? 'http://127.0.0.1:3000' : '';
    window.NOX_FRONTEND = frontendRoot;
    window.NOX_GAME_FILES = window.NOX_BACKEND + '/gamefiles/';
    window.NOX_GAME_IMAGES = window.NOX_BACKEND + '/gameimages/';
    window.NOX_MEDIA_IMAGES = frontendRoot + 'mediaimages/';

    function applyBackendUrls() {
        var gamesUrl = window.NOX_BACKEND + '/api/games';
        var grids = document.querySelectorAll('[data-games-grid]');
        for (var i = 0; i < grids.length; i++) {
            grids[i].setAttribute('hx-get', gamesUrl);
        }
    }

    // The config script runs at the end of <body>, after the grid exists, but
    // fall back to DOMContentLoaded if it is ever moved into <head>.
    applyBackendUrls();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyBackendUrls);
    }
})();
