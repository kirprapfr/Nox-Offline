# Nox-Offline

## Running

The backend serves both the frontend and the game library:

```bash
cd backend
cargo run
```

Then open <http://127.0.0.1:3000>.

You can also open `frontend/index.html` directly from disk (`file://`). The page
runs entirely from local files and talks to the backend at
`http://127.0.0.1:3000` for the game catalog, game files, and game images. Start
the backend first, then open the file. The backend URL can be changed in
`frontend/js/config.js` if you run it on a different port.

The games library is loaded with htmx from `GET /api/games`, which returns an
HTML fragment containing only titles and thumbnail URLs. `GET /api/games.json`
returns the same catalog as JSON. When a game is launched, the library grid and
its thumbnails are removed from the DOM so only the running game stays loaded;
the grid is fetched again when the player is closed.

Environment variables:

- `NOX_ADDR` — address to bind (default `127.0.0.1:3000`)
- `NOX_BACKEND_DIR` — directory containing `games.json`, `gamefiles/`, and `gameimages/`
- `NOX_FRONTEND_DIR` — directory containing `index.html`
- `NOX_DB` — whitelist SQLite database (default `backend/nox.db`)

## Whitelisting

The game catalog is invite-only. On first launch the frontend asks for a
username, creates a user ID, stores it in `localStorage` (with a cookie
fallback), and sends an access request to the backend. The request is saved in
`backend/nox.db` with `pending` status. Until an admin approves the user ID the
library shows an access-pending panel with the exact terminal command to run.

Manage the whitelist from the backend directory:

```bash
cd backend

# See every user and their status
cargo run -- whitelist list

# See users waiting for approval
cargo run -- whitelist pending

# Approve a pending request
cargo run -- whitelist approve <userID>

# Add a user directly, or approve an existing one (optional display name)
cargo run -- whitelist add <userID> [username]

# Deny a pending request, remove a user, or inspect one entry
cargo run -- whitelist deny <userID>
cargo run -- whitelist remove <userID>
cargo run -- whitelist show <userID>
```

`GET /api/games` and `GET /api/games.json` require an approved `userID` query
parameter. The status and request endpoints used by the frontend are
`GET /api/whitelist/status` and `POST /api/whitelist/request`.

Game files are enforced by the backend as well. The catalog returns URLs shaped
like `/gamefiles/<userID>/<game>.html`; every request for a game file (and the
relative assets it loads) is checked against the whitelist before anything is
served. Requesting a game file without an approved ID returns `403`, so bypassing
the frontend gate does not expose the library. This also works when
`frontend/index.html` is opened directly with `file://`, because the frontend
always calls the backend's absolute URL.

## Formatting

Prettier is configured for the frontend HTML/CSS/JS, JSON, and Markdown:

```bash
npm install
npm run format        # write formatting fixes
npm run format:check  # verify formatting without changing files
```

Game files, thumbnails, vendored htmx, and build output are excluded in
`.prettierignore`.

## Release edition

Steps needed before releasing

1. Change Development backend URL in html to your domain
2. zip frontend
3. rename to whatever you want
4. release
