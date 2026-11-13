// Normalización y armado de la consulta FTS5.
//
// El índice usa `unicode61 remove_diacritics 2`, así que "liquidación" y
// "liquidacion" caen en el mismo token. Igual normalizamos acá para que la
// consulta y el índice hablen el mismo idioma, y para no depender de que el
// tokenizer de SQLite haga magia con mayúsculas o acentos raros.

/** Palabras que no aportan señal y sí ruido en español. */
export const PALABRAS_VACIAS = new Set([
  "a", "al", "algo", "algunas", "algunos", "ante", "antes", "como", "con",
  "contra", "cual", "cuando", "de", "del", "desde", "donde", "dos", "el",
  "ella", "ellas", "ellos", "en", "entre", "era", "es", "esa", "ese", "eso",
  "esta", "estas", "este", "esto", "estos", "fue", "ha", "hacia", "hasta",
  "hay", "la", "las", "le", "les", "lo", "los", "me", "mi", "mis", "mucho",
  "muy", "mas", "más", "no", "nos", "o", "os", "otra", "otro", "para", "pero",
  "poco", "por", "porque", "que", "qué", "quien", "se", "sea", "ser", "si",
  "sí", "sin", "sobre", "son", "su", "sus", "te", "tiene", "todo", "todos",
  "tu", "tus", "un", "una", "uno", "unos", "y", "ya", "yo",
]);

/** Quita acentos y pasa a minúsculas: "Liquidación" -> "liquidacion". */
export function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Tokens alfanuméricos de dos o más caracteres. */
export function tokenizar(texto) {
  return normalizar(texto)
    .split(/[^a-z0-9ñ]+/)
    .filter((token) => token.length >= 2);
}

/** Tokens útiles de una consulta: sin vacías y sin repetidos. */
export function terminosDe(consulta) {
  const vistos = new Set();
  const terminos = [];
  for (const token of tokenizar(consulta)) {
    if (PALABRAS_VACIAS.has(token) || vistos.has(token)) continue;
    vistos.add(token);
    terminos.push(token);
  }
  return terminos;
}

/**
 * Arma la expresión MATCH de FTS5.
 *
 * - `y`: todos los términos (más preciso).
 * - `o`: cualquiera (más recall).
 *
 * Cada término va entre comillas y con `*` para que funcione como prefijo:
 * "liq"* encuentra "liquidacion". Los tokens ya están saneados a [a-z0-9ñ],
 * así que no hay forma de inyectar sintaxis de FTS5.
 */
export function consultaFts(consulta, { operador = "y" } = {}) {
  const terminos = terminosDe(consulta);
  if (terminos.length === 0) return null;
  const unidos = terminos.map((t) => `"${t}"*`).join(operador === "o" ? " OR " : " AND ");
  return terminos.length === 1 ? unidos : `(${unidos})`;
}

/** Posición (en el texto normalizado) de la primera coincidencia, o -1. */
export function posicionDeCoincidencia(texto, consulta) {
  const normalizado = normalizar(texto);
  let posicion = -1;
  for (const termino of terminosDe(consulta)) {
    const encontrado = normalizado.indexOf(termino);
    if (encontrado !== -1 && (posicion === -1 || encontrado < posicion)) posicion = encontrado;
  }
  return posicion;
}

/**
 * Recorta un fragmento alrededor de la primera coincidencia, para que el modelo
 * lea lo relevante y no 1200 caracteres de relleno.
 */
export function recortar(texto, consulta, { antes = 160, despues = 240 } = {}) {
  const plano = String(texto ?? "");
  if (!plano) return "";

  const posicion = posicionDeCoincidencia(plano, consulta);
  if (posicion === -1) {
    const corte = plano.slice(0, antes + despues).replace(/\s+/g, " ").trim();
    return plano.length > antes + despues ? `${corte}…` : corte;
  }

  const desde = Math.max(0, posicion - antes);
  const hasta = Math.min(plano.length, posicion + despues);
  const recorte = plano.slice(desde, hasta).replace(/\s+/g, " ").trim();
  return `${desde > 0 ? "…" : ""}${recorte}${hasta < plano.length ? "…" : ""}`;
}

/** Cantidad de líneas antes de una posición: para citar la línea exacta. */
export function lineasAntes(texto, posicion) {
  let cuenta = 0;
  for (let i = 0; i < posicion && i < texto.length; i += 1) {
    if (texto[i] === "\n") cuenta += 1;
  }
  return cuenta;
}
