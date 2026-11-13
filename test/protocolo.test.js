import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { crearEntorno } from "./helpers.js";

const SERVIDOR = fileURLToPath(new URL("../server.js", import.meta.url));

/** Cliente mínimo de JSON-RPC por stdio, igual que usaría un agente. */
function lanzar(env) {
  const hijo = spawn(process.execPath, [SERVIDOR], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pendientes = new Map();
  const crudas = [];
  const errores = [];

  createInterface({ input: hijo.stdout }).on("line", (linea) => {
    crudas.push(linea);
    const mensaje = JSON.parse(linea);
    const resolver = pendientes.get(mensaje.id);
    if (resolver) {
      pendientes.delete(mensaje.id);
      resolver(mensaje);
    }
  });
  createInterface({ input: hijo.stderr }).on("line", (linea) => errores.push(linea));

  let siguiente = 0;
  const pedir = (method, params) =>
    new Promise((resolver, rechazar) => {
      const id = ++siguiente;
      const reloj = setTimeout(() => rechazar(new Error(`timeout esperando ${method}`)), 20_000);
      pendientes.set(id, (mensaje) => {
        clearTimeout(reloj);
        resolver(mensaje);
      });
      hijo.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  return {
    hijo,
    pedir,
    crudas,
    errores,
    escribir: (texto) => hijo.stdin.write(texto),
    cerrar: () =>
      new Promise((resolver) => {
        hijo.once("exit", resolver);
        hijo.kill();
      }),
  };
}

let entorno;
let cliente;

before(async () => {
  entorno = await crearEntorno();
  await entorno.guardarConfig();
  cliente = lanzar({ MEMORIA_CONFIG: entorno.config.archivo });
});

after(async () => {
  await cliente.cerrar();
  await entorno.limpiar();
});

describe("handshake", () => {
  test("initialize devuelve protocolo, capacidades y nombre", async () => {
    const respuesta = await cliente.pedir("initialize", { protocolVersion: "2024-11-05" });
    assert.equal(respuesta.jsonrpc, "2.0");
    assert.equal(respuesta.result.protocolVersion, "2024-11-05");
    assert.deepEqual(respuesta.result.capabilities, { tools: {} });
    assert.equal(respuesta.result.serverInfo.name, "mcp-memoria");
  });

  test("ping contesta vacío", async () => {
    const respuesta = await cliente.pedir("ping");
    assert.deepEqual(respuesta.result, {});
  });

  test("un método desconocido devuelve -32601", async () => {
    const respuesta = await cliente.pedir("resources/list");
    assert.equal(respuesta.error.code, -32601);
  });
});

describe("tools/list", () => {
  test("expone las cinco herramientas", async () => {
    const respuesta = await cliente.pedir("tools/list");
    const nombres = respuesta.result.tools.map((t) => t.name).sort();
    assert.deepEqual(nombres, ["buscar_memoria", "guardar_nota", "leer_fragmento", "listar_fuentes", "reindexar"]);
  });

  test("todas tienen inputSchema válido y descripción", async () => {
    const respuesta = await cliente.pedir("tools/list");
    for (const herramienta of respuesta.result.tools) {
      assert.equal(herramienta.inputSchema.type, "object");
      assert.ok(herramienta.description.length > 40);
    }
  });
});

describe("tools/call", () => {
  test("buscar_memoria devuelve citas archivo:línea", async () => {
    const respuesta = await cliente.pedir("tools/call", {
      name: "buscar_memoria",
      arguments: { consulta: "objetivos búsqueda laboral", limite: 3 },
    });
    assert.equal(respuesta.result.isError, false);

    const datos = JSON.parse(respuesta.result.content[0].text);
    assert.ok(datos.total > 0);
    for (const resultado of datos.resultados) {
      assert.match(resultado.cita, /^.+:\d+$/);
      assert.equal(resultado.cita, `${resultado.archivo}:${resultado.linea}`);
    }
  });

  test("buscar_memoria sin resultados no es un error", async () => {
    const respuesta = await cliente.pedir("tools/call", {
      name: "buscar_memoria",
      arguments: { consulta: "ornitorrinco azul" },
    });
    const datos = JSON.parse(respuesta.result.content[0].text);
    assert.equal(datos.resultados.length, 0);
    assert.match(datos.mensaje, /No hay fragmentos/);
    assert.equal(respuesta.result.isError, false);
  });

  test("buscar_memoria valida argumentos", async () => {
    const sinConsulta = await cliente.pedir("tools/call", { name: "buscar_memoria", arguments: {} });
    assert.equal(sinConsulta.result.isError, true);

    const gigante = await cliente.pedir("tools/call", {
      name: "buscar_memoria",
      arguments: { consulta: "x".repeat(301) },
    });
    assert.equal(gigante.result.isError, true);
  });

  test("leer_fragmento responde con las líneas pedidas", async () => {
    const respuesta = await cliente.pedir("tools/call", {
      name: "leer_fragmento",
      arguments: { archivo: entorno.archivo("memoria/objetivos.md"), desde: 1, hasta: 3 },
    });
    const datos = JSON.parse(respuesta.result.content[0].text);
    assert.equal(datos.desde, 1);
    assert.match(datos.texto, /# Objetivos/);
  });

  test("leer_fragmento bloquea rutas fuera del índice", async () => {
    for (const archivo of ["C:\\Windows\\win.ini", "../../../../etc/passwd", "/etc/shadow"]) {
      const respuesta = await cliente.pedir("tools/call", { name: "leer_fragmento", arguments: { archivo } });
      assert.equal(respuesta.result.isError, true, `debería bloquear ${archivo}`);
    }
  });

  test("guardar_nota guarda y queda buscable", async () => {
    const respuesta = await cliente.pedir("tools/call", {
      name: "guardar_nota",
      arguments: { texto: "La entrevista de CRUX es el lunes a las 12.", etiquetas: ["trabajo"] },
    });
    const datos = JSON.parse(respuesta.result.content[0].text);
    assert.equal(datos.creado, true);
    assert.match(datos.cita, /:\d+$/);

    const busqueda = await cliente.pedir("tools/call", {
      name: "buscar_memoria",
      arguments: { consulta: "entrevista CRUX lunes" },
    });
    const encontrados = JSON.parse(busqueda.result.content[0].text);
    assert.ok(encontrados.resultados.some((r) => r.fragmento.includes("CRUX")));
  });

  test("listar_fuentes devuelve resumen y archivos", async () => {
    const respuesta = await cliente.pedir("tools/call", { name: "listar_fuentes", arguments: {} });
    const datos = JSON.parse(respuesta.result.content[0].text);
    assert.ok(datos.resumen.fuentes >= 3);
    assert.ok(datos.fuentes.every((f) => f.archivo && f.etiqueta));
  });

  test("reindexar informa contadores", async () => {
    const respuesta = await cliente.pedir("tools/call", { name: "reindexar", arguments: {} });
    const datos = JSON.parse(respuesta.result.content[0].text);
    assert.equal(typeof datos.iguales, "number");
    assert.equal(typeof datos.actualizados, "number");
    assert.ok(datos.resumen.fuentes >= 3);
  });

  test("una herramienta desconocida no rompe el servidor", async () => {
    const respuesta = await cliente.pedir("tools/call", { name: "borrar_todo", arguments: {} });
    assert.equal(respuesta.result.isError, true);
    const sigue = await cliente.pedir("ping");
    assert.deepEqual(sigue.result, {});
  });
});

describe("transporte", () => {
  test("stdout solo tiene mensajes JSON-RPC válidos", () => {
    assert.ok(cliente.crudas.length > 0);
    for (const linea of cliente.crudas) {
      const mensaje = JSON.parse(linea);
      assert.equal(mensaje.jsonrpc, "2.0");
      assert.ok("id" in mensaje);
    }
  });

  test("JSON inválido devuelve -32700", async () => {
    cliente.escribir("esto no es json\n");
    await new Promise((resolver) => setTimeout(resolver, 300));
    const ultima = JSON.parse(cliente.crudas.at(-1));
    assert.equal(ultima.error.code, -32700);
  });

  test("una notificación no genera respuesta", async () => {
    const antes = cliente.crudas.length;
    cliente.escribir(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await new Promise((resolver) => setTimeout(resolver, 300));
    assert.equal(cliente.crudas.length, antes);
  });
});
