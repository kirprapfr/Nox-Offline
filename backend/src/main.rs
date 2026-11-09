use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as UrlPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

const STATUS_APPROVED: &str = "approved";
const STATUS_PENDING: &str = "pending";
const STATUS_DENIED: &str = "denied";

#[derive(Clone)]
struct Game {
    title: String,
    /// Path relative to the backend, e.g. `/gamefiles/foo.html`.
    url: String,
    /// Path relative to the backend, e.g. `/gameimages/foo.png`.
    image: String,
}

#[derive(Serialize)]
struct GameJson {
    title: String,
    url: String,
    image: String,
}

#[derive(Clone)]
struct AppState {
    games: Vec<Game>,
    backend_dir: PathBuf,
    frontend_dir: PathBuf,
    db_path: PathBuf,
}

#[derive(Deserialize)]
struct GamesQuery {
    #[serde(rename = "userID")]
    user_id: Option<String>,
}

#[derive(Deserialize)]
struct WhitelistQuery {
    #[serde(rename = "userID")]
    user_id: Option<String>,
}

#[derive(Deserialize)]
struct WhitelistRequestPayload {
    #[serde(rename = "userID")]
    user_id: String,
    #[serde(default)]
    username: String,
}

#[derive(Serialize)]
struct WhitelistStatus {
    #[serde(rename = "userID")]
    user_id: String,
    username: String,
    status: String,
    whitelisted: bool,
}

#[tokio::main]
async fn main() {
    let backend_dir = std::env::var("NOX_BACKEND_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    let db_path = std::env::var("NOX_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| backend_dir.join("nox.db"));

    let command = std::env::args().nth(1);
    match command.as_deref() {
        Some("whitelist") => {
            let args: Vec<String> = std::env::args().skip(2).collect();
            if let Err(error) = run_whitelist_cli(&db_path, &args) {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
        Some("help") | Some("--help") | Some("-h") => {
            print_usage();
            return;
        }
        Some(command) => {
            eprintln!("Unknown command: {command}\n");
            print_usage();
            std::process::exit(1);
        }
        None => {}
    }

    if let Err(error) = init_db(&db_path) {
        eprintln!("{error}");
        std::process::exit(1);
    }

    let frontend_dir = std::env::var("NOX_FRONTEND_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            backend_dir
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("frontend")
        });

    let games = match load_games(&backend_dir) {
        Ok(games) => games,
        Err(error) => {
            eprintln!("Failed to load games: {error}");
            std::process::exit(1);
        }
    };

    println!("Loaded {} games", games.len());
    println!("Whitelist database: {}", db_path.display());

    let state = AppState {
        games,
        backend_dir,
        frontend_dir,
        db_path,
    };

    let app = Router::new()
        .route("/api/games", get(games_fragment))
        .route("/api/games.json", get(games_json))
        .route("/api/whitelist/status", get(whitelist_status))
        .route("/api/whitelist/request", post(whitelist_request))
        .route("/gamefiles/{*path}", get(serve_gamefile))
        .route("/gameimages/{*path}", get(serve_gameimage))
        .fallback(serve_frontend)
        .layer(middleware::from_fn(cors))
        .with_state(state);

    let address = std::env::var("NOX_ADDR").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let listener = match tokio::net::TcpListener::bind(&address).await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Failed to bind {address}: {error}");
            std::process::exit(1);
        }
    };

    println!("Nox backend running at http://{address}");

    if let Err(error) = axum::serve(listener, app).await {
        eprintln!("Server error: {error}");
    }
}

fn print_usage() {
    println!(
        "Nox backend\n\n\
Usage:\n  \
cargo run                                              Start the server\n  \
cargo run -- whitelist list                            List every user\n  \
cargo run -- whitelist pending                         List pending access requests\n  \
cargo run -- whitelist approved                        List approved users\n  \
cargo run -- whitelist show <userID>                   Show one user\n  \
cargo run -- whitelist add <userID> [username]         Add or approve a user\n  \
cargo run -- whitelist approve <userID>                Approve a pending request\n  \
cargo run -- whitelist deny <userID>                   Deny a pending request\n  \
cargo run -- whitelist remove <userID>                 Remove a user\n\n\
Set NOX_DB to use a different whitelist database file."
    );
}

fn init_db(db_path: &Path) -> Result<(), String> {
    open_db(db_path).map(|_| ())
}

