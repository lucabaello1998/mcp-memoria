// Indexado incremental.
//
// La regla es simple: si el hash del archivo no cambió, no se toca nada. Así
// reindexar 2000 archivos cuesta milisegundos y se puede hacer al arrancar el
// servidor sin que el cliente espere.
//
// Los embeddings (si hay proveedor) se calculan después de cerrar la
// transacción del texto: mantener el lock de escritura mientras se espera a la
// red sería pedirle a SQLite que sostenga la puerta abierta varios minutos.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { dividirEnFragmentos } from "./chunker.js";
import { escribirMeta } from "./db.js";
import { aBuffer } from "./embeddings.js";

const hash = (contenido) => createHash("sha256").update(contenido).digest("hex");

/** Archivos indexables de una fuente (recorre subcarpetas, saltea basura). */
export async function listarArchivos(fuente, config) {
  const permitidas = new Set(fuente.extensiones ?? config.extensiones);
  const encontrados = [];

  const info = await stat(fuente.ruta).catch(() => null);
  if (!info) return encontrados;
  if (info.isFile()) {
    if (permitidas.has(extname(fuente.ruta).toLowerCase())) encontrados.push(fuente.ruta);
    return encontrados;
  }

  const recorrer = async (directorio, nombreDirectorio = "") => {
    let entradas;
    try {
      entradas = await readdir(directorio, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      if (entrada.name.startsWith(".")) continue;
      const ruta = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        if (config.ignorar.has(entrada.name)) continue;
        // `test/fixtures` es texto inventado para tests: si se indexa, contamina
        // las búsquedas reales con resultados de mentira.
        if (entrada.name === "fixtures" && (nombreDirectorio === "test" || nombreDirectorio === "tests")) continue;
        await recorrer(ruta, entrada.name);
      } else if (entrada.isFile() && permitidas.has(extname(entrada.name).toLowerCase())) {
        encontrados.push(ruta);
      }
    }
  };

  await recorrer(fuente.ruta);
  return encontrados;
}

function borrarFragmentos(db, fuenteId) {
  const ids = db.prepare("SELECT id FROM fragmentos WHERE fuente_id = ?").all(fuenteId);
  const borrarFts = db.prepare("DELETE FROM busqueda WHERE rowid = ?");
  for (const fila of ids) borrarFts.run(Number(fila.id));
  // Los vectores caen por ON DELETE CASCADE (PRAGMA foreign_keys = ON).
  db.prepare("DELETE FROM fragmentos WHERE fuente_id = ?").run(fuenteId);
}

/** Inserta fragmentos y devuelve sus ids, en el mismo orden. */
function guardarFragmentos(db, fuenteId, fragmentos) {
  const insertar = db.prepare(
    "INSERT INTO fragmentos (fuente_id, titulo, encabezado, linea_inicio, linea_fin, texto) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insertarFts = db.prepare(
    "INSERT INTO busqueda (rowid, titulo, encabezado, texto) VALUES (?, ?, ?, ?)"
  );
  const ids = [];
  for (const fragmento of fragmentos) {
    const { lastInsertRowid } = insertar.run(
      fuenteId,
      fragmento.titulo,
      fragmento.encabezado,
      fragmento.linea_inicio,
      fragmento.linea_fin,
      fragmento.texto
    );
    const id = Number(lastInsertRowid);
    insertarFts.run(id, fragmento.titulo, fragmento.encabezado, fragmento.texto);
    ids.push(id);
  }
  return ids;
}

/**
 * Calcula y guarda vectores para los fragmentos que todavía no tienen.
 *
 * Corre después de cerrar la transacción del texto. Sirve para dos casos:
 * indexar por primera vez con embeddings y migrar un índice que ya existía
 * solo con BM25 (sin reindexar todo el texto).
 */
