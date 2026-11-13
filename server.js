#!/usr/bin/env node
// Servidor MCP (stdio) de memoria personal.
//
// Habla JSON-RPC 2.0 por stdin/stdout, un mensaje por línea. stdout es el canal
// del protocolo: nada de console.log. Los diagnósticos van a stderr.
//
// La idea: que cualquier cliente (Claude Code, Codex, Cursor, OpenCode) pueda
// preguntar "¿qué sé de esto?" y recibir fragmentos con cita exacta
// `archivo:línea`, en vez de un resumen inventado.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { cargarConfig } from "./src/config.js";
import { abrirBase, estadisticas } from "./src/db.js";
import { indexar } from "./src/indice.js";
import { buscar, buscarHibrido, leerFragmento, resumenFuentes } from "./src/buscar.js";
import { crearProveedorEmbeddings } from "./src/embeddings.js";
import { guardarNota } from "./src/notas.js";

export const NOMBRE = "mcp-memoria";
export const VERSION = "0.1.0";
const PROTOCOLO_POR_DEFECTO = "2024-11-05";

export const HERRAMIENTAS = [
  {
    name: "buscar_memoria",
    description:
      "Busca en la memoria del usuario (notas, memorias de agentes y READMEs indexados) y devuelve fragmentos con cita " +
      "exacta `archivo:línea`. Usala antes de preguntar algo que el usuario ya documentó: objetivos, proyectos, " +
      "decisiones, datos de contacto, cómo trabaja. Una lista vacía significa que no hay nada indexado sobre el tema.",
    inputSchema: {
      type: "object",
      properties: {
        consulta: {
          type: "string",
          description: 'Texto libre, por ejemplo "objetivos búsqueda laboral" o "decisiones de FletAR".',
          minLength: 1,
        },
        limite: {
          type: "integer",
          description: "Cuántos fragmentos devolver (1 a 20, por defecto 5).",
          minimum: 1,
          maximum: 20,
        },
        etiqueta: {
          type: "string",
          description: 'Filtra por etiqueta de fuente, por ejemplo "memoria", "notas" o "repos".',
        },
        modo: {
          type: "string",
          enum: ["auto", "bm25", "hibrido"],
          description:
            "auto (por defecto) usa híbrido si el índice tiene embeddings y léxico si no. " +
            "bm25 fuerza búsqueda por palabras; hibrido suma similitud semántica.",
        },
      },
      required: ["consulta"],
      additionalProperties: false,
    },
  },
  {
    name: "leer_fragmento",
    description:
      "Lee líneas exactas de un archivo ya indexado. Sirve para ampliar una cita devuelta por buscar_memoria " +
      "sin que el modelo tenga que leer el archivo entero.",
    inputSchema: {
      type: "object",
      properties: {
        archivo: {
          type: "string",
          description: "Ruta tal como la devolvió buscar_memoria (solo se puede leer lo que está indexado).",
          minLength: 1,
        },
        desde: { type: "integer", description: "Primera línea (1-based).", minimum: 1 },
        hasta: { type: "integer", description: "Última línea, máximo 200 líneas por pedido.", minimum: 1 },
      },
      required: ["archivo"],
      additionalProperties: false,
    },
  },
  {
    name: "guardar_nota",
    description:
      "Guarda un dato nuevo en la memoria (una decisión, una preferencia, un dato del usuario) y lo deja indexado. " +
      "Si el texto ya existía no lo duplica: devuelve la cita original. Usala cuando el usuario diga algo que " +
      "convenga recordar en próximas sesiones.",
    inputSchema: {
      type: "object",
      properties: {
        texto: {
          type: "string",
          description: "El dato a recordar, en una o dos frases autocontenidas.",
          minLength: 1,
        },
        etiquetas: {
          type: "array",
          items: { type: "string" },
          description: "Hasta 8 etiquetas cortas, por ejemplo ['trabajo', 'fletar'].",
        },
      },
      required: ["texto"],
      additionalProperties: false,
    },
  },
  {
    name: "listar_fuentes",
    description:
      "Lista las fuentes indexadas (archivos, etiqueta, tamaño y fecha de indexado) y el resumen del índice. " +
      "Sirve para saber qué memoria está disponible antes de buscar.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "reindexar",
    description:
      "Vuelve a recorrer las fuentes configuradas y actualiza el índice (solo procesa archivos cambiados). " +
      "Devuelve cuántos archivos son nuevos, cuántos se actualizaron y cuántos se borraron.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Respuesta de herramienta: texto JSON, legible por el modelo. */
export function respuesta(contenido, { error = false } = {}) {
  return {
    content: [
      { type: "text", text: typeof contenido === "string" ? contenido : JSON.stringify(contenido, null, 2) },
    ],
    isError: error,
  };
}

/**
 * Estado del servidor: base abierta y primer indexado hecho una sola vez.
 *
 * Se arma aparte del transporte para poder testear las herramientas sin
 * levantar el proceso.
 */
export function crearContexto(config) {
  const db = abrirBase(config.base);
  const proveedor = crearProveedorEmbeddings(config);
  let listo = null;

  const inicializar = () => {
    if (!listo) {
      listo = (async () => {
        const stats = estadisticas(db);
        if (stats.fuentes === 0) {
          await indexar(db, config, { log: (m) => console.error(`[${NOMBRE}] ${m}`), proveedor });
        }
      })();
    }
    return listo;
  };

  return { db, config, proveedor, inicializar };
}

/** Ejecuta una herramienta. Se exporta para testearla sin transporte. */
export async function ejecutarHerramienta(nombre, argumentos = {}, contexto) {
  const { db, config, proveedor, inicializar } = contexto;

  if (nombre === "buscar_memoria") {
    const consulta = argumentos.consulta;
    if (typeof consulta !== "string" || !consulta.trim()) {
      return respuesta("Falta el parámetro 'consulta'.", { error: true });
    }
    if (consulta.length > 300) {
      return respuesta("La consulta no puede superar los 300 caracteres.", { error: true });
    }
    const limite = Number.isInteger(argumentos.limite) ? Math.min(Math.max(argumentos.limite, 1), 20) : 5;
    const etiqueta = typeof argumentos.etiqueta === "string" && argumentos.etiqueta.trim()
      ? argumentos.etiqueta.trim()
      : null;
    const modoPedido = ["auto", "bm25", "hibrido"].includes(argumentos.modo) ? argumentos.modo : "auto";

    await inicializar();
    const hayVectores = Boolean(proveedor) && estadisticas(db).vectores > 0;
    const usarHibrido = modoPedido === "hibrido" || (modoPedido === "auto" && hayVectores);
    const resultados = usarHibrido
      ? await buscarHibrido(db, consulta, { limite, etiqueta, proveedor })
      : buscar(db, consulta, { limite, etiqueta });

    if (resultados.length === 0) {
      return respuesta({
        consulta,
        modo: usarHibrido ? "hibrido" : "bm25",
        resultados: [],
        mensaje: "No hay fragmentos que coincidan. Probá con otras palabras o revisá listar_fuentes.",
      });
    }
    return respuesta({
      consulta,
      modo: usarHibrido ? "hibrido" : "bm25",
      total: resultados.length,
      resultados: resultados.map((r) => ({
        cita: `${r.archivo}:${r.linea}`,
        archivo: r.archivo,
        linea: r.linea,
        linea_fin: r.linea_fin,
        etiqueta: r.etiqueta,
        titulo: r.titulo,
        encabezado: r.encabezado,
        fragmento: r.fragmento,
        puntaje: r.puntaje,
        ...(r.similitud !== undefined ? { similitud: r.similitud } : {}),
      })),
    });
  }

  if (nombre === "leer_fragmento") {
    await inicializar();
    const leido = await leerFragmento(db, argumentos.archivo, {
      desde: argumentos.desde,
      hasta: argumentos.hasta,
    });
    if (!leido) {
      return respuesta(
        "No puedo leer ese archivo: no está en el índice. Usá buscar_memoria o listar_fuentes para ver las rutas disponibles.",
        { error: true }
      );
    }
    return respuesta(leido);
  }

  if (nombre === "guardar_nota") {
    await inicializar();
    const guardado = await guardarNota(db, config, {
      texto: argumentos.texto,
      etiquetas: argumentos.etiquetas,
      proveedor,
    });
    if (guardado.error) return respuesta(guardado.error, { error: true });
    return respuesta({
      ...guardado,
      cita: `${guardado.archivo}:${guardado.linea}`,
      mensaje: guardado.creado ? "Nota guardada e indexada." : guardado.mensaje,
    });
  }

  if (nombre === "listar_fuentes") {
    await inicializar();
    return respuesta({ resumen: estadisticas(db), fuentes: resumenFuentes(db) });
  }

  if (nombre === "reindexar") {
    const resumen = await indexar(db, config, { log: (m) => console.error(`[${NOMBRE}] ${m}`), proveedor });
    return respuesta({ ...resumen, resumen: estadisticas(db) });
  }

  return respuesta(`Herramienta desconocida: ${nombre}`, { error: true });
}

/** Procesa un mensaje JSON-RPC y devuelve la respuesta (o null si es notificación). */
export async function procesar(mensaje, contexto) {
  const { id, method, params } = mensaje ?? {};

  const esNotificacion = id === undefined || id === null;
  const ok = (result) => (esNotificacion ? null : { jsonrpc: "2.0", id, result });
  const fallo = (code, message) => (esNotificacion ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const pedida = params?.protocolVersion;
      const version = typeof pedida === "string" && /^\d{4}-\d{2}-\d{2}$/.test(pedida) ? pedida : PROTOCOLO_POR_DEFECTO;
      return ok({
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: NOMBRE, version: VERSION },
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok({});

    case "tools/list":
      return ok({ tools: HERRAMIENTAS });

    case "tools/call": {
      const nombre = params?.name;
      if (typeof nombre !== "string") return fallo(-32602, "Falta el nombre de la herramienta.");
      const resultado = await ejecutarHerramienta(nombre, params?.arguments ?? {}, contexto);
      return ok(resultado);
    }

    default:
      return fallo(-32601, `Método no soportado: ${method}`);
  }
}

export function crearServidor({ entrada = process.stdin, salida = process.stdout, config } = {}) {
  const contexto = crearContexto(config ?? cargarConfig());

  const enviar = (objeto) => salida.write(`${JSON.stringify(objeto)}\n`);
  const lineas = createInterface({ input: entrada, crlfDelay: Infinity });

  lineas.on("line", (linea) => {
    const limpia = linea.trim();
    if (!limpia) return;

    let mensaje;
    try {
      mensaje = JSON.parse(limpia);
    } catch {
      enviar({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido." } });
      return;
    }

    procesar(mensaje, contexto)
      .then((respuestaMensaje) => {
        if (respuestaMensaje) enviar(respuestaMensaje);
      })
      .catch((error) => {
        console.error(`[${NOMBRE}] error inesperado:`, error);
        if (mensaje?.id !== undefined && mensaje?.id !== null) {
          enviar({ jsonrpc: "2.0", id: mensaje.id, error: { code: -32603, message: "Error interno del servidor." } });
        }
      });
  });

  return { contexto, cerrar: () => lineas.close() };
}

const esPrincipal = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (esPrincipal) {
  crearServidor();
  console.error(`[${NOMBRE}] v${VERSION} escuchando por stdio`);
}
