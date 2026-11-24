-- Base de dados D1 do site (comentários, registos, visitas e configurações)
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, created TEXT, ip TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (h TEXT PRIMARY KEY, uid TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, page TEXT, uid TEXT, t TEXT, ip TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, vid TEXT, ip TEXT, dev TEXT, uid TEXT, tag TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS visits_t ON visits(t);
CREATE INDEX IF NOT EXISTS visits_vid ON visits(vid);
CREATE INDEX IF NOT EXISTS comments_page ON comments(page);
CREATE INDEX IF NOT EXISTS tokens_uid ON tokens(uid);
