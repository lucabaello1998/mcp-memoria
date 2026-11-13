// Evaluación: convertir texto en números sin criterios ocultos.
//
// La regla es deliberadamente simple: una respuesta acierta si contiene todas
// las palabras clave esperadas (sin acentos ni mayúsculas). No hay jurado, ni
// LLM evaluando a otro LLM, ni "parece razonable". Se puede discutir el criterio,
// pero no es una caja negra.

import { normalizar } from "../src/tokenizer.js";

/** Normaliza separadores decimales: "0,77" y "0.77" son el mismo número. */
function normalizarNumeros(texto) {
  return texto.replace(/(\d),(\d)/g, "$1.$2");
}

/**
 * ¿La respuesta contiene todas las claves esperadas?
 *
 * Cada clave puede traer alternativas separadas por `|`: "chicos|pequenos"
 * acierta con cualquiera de las dos. Es la forma barata de no castigar a un
 * modelo por elegir un sinónimo.
 */
export function puntuarRespuesta(texto, esperado = []) {
  const normalizado = normalizarNumeros(normalizar(texto ?? ""));
  const faltan = esperado.filter((clave) => {
    const alternativas = String(clave)
      .split("|")
      .map((parte) => normalizarNumeros(normalizar(parte)))
      .filter(Boolean);
    return !alternativas.some((alternativa) => normalizado.includes(alternativa));
  });
  return {
    ok: faltan.length === 0,
    aciertos: esperado.length - faltan.length,
    total: esperado.length,
    faltan,
  };
}

/** El modelo dijo que no sabe: cuenta como no acertar, pero se reporta aparte. */
export function dijoNoSabe(texto) {
  const n = normalizar(texto ?? "");
  return [
    "no tengo informacion",
    "no hay informacion",
    "no se menciona",
    "no aparece en el contexto",
    "no puedo responder",
    "no cuento con informacion",
  ].some((frase) => n.includes(frase));
}

/** ¿Algún resultado apunta a alguno de los archivos donde está el dato? */
export function acertoFuente(resultados, fuentes = []) {
  return posicionFuente(resultados, fuentes) !== null;
}

/** Posición (1-based) del primer resultado que apunta a una fuente esperada. */
export function posicionFuente(resultados, fuentes = []) {
  const indice = resultados.findIndex((resultado) =>
    fuentes.some((fuente) => normalizar(resultado.archivo).includes(normalizar(fuente)))
  );
  return indice === -1 ? null : indice + 1;
}

/** Mean Reciprocal Rank: 1/posición, 0 si no apareció. */
export function mrr(posiciones) {
  if (posiciones.length === 0) return 0;
  const suma = posiciones.reduce((total, posicion) => total + (posicion ? 1 / posicion : 0), 0);
  return Number((suma / posiciones.length).toFixed(4));
}

/** Tabla markdown simple, alineada a la izquierda. */
export function formatearTabla(columnas, filas) {
  const anchos = columnas.map((columna, i) =>
    Math.max(columna.length, ...filas.map((fila) => String(fila[i] ?? "").length))
  );
  const linea = (valores) =>
    `| ${valores.map((valor, i) => String(valor ?? "").padEnd(anchos[i])).join(" | ")} |`;
  return [
    linea(columnas),
    `| ${anchos.map((ancho) => "-".repeat(ancho)).join(" | ")} |`,
    ...filas.map(linea),
  ].join("\n");
}

/** Promedio legible. */
export function promedio(numeros) {
  if (numeros.length === 0) return 0;
  return Number((numeros.reduce((a, b) => a + b, 0) / numeros.length).toFixed(2));
}
