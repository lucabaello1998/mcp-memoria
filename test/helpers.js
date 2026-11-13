// Utilidades para los tests: copian las fixtures a un directorio temporal para
// que cada test trabaje sobre archivos propios y pueda modificarlos o borrarlos
// sin ensuciar el repo.

import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FIXTURES = new URL("./fixtures/", import.meta.url);

/** Copia las fixtures a un tmp y devuelve rutas + configuración lista. */
export async function crearEntorno({ maxBytes } = {}) {
  const raiz = await mkdtemp(join(tmpdir(), "mcp-memoria-test-"));
  const datos = join(raiz, "datos");
  await cp(FIXTURES, datos, { recursive: true });

  const config = {
    archivo: join(raiz, "memoria.config.json"),
    base: join(raiz, "memoria.db"),
    notas: join(raiz, "notas"),
    fuentes: [
      { ruta: join(datos, "memoria"), etiqueta: "memoria", extensiones: null },
      { ruta: join(datos, "repos"), etiqueta: "repos", extensiones: null },
    ],
    extensiones: [".md", ".txt"],
    ignorar: new Set(["node_modules", ".git", "dist"]),
    maxBytes: maxBytes ?? 200_000,
    maximoFragmento: 400,
  };

  return {
    raiz,
    datos,
    config,
    archivo: (rel) => join(datos, rel),
    leer: (rel) => readFile(join(datos, rel), "utf8"),
    escribir: (rel, contenido) => writeFile(join(datos, rel), contenido, "utf8"),
    guardarConfig: () =>
      writeFile(
        config.archivo,
        JSON.stringify(
          {
            base: config.base,
            notas: config.notas,
            maxBytes: config.maxBytes,
            maximoFragmento: config.maximoFragmento,
            fuentes: config.fuentes.map((f) => ({ ruta: f.ruta, etiqueta: f.etiqueta })),
          },
          null,
          2
        ),
        "utf8"
      ),
    limpiar: () => rm(raiz, { recursive: true, force: true }),
  };
}
