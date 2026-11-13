// Harness: un agente mínimo con herramientas y un modelo.
//
// No es un framework: es el bucle que hace falta para que un modelo consulte la
// memoria antes de contestar. El modelo no escribe código ni tiene shell; solo
// puede pedir dos cosas: buscar o leer un fragmento. Si no pide nada, contesta.
//
// El protocolo es JSON en texto porque cualquier modelo sabe emitirlo, incluso
// uno chico local que no soporta tool calling nativo.

import { buscar, buscarHibrido, leerFragmento } from "../src/buscar.js";
import { estadisticas } from "../src/db.js";

export const SISTEMA = `Sos un asistente con memoria sobre una persona. Antes de responder, buscá en su memoria.
Respondé SIEMPRE con un único objeto JSON, sin texto alrededor, con una de estas formas:
{"accion":"buscar","consulta":"palabras clave"}
{"accion":"leer","archivo":"ruta exacta","desde":1,"hasta":40}
{"accion":"responder","texto":"respuesta en dos frases, citando archivo:línea"}
Reglas: no inventes datos; si la memoria no alcanza, respondé que no tenés información suficiente;
no repitas una búsqueda idéntica; máximo 3 acciones antes de responder.`;

/** Extrae el primer objeto JSON del texto del modelo. */
export function parsearAccion(texto) {
  if (typeof texto !== "string") return null;
  const inicio = texto.indexOf("{");
  const fin = texto.lastIndexOf("}");
  if (inicio === -1 || fin <= inicio) return null;
  let datos;
  try {
    datos = JSON.parse(texto.slice(inicio, fin + 1));
  } catch {
    return null;
  }
  if (!datos || typeof datos !== "object") return null;
  if (!["buscar", "leer", "responder"].includes(datos.accion)) return null;
  return datos;
}

function formatearResultados(resultados) {
  if (resultados.length === 0) return "Sin resultados.";
  return resultados
    .map((r, i) => `[${i + 1}] ${r.archivo}:${r.linea}\n${r.fragmento}`)
    .join("\n\n");
}

/**
 * Corre el bucle agente -> herramienta -> agente hasta que responde o se queda
 * sin pasos. Devuelve también las citas que tocó, para poder auditarlas.
 */
export async function responder(pregunta, { db, modelo, embeddings = null, maxPasos = 4, limite = 4, log = () => {} }) {
  if (typeof pregunta !== "string" || !pregunta.trim()) {
    throw new Error("Falta la pregunta.");
  }

  const historial = [
    { role: "system", content: SISTEMA },
    { role: "user", content: pregunta },
  ];
  const citas = new Set();
  const pasos = [];
  const busquedas = new Set();
  let tokensEntrada = 0;
  let tokensSalida = 0;

  const hayVectores = Boolean(embeddings) && estadisticas(db).vectores > 0;
  const buscarEnMemoria = async (consulta) => {
    if (busquedas.has(consulta)) return { repetida: true, resultados: [] };
    busquedas.add(consulta);
    return {
      repetida: false,
      resultados: hayVectores
        ? await buscarHibrido(db, consulta, { limite, proveedor: embeddings })
        : buscar(db, consulta, { limite }),
    };
  };

  for (let paso = 1; paso <= maxPasos; paso += 1) {
    const salida = await modelo.charlar(historial);
    tokensEntrada += salida.tokensEntrada ?? 0;
    tokensSalida += salida.tokensSalida ?? 0;
    const accion = parsearAccion(salida.texto);

    if (!accion) {
      pasos.push({ paso, accion: "respuesta-libre" });
      return {
        respuesta: salida.texto.trim(),
        pasos,
        citas: [...citas],
        uso: { tokensEntrada, tokensSalida },
      };
    }

    pasos.push({ paso, accion: accion.accion, detalle: accion.consulta ?? accion.archivo ?? "" });
    log(`paso ${paso}: ${accion.accion} ${accion.consulta ?? accion.archivo ?? ""}`);

    if (accion.accion === "responder") {
      return {
        respuesta: String(accion.texto ?? "").trim(),
        pasos,
        citas: [...citas],
        uso: { tokensEntrada, tokensSalida },
      };
    }

    if (accion.accion === "buscar") {
      const consulta = String(accion.consulta ?? "").trim();
      if (!consulta) {
        historial.push({ role: "assistant", content: salida.texto });
        historial.push({ role: "user", content: "La búsqueda necesita 'consulta'." });
        continue;
      }
      const { repetida, resultados } = await buscarEnMemoria(consulta);
      for (const resultado of resultados) citas.add(`${resultado.archivo}:${resultado.linea}`);
      historial.push({ role: "assistant", content: salida.texto });
      historial.push({
        role: "user",
        content: repetida
          ? "Esa búsqueda ya la hiciste. Usá los resultados anteriores o respondé."
          : `RESULTADOS DE "${consulta}":\n\n${formatearResultados(resultados)}`,
      });
      continue;
    }

    if (accion.accion === "leer") {
      const leido = await leerFragmento(db, accion.archivo, { desde: accion.desde, hasta: accion.hasta });
      if (leido) citas.add(`${leido.archivo}:${leido.desde}-${leido.hasta}`);
      historial.push({ role: "assistant", content: salida.texto });
      historial.push({
        role: "user",
        content: leido
          ? `CONTENIDO DE ${leido.archivo} (líneas ${leido.desde}-${leido.hasta}):\n\n${leido.texto}`
          : "No puedo leer ese archivo: no está en el índice.",
      });
    }
  }

  return {
    respuesta: `No llegué a una respuesta en ${maxPasos} pasos.`,
    pasos,
    citas: [...citas],
    uso: { tokensEntrada, tokensSalida },
  };
}
