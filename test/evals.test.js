import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  acertoFuente,
  dijoNoSabe,
  formatearTabla,
  mrr,
  posicionFuente,
  promedio,
  puntuarRespuesta,
} from "../evals/evaluar.js";
import { costoEstimado, crearProveedor, precioDe } from "../evals/proveedores.js";

describe("puntuarRespuesta", () => {
  test("acierta con todas las claves, ignorando acentos y mayúsculas", () => {
    const r = puntuarRespuesta("La prioridad es la BÚSQUEDA LABORAL.", ["busqueda laboral"]);
    assert.equal(r.ok, true);
    assert.equal(r.aciertos, 1);
  });

  test("marca lo que falta", () => {
    const r = puntuarRespuesta("Faltan créditos para el título.", ["tecnico universitario", "12"]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.faltan, ["tecnico universitario", "12"]);
    assert.equal(r.aciertos, 0);
  });

  test("una respuesta vacía no acierta nada", () => {
    assert.equal(puntuarRespuesta("", ["algo"]).ok, false);
  });
});

describe("dijoNoSabe", () => {
  test("detecta las formas habituales de no saber", () => {
    assert.equal(dijoNoSabe("No tengo información suficiente."), true);
    assert.equal(dijoNoSabe("Ese dato no aparece en el contexto."), true);
    assert.equal(dijoNoSabe("La prioridad es la búsqueda laboral."), false);
  });
});

describe("citas", () => {
  const resultados = [
    { archivo: "C:/memoria/cv-general.md", linea: 3 },
    { archivo: "C:/memoria/proyectos.md", linea: 118 },
  ];

  test("encuentra la posición del archivo esperado", () => {
    assert.equal(posicionFuente(resultados, ["proyectos.md"]), 2);
    assert.equal(posicionFuente(resultados, ["cv-general.md"]), 1);
  });

  test("devuelve null si el archivo no está", () => {
    assert.equal(posicionFuente(resultados, ["objetivos.md"]), null);
    assert.equal(acertoFuente(resultados, ["objetivos.md"]), false);
  });

  test("tolera acentos y mayúsculas en la ruta", () => {
    assert.equal(posicionFuente(resultados, ["CV-GENERAL.MD"]), 1);
  });
});

describe("mrr y promedio", () => {
  test("MRR de posiciones 1 y 3", () => {
    assert.equal(mrr([1, 3]), Number(((1 + 1 / 3) / 2).toFixed(4)));
  });

  test("MRR con huecos", () => {
    assert.equal(mrr([1, null]), 0.5);
    assert.equal(mrr([]), 0);
  });

  test("promedio redondea a dos decimales", () => {
    assert.equal(promedio([10, 20, 30]), 20);
    assert.equal(promedio([1, 2]), 1.5);
    assert.equal(promedio([]), 0);
  });
});

describe("formatearTabla", () => {
  test("arma una tabla markdown alineada", () => {
    const tabla = formatearTabla(["modo", "n"], [["bm25", 3], ["hibrido", 12]]);
    const lineas = tabla.split("\n");
    assert.equal(lineas.length, 4);
    assert.match(lineas[0], /^\| modo/);
    assert.match(lineas[1], /^\| -+/);
    assert.ok(lineas.every((l) => l.endsWith("|")));
  });

  test("sin filas igual genera encabezado", () => {
    assert.equal(formatearTabla(["a"], []).split("\n").length, 2);
  });
});

describe("proveedores", () => {
  test("el proveedor falso es determinista y cuenta tokens", async () => {
    const proveedor = crearProveedor("falso:prueba");
    const salida = await proveedor.charlar([{ role: "user", content: "hola mundo" }]);
    assert.equal(salida.texto, "Respuesta falsa para: hola mundo");
    assert.ok(salida.tokensEntrada > 0);
  });

  test("openai sin key falla con un mensaje claro", () => {
    assert.throws(() => crearProveedor("openai:gpt-4o-mini", { env: {} }), /OPENAI_API_KEY/);
  });

  test("openai usa la key y devuelve tokens del usage", async () => {
    let pedido;
    const proveedor = crearProveedor("openai:gpt-4o-mini", {
      env: { OPENAI_API_KEY: "sk-prueba", OPENAI_BASE_URL: "https://ejemplo.test/v1" },
      fetchImpl: async (url, opciones) => {
        pedido = { url, autorizacion: opciones.headers.authorization, cuerpo: JSON.parse(opciones.body) };
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "respuesta" } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
        };
      },
    });
    const salida = await proveedor.charlar([{ role: "user", content: "hola" }]);
    assert.equal(salida.texto, "respuesta");
    assert.equal(salida.tokensEntrada, 100);
    assert.equal(pedido.url, "https://ejemplo.test/v1/chat/completions");
    assert.equal(pedido.autorizacion, "Bearer sk-prueba");
    assert.equal(pedido.cuerpo.model, "gpt-4o-mini");
  });

  test("ollama pega en /api/chat con think desactivado", async () => {
    let pedido;
    const proveedor = crearProveedor("ollama:qwen3.5:4b", {
      env: { OLLAMA_URL: "http://localhost:11434/" },
      fetchImpl: async (url, opciones) => {
        pedido = { url, cuerpo: JSON.parse(opciones.body) };
        return {
          ok: true,
          json: async () => ({ message: { content: "ok" }, prompt_eval_count: 50, eval_count: 5 }),
        };
      },
    });
    const salida = await proveedor.charlar([{ role: "user", content: "hola" }]);
    assert.equal(pedido.url, "http://localhost:11434/api/chat");
    assert.equal(pedido.cuerpo.think, false);
    assert.equal(pedido.cuerpo.stream, false);
    assert.equal(salida.tokensSalida, 5);
  });

  test("un tipo desconocido no se acepta", () => {
    assert.throws(() => crearProveedor("magia:algo"), /desconocido/);
  });
});

describe("costos", () => {
  test("calcula con la tabla de precios", () => {
    assert.equal(costoEstimado("gpt-4o-mini", 1_000_000, 1_000_000), Number((0.15 + 0.6).toFixed(6)));
  });

  test("un modelo desconocido devuelve null, no un número inventado", () => {
    assert.equal(costoEstimado("modelo-inexistente", 100, 100), null);
    assert.equal(precioDe("modelo-inexistente"), null);
  });

  test("un modelo local no tiene costo por token", () => {
    assert.equal(costoEstimado("qwen3.5:4b", 1000, 1000), null);
  });
});
