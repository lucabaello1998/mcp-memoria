# mcp-memoria

Memoria portable para agentes: indexa tus notas, memorias y READMEs en SQLite
FTS5 y los expone por MCP con **citas exactas `archivo:línea`**. Sin
dependencias, sin API key y sin embeddings.

```text
$ mcp-memoria search "liquidacion SAC vacaciones"
1. ...\memory\proyectos.md:118  [memoria] puntaje 32.4085
   sueldos-ar — motor de liquidación + observatorio de sueldos tech
   Motor de liquidación argentino en .NET 8 (SAC, vacaciones, aportes, ...)
```

---

## El problema

Cada agente (Claude Code, Codex, Cursor, OpenCode) arranca en blanco. Vos le
explicás quién sos, en qué andás y qué decidiste la semana pasada; la sesión
termina y se olvida. Guardar todo en un `CLAUDE.md` ayuda hasta que el archivo
pasa los 50 KB y el agente lo lee entero o lo ignora.

Este servidor resuelve la parte aburrida: **buscar**. El agente pregunta por un
tema y recibe tres fragmentos con la ruta y la línea exactas, no un resumen
inventado. Si la cita no le alcanza, pide más líneas con `leer_fragmento`.

## Qué expone

| Herramienta | Para qué |
| --- | --- |
| `buscar_memoria` | Busca por texto libre y devuelve fragmentos con `cita: archivo:línea` |
| `leer_fragmento` | Lee líneas exactas de un archivo indexado (máx. 200 por pedido) |
| `guardar_nota` | Guarda un dato nuevo, lo indexa y evita duplicados |
| `listar_fuentes` | Muestra qué está indexado y cuándo se actualizó |
| `reindexar` | Actualiza el índice (solo procesa archivos cambiados) |

## Instalación

Necesitás **Node 22.13+**. No hay dependencias: SQLite y FTS5 vienen con Node.

```bash
git clone https://github.com/lucabaello1998/mcp-memoria.git
cd mcp-memoria
node cli.js index          # indexa y muestra qué hizo
node cli.js search "objetivos laborales"
```

### Configuración

Copiá `memoria.config.example.json` a `memoria.config.json`:

```json
{
  "base": "~/.local/share/mcp-memoria/memoria.db",
  "notas": "~/.config/opencode/memory/notas",
  "fuentes": [
    { "ruta": "~/.config/opencode/memory", "etiqueta": "memoria" },
    { "ruta": "~/Documents/repos", "etiqueta": "repos" },
    { "ruta": "~/notas", "etiqueta": "notas", "extensiones": [".md", ".txt"] }
  ],
  "ignorar": ["node_modules", "dist"],
  "maxBytes": 2000000
}
```

Sin archivo de configuración usa `~/.config/opencode/memory` si existe (o el
directorio actual) y guarda la base en el directorio de datos del sistema.
También se puede apuntar todo por entorno: `MEMORIA_CONFIG` y `MEMORIA_DB`.

### Conectarlo a un cliente MCP

```json
{
  "mcpServers": {
    "memoria": {
      "command": "node",
      "args": ["C:/ruta/a/mcp-memoria/server.js"],
      "env": { "MEMORIA_CONFIG": "C:/ruta/a/memoria.config.json" }
    }
  }
}
```

Funciona igual en Claude Code (`~/.claude.json`), Cursor (`mcp.json`), OpenCode
(`opencode.json`) o cualquier cliente que hable MCP por stdio. El servidor no
necesita que el índice exista: si la base está vacía, indexa en la primera
llamada.

## Cómo funciona

```text
fuentes (md/txt) ──► chunker ──► fragmentos ──► SQLite FTS5 (bm25)
                        │                              │
                   encabezado +                    búsqueda
                   líneas exactas                      │
                                                       ▼
                                            resultado + cita
                                            archivo:línea
```

1. **Indexado incremental.** Cada archivo se firma con SHA-256. Si no cambió, no
   se toca. Reindexar 530 archivos tarda **0.31 s**; la primera vez, **3.8 s**.
2. **Fragmentos por encabezado.** Un documento entero como unidad de búsqueda
   obliga al modelo a leer 40 KB para encontrar una frase. Se corta por
   `#`/`##`/`###` (o cada ~1200 caracteres si no hay encabezados) y se guarda el
   rango de líneas real, así la cita es verificable.
3. **Búsqueda léxica con BM25.** FTS5 con `unicode61 remove_diacritics 2`:
   `liquidación` y `liquidacion` son el mismo token. Los pesos son explícitos
   (título 8, encabezado 4, cuerpo 1) más un ajuste por etiqueta y recencia.
4. **Dos pasadas.** Primero busca con todos los términos (preciso); si no hay
   nada, relaja a cualquiera (recall). Una consulta vacía nunca inventa
   resultados: devuelve lista vacía.
5. **Citas que se pueden abrir.** El número de línea sale de la posición real de
   la coincidencia dentro del fragmento, no de una estimación.

## Decisiones y por qué

**Léxico antes que embeddings.** Para un corpus personal con jerga propia
(`SAC`, `FletAR`, `PostGIS`), BM25 es un baseline fuerte y no requiere GPU, API
key ni un modelo de 500 MB. Además es **explicable**: puedo decir por qué un
fragmento salió primero. Cuando el corpus pase los ~50 MB o las consultas sean
semánticas ("¿qué hice la semana pasada?"), el próximo paso es híbrido: BM25 +
embeddings, y el ranking ya está aislado para cambiarlo.

**`node:sqlite` en vez de `better-sqlite3`.** Cero dependencias, cero binarios
nativos, cero problemas al instalar en Windows. El costo es exigir Node 22.13+.

**Sin servidor HTTP.** MCP por stdio es lo que esperan los clientes y evita
abrir un puerto. El proceso muere con el cliente.

**Guardar notas con deduplicación.** Si el agente guarda la misma cosa diez
veces, el índice se llena de ruido. El texto se normaliza y se compara por hash:
la segunda vez devuelve la cita original.

## Límites honestos

- **No entiende sinónimos.** Busca palabras, no conceptos. "Plata" no encuentra
  "sueldo" salvo que ambas estén escritas.
- **El índice es local a la máquina.** No hay sincronización entre dispositivos.
- **No lee PDFs ni imágenes.** Solo texto plano con extensión conocida.
- **Un proceso por cliente.** Cada cliente MCP levanta su propio proceso; la
  base SQLite soporta lecturas concurrentes sin problema.

## Tests

```bash
npm test
```

**82 tests** con `node --test`, sin frameworks ni mocks de red:

- tokenización, acentos, stopwords y saneo de la consulta FTS5;
- chunker: rangos de línea verificados contra el archivo real;
- indexado: incremental, archivos borrados, binarios, gigantes y `test/fixtures`;
- búsqueda: **cada cita se abre y se comprueba que la línea contiene el término**;
- protocolo MCP por stdio: handshake, `tools/list`, errores `-32601`/`-32700`,
  notificaciones y bloqueo de rutas fuera del índice;
- CLI: `index`, `search`, `stats`, códigos de salida.

## Roadmap

Esta es la base de una app que crece con los otros cuatro ejercicios:

1. **RAG con embeddings** (híbrido BM25 + vectorial) sobre el mismo índice.
2. **Evals**: preguntas reales con respuesta esperada, corridas en modelo caro,
   barato y local, con tabla de aciertos y costo.
3. **Harness**: CLI propio con estas herramientas y un modelo.
4. **MCP de pedidos**: el mismo patrón de servidor aplicado a un dominio de
   negocio.

## Licencia

MIT. Ver [LICENSE](LICENSE).
