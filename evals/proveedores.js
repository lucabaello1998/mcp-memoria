// Proveedores de modelo para las evals.
//
// Tres tipos, misma interfaz: `charlar(mensajes) -> { texto, tokensEntrada,
// tokensSalida, ms }`.
//
//   - ollama:  local, gratis, sin API key (el que se puede correr siempre).
//   - openai:  cualquier endpoint compatible (/v1/chat/completions): OpenAI,
//              Groq, OpenRouter, DeepSeek, LM Studio.
//   - falso:   determinista, para tests y para CI sin red.
//
// El precio no se adivina: sale de la tabla de abajo y se puede pisar por
// configuración. Un modelo que no está en la tabla se reporta con costo null,
// nunca con un número inventado.

export const PRECIOS_POR_MILLON = {
  "gpt-4o": { entrada: 2.5, salida: 10 },
  "gpt-4o-mini": { entrada: 0.15, salida: 0.6 },
  "gpt-4.1": { entrada: 2, salida: 8 },
  "gpt-4.1-mini": { entrada: 0.4, salida: 1.6 },
  "claude-3-5-haiku": { entrada: 0.8, salida: 4 },
  "claude-sonnet-4": { entrada: 3, salida: 15 },
  "llama-3.1-8b-instant": { entrada: 0.05, salida: 0.08 },
  "llama-3.3-70b-versatile": { entrada: 0.59, salida: 0.79 },
};

/** Costo en dólares de una corrida, o null si no hay precio conocido. */
export function costoEstimado(modelo, tokensEntrada, tokensSalida) {
  const precio = PRECIOS_POR_MILLON[modelo];
  if (!precio) return null;
  return Number(((tokensEntrada * precio.entrada + tokensSalida * precio.salida) / 1_000_000).toFixed(6));
}

/**
 * Crea un proveedor a partir de "tipo:modelo", por ejemplo
 * "ollama:qwen3.5:4b" u "openai:gpt-4o-mini".
 */
export function crearProveedor(especificacion, { fetchImpl = fetch, env = process.env, precioCustom = {} } = {}) {
  const separador = especificacion.indexOf(":");
  const tipo = separador === -1 ? "ollama" : especificacion.slice(0, separador);
  const modelo = separador === -1 ? especificacion : especificacion.slice(separador + 1);

  if (tipo === "falso") {
    return {
      tipo,
      modelo,
      async charlar(mensajes) {
        const ultimo = mensajes.at(-1)?.content ?? "";
        return {
          texto: `Respuesta falsa para: ${ultimo.slice(0, 40)}`,
          tokensEntrada: Math.ceil(ultimo.length / 4),
          tokensSalida: 8,
          ms: 1,
        };
      },
    };
  }

  if (tipo === "ollama") {
    const url = (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    return {
      tipo,
      modelo,
      async charlar(mensajes) {
        const inicio = Date.now();
        const respuesta = await fetchImpl(`${url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: modelo,
            messages: mensajes,
            stream: false,
            think: false,
            options: { temperature: 0, num_predict: 400 },
          }),
          signal: AbortSignal.timeout(300_000),
        });
        if (!respuesta.ok) throw new Error(`Ollama respondió ${respuesta.status}`);
        const datos = await respuesta.json();
        return {
          texto: datos.message?.content ?? "",
          tokensEntrada: Number(datos.prompt_eval_count ?? 0),
          tokensSalida: Number(datos.eval_count ?? 0),
          ms: Date.now() - inicio,
        };
      },
    };
  }

  if (tipo === "openai") {
    const base = (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const apiKey = env.OPENAI_API_KEY ?? "";
    if (!apiKey) {
      throw new Error("Falta OPENAI_API_KEY para usar un modelo de OpenAI (o compatible).");
    }
    return {
      tipo,
      modelo,
      async charlar(mensajes) {
        const inicio = Date.now();
        const respuesta = await fetchImpl(`${base}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: modelo, messages: mensajes, temperature: 0 }),
          signal: AbortSignal.timeout(120_000),
        });
        if (!respuesta.ok) throw new Error(`El proveedor respondió ${respuesta.status}`);
        const datos = await respuesta.json();
        return {
          texto: datos.choices?.[0]?.message?.content ?? "",
          tokensEntrada: Number(datos.usage?.prompt_tokens ?? 0),
          tokensSalida: Number(datos.usage?.completion_tokens ?? 0),
          ms: Date.now() - inicio,
        };
      },
    };
  }

  throw new Error(`Tipo de proveedor desconocido: ${tipo}`);
}

/** Precio efectivo: lo que venga por configuración pisa la tabla. */
export function precioDe(modelo, precios = PRECIOS_POR_MILLON) {
  return precios[modelo] ?? PRECIOS_POR_MILLON[modelo] ?? null;
}