fn open_db(db_path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(db_path)
        .map_err(|error| format!("could not open {}: {error}", db_path.display()))?;
    let _ = connection.busy_timeout(Duration::from_secs(5));
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                username TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS users_status_idx ON users (status);",
        )
        .map_err(|error| format!("could not initialize whitelist database: {error}"))?;
    Ok(connection)
}

fn read_whitelist_status(
    connection: &Connection,
    user_id: &str,
) -> Result<WhitelistStatus, String> {
    let row = connection
        .query_row(
            "SELECT username, status FROM users WHERE user_id = ?1",
            params![user_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("could not read whitelist: {error}"))?;

    let (username, status) = row.unwrap_or_else(|| (String::new(), "unknown".to_string()));

    Ok(WhitelistStatus {
        user_id: user_id.to_string(),
        username,
        whitelisted: status == STATUS_APPROVED,
        status,
    })
}

fn read_whitelist_status_from_path(
    db_path: &Path,
    user_id: &str,
) -> Result<WhitelistStatus, String> {
    let connection = open_db(db_path)?;
    read_whitelist_status(&connection, user_id)
}

fn record_whitelist_request(
    db_path: &Path,
    user_id: &str,
    username: &str,
) -> Result<WhitelistStatus, String> {
    let connection = open_db(db_path)?;
    connection
        .execute(
            "INSERT OR IGNORE INTO users (user_id, username, status) VALUES (?1, ?2, 'pending')",
            params![user_id, username],
        )
        .map_err(|error| format!("could not create whitelist request: {error}"))?;
    connection
        .execute(
            "UPDATE users SET username = ?2, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?1",
            params![user_id, username],
        )
        .map_err(|error| format!("could not update whitelist request: {error}"))?;

    read_whitelist_status(&connection, user_id)
}

fn is_whitelisted(db_path: &Path, user_id: &str) -> Result<bool, String> {
    let connection = open_db(db_path)?;
    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM users WHERE user_id = ?1",
            params![user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("could not read whitelist: {error}"))?;

    Ok(status.as_deref() == Some(STATUS_APPROVED))
}

fn require_whitelisted(state: &AppState, user_id: Option<&str>) -> Result<String, Box<Response>> {
    let Some(user_id) = user_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(Box::new(access_denied(None)));
    };

    match is_whitelisted(&state.db_path, user_id) {
        Ok(true) => Ok(user_id.to_string()),
        Ok(false) => Err(Box::new(access_denied(Some(user_id)))),
        Err(error) => {
            eprintln!("Whitelist check failed: {error}");
            Err(Box::new(
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Could not check whitelist",
                )
                    .into_response(),
            ))
        }
    }
}

fn access_denied(user_id: Option<&str>) -> Response {
    let body = match user_id {
        Some(user_id) => format!(
            "<div class=\"empty-note\">Access denied. Your user ID is <strong>{}</strong>. \
             Ask an admin to run <code>cargo run -- whitelist approve {}</code>.</div>",
            escape_html(user_id),
            escape_html(user_id)
        ),
        None => {
            "<div class=\"empty-note\">Access denied. No user ID was provided.</div>".to_string()
        }
    };

    (StatusCode::FORBIDDEN, Html(body)).into_response()
}

fn load_games(backend_dir: &Path) -> Result<Vec<Game>, String> {
    let games_path = backend_dir.join("games.json");
    let contents = std::fs::read_to_string(&games_path)
        .map_err(|error| format!("could not read {}: {error}", games_path.display()))?;
    let titles: Vec<String> = serde_json::from_str(&contents)
        .map_err(|error| format!("could not parse {}: {error}", games_path.display()))?;

    let image_index = build_image_index(&backend_dir.join("gameimages"));
    let minecraft_fallback = [
        "minecraft.webp",
        "minecraftindev.webp",
        "minecraftpocketedition.png",
    ]
    .into_iter()
    .find(|file| backend_dir.join("gameimages").join(file).is_file())
    .map(str::to_string);

    let games = titles
        .into_iter()
        .map(|title| {
            let slug = title.to_lowercase().replace(' ', "");
            let image = image_index
                .get(&alphanumeric_key(&title))
                .cloned()
                .or_else(|| {
                    if title.starts_with("Minecraft") {
                        minecraft_fallback.clone()
                    } else {
                        None
                    }
                })
                .map(|file| format!("/gameimages/{file}"))
                .unwrap_or_default();

            Game {
                url: format!("/gamefiles/{slug}.html"),
                title,
                image,
            }
        })
        .collect();

    Ok(games)
}

