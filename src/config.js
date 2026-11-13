// Configuración de mcp-memoria.
//
// Todo se resuelve una sola vez al arrancar: rutas de las fuentes a indexar,
// dónde vive la base y dónde se guardan las notas. Si no hay archivo de
// configuración se usan valores razonables para que `npx mcp-memoria` funcione
// sin preparar nada.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const EXTENSIONES_POR_DEFECTO = [
  ".md",
  ".markdown",
  ".txt",
  ".rst",
  ".org",
];

const CARPETAS_IGNORADAS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "bin",
  "obj",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
]);

/** Expande `~` y resuelve rutas relativas contra el directorio de la config. */
export function expandir(ruta, base = process.cwd()) {
  if (typeof ruta !== "string" || !ruta.trim()) return null;
  let valor = ruta.trim();
  if (valor === "~") valor = homedir();
  else if (valor.startsWith("~/") || valor.startsWith("~\\")) {
    valor = join(homedir(), valor.slice(2));
  }
  return isAbsolute(valor) ? valor : resolve(base, valor);
}

/** Directorio de datos del usuario, según la plataforma. */
export function directorioDatos() {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "mcp-memoria");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "mcp-memoria");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "mcp-memoria");
}

function normalizarFuente(fuente, base) {
  if (typeof fuente === "string") {
    return { ruta: expandir(fuente, base), etiqueta: "general" };
  }
  if (!fuente || typeof fuente !== "object") return null;
  const ruta = expandir(fuente.ruta, base);
  if (!ruta) return null;
  return {
    ruta,
    etiqueta: typeof fuente.etiqueta === "string" && fuente.etiqueta.trim()
      ? fuente.etiqueta.trim()
      : "general",
    extensiones: Array.isArray(fuente.extensiones) && fuente.extensiones.length
      ? fuente.extensiones.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`))
      : null,
  };
}

/**
 * Carga la configuración. Precedencia: `MEMORIA_CONFIG` > `./memoria.config.json`
 * > valores por defecto. `MEMORIA_DB` pisa la ruta de la base.
 */
export function cargarConfig({ ruta, env = process.env, cwd = process.cwd() } = {}) {
  const archivo = ruta || env.MEMORIA_CONFIG || join(cwd, "memoria.config.json");
  let crudo = {};
  let base = cwd;

  if (existsSync(archivo)) {
    base = dirname(resolve(archivo));
    try {
      crudo = JSON.parse(readFileSync(archivo, "utf8"));
    } catch (error) {
      throw new Error(`No se pudo leer ${archivo}: ${error.message}`);
    }
  } else if (ruta || env.MEMORIA_CONFIG) {
    throw new Error(`No existe el archivo de configuración: ${archivo}`);
  }

  const fuentes = (Array.isArray(crudo.fuentes) ? crudo.fuentes : [])
    .map((f) => normalizarFuente(f, base))
    .filter(Boolean);

  // Sin configuración explícita: la memoria de OpenCode/Claude si existe y,
  // si no, el directorio actual. Nunca se indexa el home entero por accidente.
  if (fuentes.length === 0) {
    const memoriaOpencode = join(homedir(), ".config", "opencode", "memory");
    fuentes.push(
      existsSync(memoriaOpencode)
        ? { ruta: memoriaOpencode, etiqueta: "memoria", extensiones: null }
        : { ruta: cwd, etiqueta: "general", extensiones: null }
    );
  }

  const baseDatos = env.MEMORIA_DB
    ? expandir(env.MEMORIA_DB, cwd)
    : crudo.base
      ? expandir(crudo.base, base)
      : join(directorioDatos(), "memoria.db");

  const notas = crudo.notas === null
    ? null
    : expandir(crudo.notas ?? join(dirname(baseDatos), "notas"), base);

  // Embeddings opcionales: sin esta sección el índice es BM25 puro.
  let embeddings = null;
  if (crudo.embeddings && typeof crudo.embeddings === "object" && crudo.embeddings !== null) {
    embeddings = {
      url: typeof crudo.embeddings.url === "string" && crudo.embeddings.url.trim()
        ? crudo.embeddings.url.trim()
        : "http://127.0.0.1:11434",
      modelo: typeof crudo.embeddings.modelo === "string" && crudo.embeddings.modelo.trim()
        ? crudo.embeddings.modelo.trim()
        : "nomic-embed-text",
      lote: Number.isInteger(crudo.embeddings.lote) ? crudo.embeddings.lote : 32,
    };
  }

  return {
    archivo,
    base: baseDatos,
    notas,
    fuentes,
    embeddings,
    extensiones: Array.isArray(crudo.extensiones) && crudo.extensiones.length
      ? crudo.extensiones.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`))
      : EXTENSIONES_POR_DEFECTO,
    ignorar: new Set([
      ...CARPETAS_IGNORADAS,
      ...(Array.isArray(crudo.ignorar) ? crudo.ignorar : []),
    ]),
    maxBytes: Number.isInteger(crudo.maxBytes) && crudo.maxBytes > 0 ? crudo.maxBytes : 2_000_000,
    maximoFragmento: Number.isInteger(crudo.maximoFragmento) && crudo.maximoFragmento > 200
      ? crudo.maximoFragmento
      : 1200,
  };
}