export async function vectorizarFaltantes(db, proveedor, { lote = 32, log = () => {} } = {}) {
  if (!proveedor) return 0;
  const faltantes = db
    .prepare(
      `SELECT f.id, f.titulo, f.encabezado, f.texto
       FROM fragmentos f
       LEFT JOIN vectores v ON v.fragmento_id = f.id AND v.modelo = ?
       WHERE v.fragmento_id IS NULL`
    )
    .all(proveedor.modelo);
  if (faltantes.length === 0) return 0;

  log(`vectores: ${faltantes.length} fragmentos sin vector`);
  const insertar = db.prepare(
    "INSERT OR REPLACE INTO vectores (fragmento_id, modelo, dimension, vetor) VALUES (?, ?, ?, ?)"
  );
  let total = 0;

  for (let i = 0; i < faltantes.length; i += lote) {
    const trozo = faltantes.slice(i, i + lote);
    const textos = trozo.map((f) => `${f.titulo}\n${f.encabezado}\n${f.texto}`);
    const vectores = await proveedor.embed(textos);

    db.exec("BEGIN");
    try {
      vectores.forEach((vector, j) => {
        insertar.run(Number(trozo[j].id), proveedor.modelo, vector.length, aBuffer(vector));
        total += 1;
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (total % (lote * 10) === 0) log(`vectores: ${total}/${faltantes.length}`);
  }

  escribirMeta(db, "modelo_embeddings", proveedor.modelo);
  return total;
}

/**
 * Calcula y guarda vectores para un conjunto de fragmentos.
 *
 * El texto que se embebe incluye título y encabezado: un fragmento suelto de
 * "### Estado" no dice nada, con la ruta de secciones sí.
 */
export async function vectorizar(db, proveedor, ids, fragmentos, { lote = 32 } = {}) {
  if (!proveedor || ids.length === 0) return 0;
  const insertar = db.prepare(
    "INSERT OR REPLACE INTO vectores (fragmento_id, modelo, dimension, vetor) VALUES (?, ?, ?, ?)"
  );
  let total = 0;

  for (let i = 0; i < ids.length; i += lote) {
    const trozo = fragmentos.slice(i, i + lote);
    const textos = trozo.map((f) => `${f.titulo}\n${f.encabezado}\n${f.texto}`);
    const vectores = await proveedor.embed(textos);

    db.exec("BEGIN");
    try {
      vectores.forEach((vector, j) => {
        insertar.run(ids[i + j], proveedor.modelo, vector.length, aBuffer(vector));
        total += 1;
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  escribirMeta(db, "modelo_embeddings", proveedor.modelo);
  return total;
}

/**
 * Indexa un solo archivo sin tocar el resto del índice.
 *
 * Se usa cuando `guardar_nota` escribe una nota nueva: no tiene sentido
 * reindexar 2000 archivos para agregar 3 líneas.
 */
export async function indexarArchivo(db, ruta, etiqueta, config, { proveedor = null } = {}) {
  const info = await stat(ruta).catch(() => null);
  if (!info || !info.isFile()) return { indexado: false, fragmentos: 0, vectores: 0 };

  const contenido = await readFile(ruta, "utf8");
  const firma = hash(contenido);
  const previa = db.prepare("SELECT id, hash FROM fuentes WHERE ruta = ?").get(ruta);

  if (previa && previa.hash === firma) return { indexado: false, fragmentos: 0, vectores: 0 };

  const fragmentos = dividirEnFragmentos(contenido, {
    maximo: config.maximoFragmento,
    tituloPorDefecto: ruta.split(/[\\/]/).pop() ?? "",
  });

  let ids = [];
  db.exec("BEGIN");
  try {
    if (previa) {
      borrarFragmentos(db, previa.id);
      db.prepare(
        "UPDATE fuentes SET etiqueta = ?, mtime = ?, bytes = ?, hash = ?, indexado = ? WHERE id = ?"
      ).run(etiqueta, Math.floor(info.mtimeMs), info.size, firma, Date.now(), previa.id);
      ids = guardarFragmentos(db, previa.id, fragmentos);
    } else {
      const { lastInsertRowid } = db
        .prepare("INSERT INTO fuentes (ruta, etiqueta, mtime, bytes, hash, indexado) VALUES (?, ?, ?, ?, ?, ?)")
        .run(ruta, etiqueta, Math.floor(info.mtimeMs), info.size, firma, Date.now());
      ids = guardarFragmentos(db, Number(lastInsertRowid), fragmentos);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const vectores = await vectorizar(db, proveedor, ids, fragmentos);
  return { indexado: true, fragmentos: fragmentos.length, vectores };
}

/**
 * Indexa todas las fuentes configuradas.
 *
 * Devuelve contadores reales (no estimaciones) para poder mostrarlos por CLI.
 */
export async function indexar(db, config, { log = () => {}, proveedor = null } = {}) {
  const resumen = {
    archivos: 0,
    nuevos: 0,
    actualizados: 0,
    iguales: 0,
    borrados: 0,
    fragmentos: 0,
    vectores: 0,
    errores: [],
  };

  const previas = new Map(
    db.prepare("SELECT id, ruta, etiqueta, hash FROM fuentes").all().map((f) => [f.ruta, f])
  );
  const vistas = new Set();

  db.exec("BEGIN");
  try {
    for (const fuente of config.fuentes) {
      const archivos = await listarArchivos(fuente, config);
      log(`[${fuente.etiqueta}] ${archivos.length} archivos en ${fuente.ruta}`);

      for (const ruta of archivos) {
        const info = await stat(ruta).catch(() => null);
        if (!info || !info.isFile()) continue;

        // Un archivo gigante no es memoria, es un dump: se ignora y se limpia si
        // alguna vez estuvo indexado.
        if (info.size > config.maxBytes) {
          const previa = previas.get(ruta);
          if (previa) {
            borrarFragmentos(db, previa.id);
            db.prepare("DELETE FROM fuentes WHERE id = ?").run(previa.id);
            resumen.borrados += 1;
          }
          continue;
        }

        let contenido;
        try {
          contenido = await readFile(ruta, "utf8");
        } catch (error) {
          resumen.errores.push({ ruta, error: error.message });
          continue;
        }

        // Un archivo con bytes nulos es binario con extensión de texto: afuera.
        if (contenido.includes("\u0000")) continue;

        vistas.add(ruta);
        resumen.archivos += 1;
        const firma = hash(contenido);
        const previa = previas.get(ruta);

        if (previa && previa.hash === firma) {
          resumen.iguales += 1;
          if (previa.etiqueta !== fuente.etiqueta) {
            db.prepare("UPDATE fuentes SET etiqueta = ? WHERE id = ?").run(fuente.etiqueta, previa.id);
          }
          continue;
        }

        const fragmentos = dividirEnFragmentos(contenido, {
          maximo: config.maximoFragmento,
          tituloPorDefecto: ruta.split(/[\\/]/).pop() ?? "",
        });

        if (previa) {
          borrarFragmentos(db, previa.id);
          db.prepare(
            "UPDATE fuentes SET etiqueta = ?, mtime = ?, bytes = ?, hash = ?, indexado = ? WHERE id = ?"
          ).run(fuente.etiqueta, Math.floor(info.mtimeMs), info.size, firma, Date.now(), previa.id);
          guardarFragmentos(db, previa.id, fragmentos);
          resumen.actualizados += 1;
        } else {
          const { lastInsertRowid } = db
            .prepare(
              "INSERT INTO fuentes (ruta, etiqueta, mtime, bytes, hash, indexado) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .run(ruta, fuente.etiqueta, Math.floor(info.mtimeMs), info.size, firma, Date.now());
          guardarFragmentos(db, Number(lastInsertRowid), fragmentos);
          resumen.nuevos += 1;
        }
        resumen.fragmentos += fragmentos.length;
      }
    }

    // Archivos que ya no están: si desaparecieron del disco, salen del índice.
    for (const [ruta, previa] of previas) {
      if (vistas.has(ruta)) continue;
      borrarFragmentos(db, previa.id);
      db.prepare("DELETE FROM fuentes WHERE id = ?").run(previa.id);
      resumen.borrados += 1;
    }

    escribirMeta(db, "ultimo_indexado", new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // Fuera de la transacción: acá se espera a la red.
  if (proveedor) {
    try {
      resumen.vectores = await vectorizarFaltantes(db, proveedor, { log });
    } catch (error) {
      resumen.errores.push({ ruta: "embeddings", error: error.message });
    }
  }

  return resumen;
}