/// Images use a normalized filename (letters and digits only), while game files
/// keep punctuation. Prefer the nicest image format when several files match.
fn build_image_index(image_dir: &Path) -> HashMap<String, String> {
    let mut index: HashMap<String, String> = HashMap::new();

    let Ok(entries) = std::fs::read_dir(image_dir) else {
        return index;
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let path = Path::new(&file_name);
        let Some(extension) = path.extension().and_then(|ext| ext.to_str()) else {
            continue;
        };
        let extension = extension.to_lowercase();
        if !matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "webp" | "gif" | "avif" | "jfif" | "svg" | "bmp"
        ) {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let key = alphanumeric_key(stem);

        match index.get(&key) {
            Some(existing) if image_rank(existing) <= image_rank(&file_name) => {}
            _ => {
                index.insert(key, file_name);
            }
        }
    }

    index
}

fn image_rank(file_name: &str) -> u8 {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "png" => 0,
        "jpg" | "jpeg" => 1,
        "webp" => 2,
        "gif" => 3,
        "avif" => 4,
        "svg" => 5,
        "bmp" => 6,
        _ => 7,
    }
}

fn alphanumeric_key(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect()
}

/// Build the game file path for a whitelisted user. The user ID is part of the
/// path so every relative asset requested by the game inherits the same
/// whitelist check.
fn tokenized_game_path(user_id: &str, game: &Game) -> String {
    let file = game.url.trim_start_matches("/gamefiles/");
    format!("/gamefiles/{}/{}", encode_path_segment(user_id), file)
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());

    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }

    encoded
}

fn render_games_html(games: &[Game], origin: &str, user_id: &str) -> String {
    let mut html = String::with_capacity(games.len() * 220);

    for game in games {
        let title = escape_html(&game.title);
        html.push_str("<a class=\"game-link\" href=\"");
        html.push_str(&escape_html(&format!(
            "{origin}{}",
            tokenized_game_path(user_id, game)
        )));
        html.push_str("\" data-title=\"");
        html.push_str(&title);
        html.push_str("\">\n");

        if !game.image.is_empty() {
            html.push_str("    <img loading=\"lazy\" src=\"");
            html.push_str(&escape_html(&format!("{origin}{}", game.image)));
            html.push_str("\" alt=\"");
            html.push_str(&title);
            html.push_str("\">\n");
        }

        html.push_str("    <div>");
        html.push_str(&title);
        html.push_str("</div>\n</a>\n");
    }

    html
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

async fn games_fragment(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<GamesQuery>,
) -> Response {
    let user_id = match require_whitelisted(&state, query.user_id.as_deref()) {
        Ok(user_id) => user_id,
        Err(response) => return *response,
    };

    let origin = request_origin(&headers);
    Html(render_games_html(&state.games, &origin, &user_id)).into_response()
}

async fn games_json(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<GamesQuery>,
) -> Response {
    let user_id = match require_whitelisted(&state, query.user_id.as_deref()) {
        Ok(user_id) => user_id,
        Err(_) => {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({ "error": "not whitelisted" })),
            )
                .into_response();
        }
    };

    let origin = request_origin(&headers);
    let games = state
        .games
        .iter()
        .map(|game| GameJson {
            title: game.title.clone(),
            url: format!("{origin}{}", tokenized_game_path(&user_id, game)),
            image: if game.image.is_empty() {
                String::new()
            } else {
                format!("{origin}{}", game.image)
            },
        })
        .collect::<Vec<_>>();

    Json(games).into_response()
}

async fn whitelist_status(
    State(state): State<AppState>,
    Query(query): Query<WhitelistQuery>,
) -> Response {
    let Some(user_id) = query
        .user_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return (StatusCode::BAD_REQUEST, "Missing userID").into_response();
    };

    match read_whitelist_status_from_path(&state.db_path, user_id) {
        Ok(status) => Json(status).into_response(),
        Err(error) => {
            eprintln!("Could not read whitelist: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not read whitelist",
            )
                .into_response()
        }
    }
}

async fn whitelist_request(
    State(state): State<AppState>,
    Json(payload): Json<WhitelistRequestPayload>,
) -> Response {
    let user_id = payload.user_id.trim();
    if user_id.is_empty() || user_id.len() > 128 || user_id.contains('/') || user_id.contains('\\')
    {
        return (StatusCode::BAD_REQUEST, "Invalid userID").into_response();
    }

    let username: String = payload.username.trim().chars().take(64).collect();

    match record_whitelist_request(&state.db_path, user_id, &username) {
        Ok(status) => Json(status).into_response(),
        Err(error) => {
            eprintln!("Could not record whitelist request: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not record whitelist request",
            )
                .into_response()
        }
    }
}

