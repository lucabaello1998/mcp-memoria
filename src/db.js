// Capa SQLite. Usa `node:sqlite` (Node 22.5+), así que no hay dependencias que
// instalar ni binarios nativos que compilar: el motor viene con Node y trae FTS5.
//
// Esquema: una fila por archivo en `fuentes` (para el indexado incremental) y
// una por fragmento en `fragmentos`. `busqueda` es la tabla FTS5 con el mismo
// rowid que `fragmentos`, así el resultado se une sin ambigüedad.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ESQUEMA = `
CREATE TABLE IF NOT EXISTS fuentes (
  id        INTEGER PRIMARY KEY,
  ruta      TEXT NOT NULL UNIQUE,
  etiqueta  TEXT NOT NULL DEFAULT '',
  mtime     INTEGER NOT NULL,
  bytes     INTEGER NOT NULL,
  hash      TEXT NOT NULL,
  indexado  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fragmentos (
  id           INTEGER PRIMARY KEY,
  fuente_id    INTEGER NOT NULL REFERENCES fuentes(id) ON DELETE CASCADE,
  titulo       TEXT NOT NULL DEFAULT '',
  encabezado   TEXT NOT NULL DEFAULT '',
  linea_inicio INTEGER NOT NULL,
  linea_fin    INTEGER NOT NULL,
  texto        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS fragmentos_fuente ON fragmentos(fuente_id);

CREATE VIRTUAL TABLE IF NOT EXISTS busqueda USING fts5(
  titulo,
  encabezado,
  texto,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vectores (
  fragmento_id INTEGER PRIMARY KEY REFERENCES fragmentos(id) ON DELETE CASCADE,
  modelo       TEXT NOT NULL,
  dimension    INTEGER NOT NULL,
  vetor        BLOB NOT NULL
);
`;

/** Abre (y crea si hace falta) la base. */
export function abrirBase(ruta) {
  mkdirSync(dirname(ruta), { recursive: true });
  const db = new DatabaseSync(ruta);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(ESQUEMA);
  return db;
}

export function leerMeta(db, clave) {
  const fila = db.prepare("SELECT valor FROM meta WHERE clave = ?").get(clave);
  return fila ? fila.valor : null;
}

export function escribirMeta(db, clave, valor) {
  db.prepare(
    "INSERT INTO meta (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor"
  ).run(clave, String(valor));
}

export function estadisticas(db) {
  const fuentes = db.prepare("SELECT COUNT(*) AS n FROM fuentes").get().n;
  const fragmentos = db.prepare("SELECT COUNT(*) AS n FROM fragmentos").get().n;
  const bytes = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM fuentes").get().n;
  const conVectores = db.prepare("SELECT COUNT(*) AS n FROM vectores").get().n;
  const porEtiqueta = db
    .prepare("SELECT etiqueta, COUNT(*) AS n FROM fuentes GROUP BY etiqueta ORDER BY n DESC")
    .all();
  return {
    fuentes: Number(fuentes),
    fragmentos: Number(fragmentos),
    bytes: Number(bytes),
    vectores: Number(conVectores),
    modeloEmbeddings: leerMeta(db, "modelo_embeddings"),
    porEtiqueta: porEtiqueta.map((f) => ({ etiqueta: f.etiqueta, archivos: Number(f.n) })),
    ultimoIndexado: leerMeta(db, "ultimo_indexado"),
  };
}
