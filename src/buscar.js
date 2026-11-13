// Búsqueda y citas.
//
// FTS5 devuelve un bm25 (más negativo = mejor). Encima de eso aplicamos dos
// ajustes chicos y explicables: peso por etiqueta (lo que escribí como memoria
// vale más que un README suelto) y un plus por recencia (lo de este mes importa
// más que lo de hace un año). Nada de magia: cada número está acá a la vista.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { consultaFts, lineasAntes, posicionDeCoincidencia, recortar } from "./tokenizer.js";

const PESO_ETIQUETA = {
  memoria: 1.25,
  notas: 1.2,
  repos: 1,
  general: 1,
};

const pesoEtiqueta = (etiqueta) => PESO_ETIQUETA[etiqueta] ?? 1;

/** Plus por recencia: 0.15 para lo de hoy, ~0.01 para lo de hace un año. */
function plusRecencia(mtimeMs) {
  const dias = Math.max(0, (Date.now() - mtimeMs) / 86_400_000);
  return 0.15 / (1 + dias / 30);
}

const SQL_BASE = `
SELECT f.id, s.ruta, s.etiqueta, s.mtime, f.titulo, f.encabezado,
       f.linea_inicio, f.linea_fin, f.texto,
       bm25(busqueda, 8.0, 4.0, 1.0) AS bm
FROM busqueda
JOIN fragmentos f ON f.id = busqueda.rowid
JOIN fuentes s ON s.id = f.fuente_id
WHERE busqueda MATCH ?`;

/**
 * Busca en el índice y devuelve fragmentos con cita `archivo:línea`.
 *
 * Primero prueba con todos los términos (AND); si no hay nada, relaja a
 * cualquiera (OR). Así "sueldos SAC" no devuelve vacío solo porque un documento
 * no dice "SAC".
 */
export function buscar(db, consulta, { limite = 5, etiqueta = null } = {}) {
  if (typeof consulta !== "string" || !consulta.trim()) return [];

  const candidatas = [consultaFts(consulta, { operador: "y" }), consultaFts(consulta, { operador: "o" })].filter(
    Boolean
  );

  let filas = [];
  for (const expresion of candidatas) {
    const sql = etiqueta ? `${SQL_BASE} AND s.etiqueta = ? ORDER BY bm LIMIT ?` : `${SQL_BASE} ORDER BY bm LIMIT ?`;
    const parametros = etiqueta ? [expresion, etiqueta, limite * 6] : [expresion, limite * 6];
    try {
      filas = db.prepare(sql).all(...parametros);
    } catch {
      // Una consulta que FTS5 no entiende no debe romper la herramienta.
      filas = [];
    }
    if (filas.length > 0) break;
  }

  const puntuadas = filas
    .map((fila) => {
      const posicion = posicionDeCoincidencia(fila.texto, consulta);
      const linea = posicion === -1
        ? Number(fila.linea_inicio)
        : Number(fila.linea_inicio) + lineasAntes(fila.texto, posicion);
      return {
        archivo: fila.ruta,
        linea,
        linea_fin: Number(fila.linea_fin),
        titulo: fila.titulo || "",
        encabezado: fila.encabezado || "",
        etiqueta: fila.etiqueta || "",
        fragmento: recortar(fila.texto, consulta),
        puntaje: Number(((-Number(fila.bm)) * pesoEtiqueta(fila.etiqueta) + plusRecencia(Number(fila.mtime))).toFixed(4)),
      };
    })
    .sort((a, b) => b.puntaje - a.puntaje);

  // Dos fragmentos por archivo como máximo: si no, un documento largo se come
  // todos los resultados y el modelo no ve que hay otras fuentes.
  const porArchivo = new Map();
  const elegidos = [];
  for (const fila of puntuadas) {
    const usados = porArchivo.get(fila.archivo) ?? 0;
    if (usados >= 2) continue;
    porArchivo.set(fila.archivo, usados + 1);
    elegidos.push(fila);
    if (elegidos.length >= limite) break;
  }
  return elegidos;
}

/** Devuelve la fila de `fuentes` para una ruta indexada, o null. */
export function fuenteDe(db, ruta) {
  if (typeof ruta !== "string" || !ruta.trim()) return null;
  const exacta = db.prepare("SELECT id, ruta, etiqueta FROM fuentes WHERE ruta = ?").get(ruta);
  if (exacta) return exacta;
  // En Windows la misma ruta puede venir con otra capitalización o con `/`.
  const objetivo = resolve(ruta).toLowerCase();
  for (const fila of db.prepare("SELECT id, ruta, etiqueta FROM fuentes").all()) {
    if (resolve(fila.ruta).toLowerCase() === objetivo) return fila;
  }
  return null;
}

/**
 * Lee líneas exactas de un archivo indexado.
 *
 * Solo se puede leer lo que está en el índice: la lista de rutas sale de la
 * base, no del argumento del cliente, así que no hay forma de pedir
 * `../../Windows/win.ini`.
 */
export async function leerFragmento(db, ruta, { desde = 1, hasta = 80 } = {}) {
  const fuente = fuenteDe(db, ruta);
  if (!fuente) return null;

  const inicio = Math.max(1, Math.min(Number(desde) || 1, 1_000_000));
  const fin = Math.max(inicio, Math.min(Number(hasta) || inicio + 79, inicio + 199));

  let contenido;
  try {
    contenido = await readFile(fuente.ruta, "utf8");
  } catch {
    return null;
  }

  const lineas = contenido.split(/\r?\n/);
  if (inicio > lineas.length) return { archivo: fuente.ruta, etiqueta: fuente.etiqueta, desde: inicio, hasta: fin, total: lineas.length, texto: "" };

  return {
    archivo: fuente.ruta,
    etiqueta: fuente.etiqueta,
    desde: inicio,
    hasta: Math.min(fin, lineas.length),
    total: lineas.length,
    texto: lineas.slice(inicio - 1, fin).join("\n"),
  };
}

/** Resumen de lo indexado, para `listar_fuentes`. */
export function resumenFuentes(db) {
  return db
    .prepare(
      `SELECT s.etiqueta, s.ruta, s.bytes, s.indexado, COUNT(f.id) AS fragmentos
       FROM fuentes s LEFT JOIN fragmentos f ON f.fuente_id = s.id
       GROUP BY s.id ORDER BY s.etiqueta, s.ruta`
    )
    .all()
    .map((fila) => ({
      etiqueta: fila.etiqueta,
      archivo: fila.ruta,
      kb: Math.round(Number(fila.bytes) / 102.4) / 10,
      fragmentos: Number(fila.fragmentos),
      indexado: new Date(Number(fila.indexado)).toISOString(),
    }));
}