/// Build an absolute backend origin from the request so the same HTML works both
/// when served by the backend and when the frontend is opened via `file://`.
fn request_origin(headers: &HeaderMap) -> String {
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1:3000");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .filter(|value| *value == "http" || *value == "https")
        .unwrap_or("http");

    format!("{scheme}://{host}")
}

/// Allow `file://` pages (sent as `Origin: null`) to call the backend with htmx.
async fn cors(request: Request, next: Next) -> Response {
    let is_preflight = request.method() == Method::OPTIONS;

    let mut response = if is_preflight {
        Response::new(Body::empty())
    } else {
        next.run(request).await
    };

    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
    // Chrome may require this for `file://` pages reaching a local server.
    headers.insert(
        "access-control-allow-private-network",
        HeaderValue::from_static("true"),
    );

    response
}

async fn serve_gamefile(State(state): State<AppState>, UrlPath(path): UrlPath<String>) -> Response {
    // Game URLs look like /gamefiles/<userID>/<file>. Requiring the user ID in
    // the path means relative assets requested by the game keep the same
    // whitelist check, and direct guesses without an approved ID are rejected.
    let mut segments = path.splitn(2, '/');
    let user_id = segments.next().unwrap_or("").trim();
    let Some(file) = segments
        .next()
        .map(|file| file.trim_start_matches('/'))
        .filter(|file| !file.is_empty())
    else {
        return access_denied(None);
    };

    if user_id.is_empty() {
        return access_denied(None);
    }

    match is_whitelisted(&state.db_path, user_id) {
        Ok(true) => {}
        Ok(false) => return access_denied(Some(user_id)),
        Err(error) => {
            eprintln!("Whitelist check failed: {error}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not check whitelist",
            )
                .into_response();
        }
    }

    serve_file(&state.backend_dir.join("gamefiles"), file).await
}

async fn serve_gameimage(
    State(state): State<AppState>,
    UrlPath(path): UrlPath<String>,
) -> Response {
    serve_file(&state.backend_dir.join("gameimages"), &path).await
}

async fn serve_frontend(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    serve_file(&state.frontend_dir, path).await
}

async fn serve_file(root: &Path, relative_path: &str) -> Response {
    let relative_path = relative_path.trim_start_matches('/');
    let relative = Path::new(relative_path);

    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return (StatusCode::BAD_REQUEST, "Invalid path").into_response();
    }

    let full_path = root.join(relative);

    match tokio::fs::read(&full_path).await {
        Ok(contents) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&full_path))
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from(contents))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Err(_) => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "wasm" => "application/wasm",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

fn validate_user_id(user_id: &str) -> Result<(), String> {
    if user_id.trim().is_empty() {
        return Err("User ID cannot be empty".to_string());
    }
    if user_id.len() > 128 {
        return Err("User ID is too long (maximum 128 characters)".to_string());
    }
    if user_id.contains('/') || user_id.contains('\\') {
        return Err("User ID cannot contain path separators".to_string());
    }
    Ok(())
}

fn run_whitelist_cli(db_path: &Path, args: &[String]) -> Result<(), String> {
    let Some(action) = args.first().map(String::as_str) else {
        print_usage();
        return Ok(());
    };

    let connection = open_db(db_path)?;

    match action {
        "list" => list_users(&connection, None),
        "pending" => list_users(&connection, Some(STATUS_PENDING)),
        "approved" => list_users(&connection, Some(STATUS_APPROVED)),
        "denied" => list_users(&connection, Some(STATUS_DENIED)),
        "show" => {
            let user_id = args
                .get(1)
                .ok_or_else(|| "Usage: cargo run -- whitelist show <userID>".to_string())?;
            validate_user_id(user_id)?;
            show_user(&connection, user_id)
        }
        "add" => {
            let user_id = args.get(1).ok_or_else(|| {
                "Usage: cargo run -- whitelist add <userID> [username]".to_string()
            })?;
            validate_user_id(user_id)?;
            let username = args
                .get(2..)
                .map(|parts| parts.join(" "))
                .unwrap_or_default();
            add_user(&connection, user_id, &username)
        }
        "approve" => {
            let user_id = args
                .get(1)
                .ok_or_else(|| "Usage: cargo run -- whitelist approve <userID>".to_string())?;
            validate_user_id(user_id)?;
            set_user_status(&connection, user_id, STATUS_APPROVED, "Approved")
        }
        "deny" => {
            let user_id = args
                .get(1)
                .ok_or_else(|| "Usage: cargo run -- whitelist deny <userID>".to_string())?;
            validate_user_id(user_id)?;
            set_user_status(&connection, user_id, STATUS_DENIED, "Denied")
        }
        "remove" => {
            let user_id = args
                .get(1)
                .ok_or_else(|| "Usage: cargo run -- whitelist remove <userID>".to_string())?;
            validate_user_id(user_id)?;
            remove_user(&connection, user_id)
        }
        other => {
            print_usage();
            Err(format!("Unknown whitelist command: {other}"))
        }
    }
}

