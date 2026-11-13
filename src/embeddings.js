// Embeddings opcionales para búsqueda híbrida.
//
// El índice funciona sin esto: BM25 solo. Si hay un proveedor configurado
// (Ollama por defecto), se guardan vectores por fragmento y la búsqueda combina
// los dos rankings con RRF. La idea es no atar el proyecto a una API paga: el
// mismo código habla con Ollama local o con cualquier endpoint compatible.
//
// Se eligió RRF (Reciprocal Rank Fusion) y no una suma de puntajes porque BM25
// y coseno viven en escalas distintas: fusionar por posición no requiere
// normalizar nada ni calibrar pesos a mano.

const LOTE = 32;
const TIMEOUT_MS = 120_000;

/** Proveedor de embeddings contra la API de Ollama. */
export function crearProveedorEmbeddings(config, { fetchImpl = fetch } = {}) {
  if (!config?.embeddings) return null;

  const url = (config.embeddings.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
  const modelo = config.embeddings.modelo ?? "nomic-embed-text";
  const lotes = Number.isInteger(config.embeddings.lote) ? Math.min(Math.max(config.embeddings.lote, 1), 256) : LOTE;

  const embed = async (textos) => {
    const salida = [];
    for (let i = 0; i < textos.length; i += lotes) {
      const trozo = textos.slice(i, i + lotes);
      const respuesta = await fetchImpl(`${url}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelo, input: trozo }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!respuesta.ok) {
        throw new Error(`El proveedor de embeddings respondió ${respuesta.status}`);
      }
      const datos = await respuesta.json();
      if (!Array.isArray(datos.embeddings) || datos.embeddings.length !== trozo.length) {
        throw new Error("El proveedor de embeddings devolvió una cantidad distinta de vectores");
      }
      for (const vector of datos.embeddings) salida.push(normalizarVetor(vector));
    }
    return salida;
  };

  return { url, modelo, embed };
}

/** Normaliza a norma 1 para que el coseno sea un producto punto. */
export function normalizarVetor(vector) {
  const salida = Float32Array.from(vector);
  let suma = 0;
  for (let i = 0; i < salida.length; i += 1) suma += salida[i] * salida[i];
  const norma = Math.sqrt(suma);
  if (norma === 0) return salida;
  for (let i = 0; i < salida.length; i += 1) salida[i] /= norma;
  return salida;
}

export function aBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function deBuffer(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

/** Producto punto de dos vectores normalizados = coseno. */
export function coseno(a, b) {
  if (a.length !== b.length) return 0;
  let suma = 0;
  for (let i = 0; i < a.length; i += 1) suma += a[i] * b[i];
  return suma;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Recibe listas ordenadas de ids y devuelve un ranking único. `k` amortigua el
 * peso de las primeras posiciones: con k=60, el 1º de una lista suma 1/61 y el
 * 10º 1/70, así una coincidencia en ambas listas siempre gana.
 */
export function fusionRRF(listas, { k = 60, limite = 20 } = {}) {
  const puntajes = new Map();
  for (const lista of listas) {
    lista.forEach((id, posicion) => {
      puntajes.set(id, (puntajes.get(id) ?? 0) + 1 / (k + posicion + 1));
    });
  }
  return [...puntajes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limite)
    .map(([id, puntaje]) => ({ id, puntaje: Number(puntaje.toFixed(6)) }));
}
