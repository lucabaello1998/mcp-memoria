// Búsqueda y citas.
//
// Dos modos:
//   - `bm25`: léxico puro (FTS5). Siempre disponible, sin red.
//   - `hibrido`: BM25 + coseno sobre embeddings, fusionados con RRF.
//
// FTS5 devuelve un bm25 (más negativo = mejor). Encima de eso aplicamos dos
// ajustes chicos y explicables: peso por etiqueta (lo que escribí como memoria
// vale más que un README suelto) y un plus por recencia (lo de este mes importa
// más que lo de hace un año). Nada de magia: cada número está acá a la vista.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { consultaFts, lineasAntes, posicionDeCoincidencia, recortar } from "./tokenizer.js";
import { coseno, deBuffer, fusionRRF } from "./embeddings.js";

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

const SQL_FILA = `
SELECT f.id, s.ruta, s.etiqueta, s.mtime, f.titulo, f.encabezado,
       f.linea_inicio, f.linea_fin, f.texto
FROM fragmentos f JOIN fuentes s ON s.id = f.fuente_id
WHERE f.id = ?`;

/** Convierte una fila de SQLite en el resultado que consume el cliente. */
function filaAResultado(fila, consulta, puntaje) {
  const posicion = posicionDeCoincidencia(fila.texto, consulta);
  const linea = posicion === -1
    ? Number(fila.linea_inicio)
    : Number(fila.linea_inicio) + lineasAntes(fila.texto, posicion);
  return {
    id: Number(fila.id),
    archivo: fila.ruta,
    linea,
    linea_fin: Number(fila.linea_fin),
    titulo: fila.titulo || "",
    encabezado: fila.encabezado || "",
    etiqueta: fila.etiqueta || "",
    fragmento: recortar(fila.texto, consulta),
    puntaje: Number(Number(puntaje).toFixed(4)),
  };
}

/** Dos fragmentos por archivo como máximo, para no tapar otras fuentes. */
function diversificar(resultados, limite) {
  const porArchivo = new Map();
  const elegidos = [];
  for (const fila of resultados) {
    const usados = porArchivo.get(fila.archivo) ?? 0;
    if (usados >= 2) continue;
    porArchivo.set(fila.archivo, usados + 1);
    elegidos.push(fila);
    if (elegidos.length >= limite) break;
  }
  return elegidos;
}

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
    .map((fila) =>
      filaAResultado(
        fila,
        consulta,
        -Number(fila.bm) * pesoEtiqueta(fila.etiqueta) + plusRecencia(Number(fila.mtime))
      )
    )
    .sort((a, b) => b.puntaje - a.puntaje);

  return diversificar(puntuadas, limite);
}

// ---------------------------------------------------------------------------
// Búsqueda híbrida
// ---------------------------------------------------------------------------

// Cache de vectores: el servidor MCP vive horas y escanear 24 MB por consulta
// sería un desperdicio. Se invalida sola cuando cambia la cantidad de vectores.
let cache = { firma: null, ids: null, vectores: null, dimension: 0 };

function cargarVectores(db, modelo) {
  const fila = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(MAX(fragmento_id), 0) AS m FROM vectores WHERE modelo = ?")
    .get(modelo);
  const firma = `${modelo}|${fila.n}|${fila.m}`;
  if (cache.firma === firma) return cache;

  const filas = db.prepare("SELECT fragmento_id, vetor FROM vectores WHERE modelo = ?").all(modelo);
  const ids = new Int32Array(filas.length);
  const vectores = new Array(filas.length);
  let dimension = 0;
  filas.forEach((f, i) => {
    const vector = deBuffer(f.vetor);
    ids[i] = Number(f.fragmento_id);
    vectores[i] = vector;
    dimension = vector.length;
  });
  cache = { firma, ids, vectores, dimension };
  return cache;
}

/**
 * Busca combinando BM25 y similitud semántica.
 *
 * Cada modo propone sus mejores candidatos y RRF los mezcla por posición: un
 * fragmento que aparece bien rankeado en los dos gana, y uno que solo aparece en
 * uno igual entra. Sin calibrar escalas.
 */
export async function buscarHibrido(
  db,
  consulta,
  { limite = 5, etiqueta = null, proveedor, k = 60, pesoLexico = 2, estrategia = "rrf", similitudMinima = 0.6 } = {}
) {
  if (typeof consulta !== "string" || !consulta.trim()) return [];
  if (!proveedor) return buscar(db, consulta, { limite, etiqueta });

  const candidatos = Math.max(limite * 8, 40);
  const lexicos = buscar(db, consulta, { limite: candidatos, etiqueta });

  // Modo respaldo: si el léxico ya llenó la página, no se toca. Los vectores
  // entran solo cuando BM25 se queda corto.
  if (estrategia === "respaldo" && lexicos.length >= limite) return lexicos;

  let semanticos = [];
  try {
    const [vectorConsulta] = await proveedor.embed([consulta]);
    const { ids, vectores, dimension } = cargarVectores(db, proveedor.modelo);
    if (dimension > 0 && vectorConsulta.length === dimension) {
      const puntajes = [];
      for (let i = 0; i < ids.length; i += 1) {
        puntajes.push({ id: ids[i], similitud: coseno(vectorConsulta, vectores[i]) });
      }
      puntajes.sort((a, b) => b.similitud - a.similitud);
      semanticos = puntajes.slice(0, candidatos).filter((p) => p.similitud > similitudMinima);
    }
  } catch {
    // Si el proveedor falla, la búsqueda sigue siendo léxica: nunca romper.
    return lexicos;
  }

  if (semanticos.length === 0) return lexicos;

  // `pesoLexico` repite la lista léxica en la fusión: así una coincidencia
  // exacta de palabras pesa más que una similitud vaga, sin calibrar escalas.
  const listas = [lexicos.map((r) => r.id)];
  for (let i = 1; i < Math.max(1, pesoLexico); i += 1) listas.push(lexicos.map((r) => r.id));
  listas.push(semanticos.map((p) => p.id));

  const fusion = fusionRRF(listas, { k, limite: candidatos });

  const porId = new Map(lexicos.map((r) => [r.id, r]));
  const similitudPorId = new Map(semanticos.map((p) => [p.id, p.similitud]));
  const consultarFila = db.prepare(SQL_FILA);

  const resultados = [];
  for (const { id, puntaje } of fusion) {
    const conocido = porId.get(id);
    if (conocido) {
      resultados.push({ ...conocido, puntaje, similitud: Number((similitudPorId.get(id) ?? 0).toFixed(4)) });
      continue;
    }
    const fila = consultarFila.get(id);
    if (!fila) continue;
    if (etiqueta && fila.etiqueta !== etiqueta) continue;
    resultados.push({
      ...filaAResultado(fila, consulta, puntaje),
      similitud: Number((similitudPorId.get(id) ?? 0).toFixed(4)),
    });
  }

  return diversificar(resultados, limite);
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
  if (inicio > lineas.length) {
    return { archivo: fuente.ruta, etiqueta: fuente.etiqueta, desde: inicio, hasta: fin, total: lineas.length, texto: "" };
  }

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