fn list_users(connection: &Connection, status_filter: Option<&str>) -> Result<(), String> {
    let sql = if status_filter.is_some() {
        "SELECT user_id, username, status, created_at FROM users WHERE status = ?1 ORDER BY created_at DESC, user_id"
    } else {
        "SELECT user_id, username, status, created_at FROM users ORDER BY created_at DESC, user_id"
    };

    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("could not prepare whitelist query: {error}"))?;

    let mut rows = match status_filter {
        Some(status) => statement.query(params![status]),
        None => statement.query([]),
    }
    .map_err(|error| format!("could not query whitelist: {error}"))?;

    println!(
        "{:<42} {:<20} {:<10} CREATED",
        "USER ID", "USERNAME", "STATUS"
    );
    println!("{}", "-".repeat(92));

    let mut count = 0usize;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("could not read whitelist row: {error}"))?
    {
        let user_id: String = row.get(0).map_err(|error| error.to_string())?;
        let username: String = row.get(1).map_err(|error| error.to_string())?;
        let status: String = row.get(2).map_err(|error| error.to_string())?;
        let created_at: String = row.get(3).map_err(|error| error.to_string())?;

        println!(
            "{:<42} {:<20} {:<10} {}",
            user_id,
            if username.is_empty() { "-" } else { &username },
            status,
            created_at
        );
        count += 1;
    }

    if count == 0 {
        println!("No whitelist entries found.");
    } else {
        println!("\n{count} entr{}.", if count == 1 { "y" } else { "ies" });
    }

    Ok(())
}

fn show_user(connection: &Connection, user_id: &str) -> Result<(), String> {
    let row = connection
        .query_row(
            "SELECT user_id, username, status, created_at, updated_at FROM users WHERE user_id = ?1",
            params![user_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("could not read whitelist: {error}"))?;

    let Some((user_id, username, status, created_at, updated_at)) = row else {
        return Err(format!("No whitelist entry found for {user_id}"));
    };

    println!("User ID:    {user_id}");
    println!(
        "Username:   {}",
        if username.is_empty() { "-" } else { &username }
    );
    println!("Status:     {status}");
    println!("Created:    {created_at}");
    println!("Updated:    {updated_at}");
    Ok(())
}

fn add_user(connection: &Connection, user_id: &str, username: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO users (user_id, username, status) VALUES (?1, ?2, 'approved')
             ON CONFLICT(user_id) DO UPDATE SET
                username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE users.username END,
                status = 'approved',
                updated_at = CURRENT_TIMESTAMP",
            params![user_id, username],
        )
        .map_err(|error| format!("could not whitelist {user_id}: {error}"))?;

    if username.is_empty() {
        println!("Whitelisted {user_id}.");
    } else {
        println!("Whitelisted {user_id} ({username}).");
    }
    Ok(())
}

fn set_user_status(
    connection: &Connection,
    user_id: &str,
    status: &str,
    action: &str,
) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE users SET status = ?2, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?1",
            params![user_id, status],
        )
        .map_err(|error| format!("could not update {user_id}: {error}"))?;

    if changed == 0 {
        return Err(format!(
            "No whitelist request found for {user_id}. Use `cargo run -- whitelist add {user_id}` to add a new user."
        ));
    }

    println!("{action} {user_id}.");
    Ok(())
}

fn remove_user(connection: &Connection, user_id: &str) -> Result<(), String> {
    let changed = connection
        .execute("DELETE FROM users WHERE user_id = ?1", params![user_id])
        .map_err(|error| format!("could not remove {user_id}: {error}"))?;

    if changed == 0 {
        return Err(format!("No whitelist entry found for {user_id}"));
    }

    println!("Removed {user_id} from the whitelist.");
    Ok(())
}
