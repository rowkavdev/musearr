// Run with PGlite available via NODE_PATH (scratch install, no production dependency).
const { PGlite } = require('@electric-sql/pglite')
;(async () => {
const fs = require('fs')
const db = new PGlite()
await db.exec(`CREATE TABLE artists(id uuid primary key, name text); CREATE TABLE albums(id uuid primary key, artist_id uuid, title text); CREATE TABLE tracks(id uuid primary key, album_id uuid, title text, plex_rating_key text); CREATE TABLE playlist_generation_items(id uuid primary key, generation_id text, artist_name text, album_title text, track_title text, track_id uuid, plex_rating_key text, state text, matched_at timestamptz, updated_at timestamptz);
INSERT INTO artists VALUES ('00000000-0000-4000-8000-000000000001','Radiohead');
INSERT INTO albums VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','OK Computer'), ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','Greatest Hits');
INSERT INTO tracks VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','Karma Police','OKC'), ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000003','Karma Police','HITS');
INSERT INTO playlist_generation_items(id,generation_id,artist_name,album_title,track_title,state) VALUES ('00000000-0000-4000-8000-000000000006','gen','Radiohead','OK Computer','Karma Police','pending'), ('00000000-0000-4000-8000-000000000007','gen','Radiohead',NULL,'Karma Police','pending'), ('00000000-0000-4000-8000-000000000008','gen','Radiohead','Missing','Karma Police','pending');`)
const source=fs.readFileSync(process.argv[2] || require('node:path').join(__dirname, '../../packages/db/src/playlist-generation.ts'),'utf8').split('export async function matchGenerationItemsInLibrary')[1]
const sql=source.split('await database`')[1].split('`')[0].replaceAll('${generationId}',"'gen'")
await db.exec(sql)
const { rows }=await db.query('SELECT album_title, plex_rating_key, state FROM playlist_generation_items ORDER BY id')
console.log(rows)
if (rows[0].plex_rating_key !== 'OKC' || rows[1].plex_rating_key !== null || rows[2].plex_rating_key !== null) process.exit(1)

await db.close()
})().catch(e=>{console.error(e);process.exit(1)})
