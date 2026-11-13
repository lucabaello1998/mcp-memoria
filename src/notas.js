// Notas nuevas: la parte de "memoria" que escribe el agente.
//
// Escribir memoria es peligroso: si el modelo guarda la misma cosa diez veces,
// el índice se llena de ruido. Por eso:
//   - el texto se normaliza y se compara por hash antes de escribir;
//   - todo va a un archivo por mes, legible a mano;
//   - después de escribir se indexa solo ese archivo.

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { indexarArchivo } from "./indice.js";
import { escribirMeta, leerMeta } from "./db.js";

const MAX_TEXTO = 4000;

const huella = (texto) =>
  createHash("sha256").update(texto.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");

function fechaLocal(d = new Date()) {
  const dos = (n) => String(n).padStart(2, "0");
  return {
    dia: `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`,
    hora: `${dos(d.getHours())}:${dos(d.getMinutes())}`,
    mes: `${d.getFullYear()}-${dos(d.getMonth() + 1)}`,
  };
}

/**
 * Guarda una nota y la deja indexada.
 *
 * Devuelve `{ archivo, linea, creado }`. Si el texto ya estaba guardado
 * devuelve la cita original con `creado: false`.
 */
export async function guardarNota(db, config, { texto, etiquetas = [] } = {}) {
  if (!config.notas) {
    return { error: "Las notas están deshabilitadas en la configuración (notas: null)." };
  }
  if (typeof texto !== "string" || !texto.trim()) {
    return { error: "Falta el texto de la nota." };
  }
  const limpio = texto.trim();
  if (limpio.length > MAX_TEXTO) {
    return { error: `La nota no puede superar los ${MAX_TEXTO} caracteres.` };
  }

  const clave = `nota:${huella(limpio)}`;
  const previa = leerMeta(db, clave);
  if (previa) {
    const [archivo, linea] = previa.split("#");
    return { archivo, linea: Number(linea), creado: false, mensaje: "Esa nota ya estaba guardada." };
  }

  const { dia, hora, mes } = fechaLocal();
  const archivo = join(config.notas, `${mes}.md`);
  await mkdir(config.notas, { recursive: true });

  let contenidoPrevio = "";
  try {
    contenidoPrevio = await readFile(archivo, "utf8");
  } catch {
    contenidoPrevio = "";
  }

  const etiquetasLimpias = (Array.isArray(etiquetas) ? etiquetas : [])
    .map((e) => String(e).trim())
    .filter(Boolean)
    .slice(0, 8);

  const bloque =
    `${contenidoPrevio ? "\n" : "# Notas\n\n"}` +
    `## ${dia} ${hora}${etiquetasLimpias.length ? ` — ${etiquetasLimpias.join(", ")}` : ""}\n` +
    `${limpio}\n`;

  await appendFile(archivo, bloque, "utf8");

  const despues = contenidoPrevio + bloque;
  const linea = despues.slice(0, despues.lastIndexOf(limpio)).split("\n").length;

  escribirMeta(db, clave, `${archivo}#${linea}`);
  await indexarArchivo(db, archivo, "notas", config);

  return { archivo, linea, creado: true };
}
