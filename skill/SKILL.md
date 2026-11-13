---
name: memoria
description: Busca en la memoria personal del usuario (notas, memorias de agentes y READMEs indexados) con citas archivo:línea, y guarda datos nuevos. Usala antes de preguntar algo que el usuario ya documentó —objetivos, proyectos, decisiones, cómo trabaja, datos de contacto— y cuando diga algo que convenga recordar en próximas sesiones.
license: MIT
---

# Memoria personal

Esta skill le enseña al agente a usar el MCP **`mcp-memoria`**: un índice local
(SQLite FTS5) de las notas y documentos del usuario, con citas verificables.

## Requisito

El servidor MCP tiene que estar conectado:

```json
{
  "mcpServers": {
    "memoria": {
      "command": "node",
      "args": ["/ruta/a/mcp-memoria/server.js"],
      "env": { "MEMORIA_CONFIG": "/ruta/a/memoria.config.json" }
    }
  }
}
```

## Regla de oro

**Buscar antes de preguntar.** Si el usuario menciona un proyecto, un objetivo o
una decisión anterior, primero `buscar_memoria`. Si hay resultado, usalo y citá
la fuente (`archivo:línea`). Si no hay nada, decilo: "no tengo nada indexado
sobre eso" es una respuesta válida y mejor que inventar.

## Herramientas

### `buscar_memoria`

```json
{ "consulta": "objetivos búsqueda laboral", "limite": 5, "etiqueta": "memoria" }
```

Devuelve fragmentos con `cita`, `archivo`, `linea`, `encabezado`, `fragmento` y
`puntaje`. Con `etiqueta` se restringe a una fuente (`memoria`, `notas`,
`repos`).

- 2 a 4 términos concretos funcionan mejor que una pregunta larga.
- Si vuelve vacío, probá con sinónimos: la búsqueda es léxica, no semántica.
- Cuando dos resultados se contradicen, gana el de `etiqueta: "memoria"` y el
  más reciente, pero avisá la contradicción.

### `leer_fragmento`

```json
{ "archivo": "C:/Users/luca/.config/opencode/memory/proyectos.md", "desde": 118, "hasta": 140 }
```

Amplía una cita sin leer el archivo entero. Solo acepta rutas que estén en el
índice: si el archivo no aparece, usá `listar_fuentes`.

### `guardar_nota`

```json
{ "texto": "La entrevista de CRUX es el lunes 16 a las 12.", "etiquetas": ["trabajo"] }
```

Guardá cuando el usuario diga algo estable y útil para el futuro: una decisión,
una preferencia, una fecha, un dato de contacto. No guardes charla, ni cosas que
ya están en el código, ni datos sensibles (claves, tokens, documentos).

- Escribí la nota autocontenida: "el lunes 16 a las 12" solo sirve si dice de
  qué.
- Si el texto ya existía, la herramienta devuelve la cita original: no insistas.

### `listar_fuentes` y `reindexar`

`listar_fuentes` muestra qué está indexado; `reindexar` actualiza después de
editar archivos a mano. Si una búsqueda devuelve algo viejo, reindexá antes de
concluir que el dato no está.

## Cómo citar

Cuando uses un dato de la memoria, mostrá la cita:

> Según `...\memory\objetivos.md:6`, la prioridad uno es la búsqueda laboral.

Si el dato es viejo (el índice guarda la fecha de indexado), decilo: "esto es de
octubre, puede haber cambiado".
