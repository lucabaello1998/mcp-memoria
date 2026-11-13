import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { crearEntorno } from "./helpers.js";

const ejecutar = promisify(execFile);
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

let entorno;

const correr = async (argumentos) => {
  try {
    const { stdout, stderr } = await ejecutar(process.execPath, [CLI, ...argumentos, "--config", entorno.config.archivo], {
      timeout: 30_000,
    });
    return { codigo: 0, stdout, stderr };
  } catch (error) {
    return { codigo: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
};

before(async () => {
  entorno = await crearEntorno();
  await entorno.guardarConfig();
});

after(async () => {
  await entorno.limpiar();
});

describe("cli", () => {
  test("index informa lo que hizo", async () => {
    const { codigo, stdout } = await correr(["index"]);
    assert.equal(codigo, 0);
    assert.match(stdout, /nuevos: 3/);
    assert.match(stdout, /fragmentos generados/);
  });

  test("index es idempotente", async () => {
    const { stdout } = await correr(["index"]);
    assert.match(stdout, /sin cambios: 3/);
  });

  test("search devuelve citas con archivo y línea", async () => {
    const { codigo, stdout } = await correr(["search", "sueldos", "--limite", "3"]);
    assert.equal(codigo, 0);
    assert.match(stdout, /\.md:\d+/);
    assert.match(stdout, /puntaje/);
  });

  test("search filtra por etiqueta", async () => {
    const { stdout } = await correr(["search", "sueldos", "--etiqueta", "repos"]);
    assert.match(stdout, /\[repos\]/);
    assert.ok(!stdout.includes("[memoria]"));
  });

  test("search sin resultados avisa", async () => {
    const { stdout } = await correr(["search", "ornitorrinco"]);
    assert.match(stdout, /Sin resultados/);
  });

  test("sources lista las fuentes", async () => {
    const { stdout } = await correr(["sources"]);
    assert.equal(stdout.trim().split("\n").length, 3);
  });

  test("stats resume el índice", async () => {
    const { stdout } = await correr(["stats"]);
    assert.match(stdout, /Archivos: 3/);
    assert.match(stdout, /Fragmentos: \d+/);
    assert.match(stdout, /\[memoria\]/);
  });

  test("search sin consulta falla con código 2", async () => {
    const { codigo, stderr } = await correr(["search"]);
    assert.equal(codigo, 2);
    assert.match(stderr, /Falta la consulta/);
  });

  test("un comando desconocido muestra la ayuda", async () => {
    const { codigo, stdout } = await correr(["inventado"]);
    assert.equal(codigo, 2);
    assert.match(stdout, /Uso:/);
  });

  test("--help no toca la base", async () => {
    const { codigo, stdout } = await correr(["--help"]);
    assert.equal(codigo, 0);
    assert.match(stdout, /mcp-memoria/);
  });
});
