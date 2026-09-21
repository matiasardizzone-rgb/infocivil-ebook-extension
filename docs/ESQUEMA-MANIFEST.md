# Esquema del Expediente Canónico

Un archivo `manifest.json` por expediente. Es la única fuente de verdad:
de acá salen el lector (libro y continuo), las cuatro exportaciones,
el anclaje de banderitas y el aviso de novedades en Mis Expedientes.

Se genera al scrapear y se actualiza de forma incremental (solo se
tocan las actuaciones nuevas). Se guarda en IndexedDB junto con los
PDFs por actuación, y se embebe también dentro del PDF unificado
(adjunto + metadatos XMP) para que el archivo se autodescriba.

## Estructura

```jsonc
{
  "schemaVersion": 1,

  // Identidad del expediente
  "expediente": {
    "jurisdiccion": "CIV",                 // tal como lo usa el SCW
    "numero": "13719",                     // sin ceros a la izquierda
    "anio": "2024",
    "caratula": "PEREZ JUAN C/ GOMEZ MARIA S/ DAÑOS Y PERJUICIOS",
    "cid": "abc123...",                    // id interno del SCW para esta consulta
    "urlPublica": "https://scw.pjn.gov.ar/scw/..."
  },

  // Vinculados (incidentes) ya descubiertos vía "Vinculados"
  "vinculados": [
    { "identificador": "13719/2024/1", "caratula": "INCIDENTE DE...", "cid": null }
    // cid null hasta que se abre explícitamente (limitación del SCW: no se
    // puede rebuscar un incidente directo, solo se llega por "Vinculados")
  ],

  // Cada actuación, en orden cronológico
  "actuaciones": [
    {
      "id": "scw-id-de-la-actuacion",      // id estable que usa el SCW — clave para diffs
      "tipo": "PROVEIDO",
      "descripcion": "Se tiene presente lo manifestado...",  // completa, sin truncar
      "fecha": "2024-03-15",
      "urlPublica": "https://scw.pjn.gov.ar/scw/actuacion.seam?...",
      "esHistorica": false,
      "esEscaneada": true,                 // true si es imagen (JPEG/JBIG2/rotada) sin texto
      "sha256": "...",                     // hash del PDF individual de la actuación
      "paginaInicio": 1,                   // rango dentro del PDF unificado (se recalcula al unificar)
      "paginaFin": 3
    }
  ],

  // Completitud — el aviso más importante del producto
  "completitud": {
    "totalInformadoPorSCW": 47,
    "totalObtenido": 47,
    "historicasLeidas": true,
    "completo": true,
    "motivoIncompleto": null,              // ej: "timeout en actuacionesHistoricas.seam"
    "fechaCaptura": "2026-09-18T14:32:00-03:00"
  },

  // Anotaciones del usuario — ancladas por id de actuación, NO por página
  "anotaciones": [
    {
      "actuacionId": "scw-id-de-la-actuacion",
      "tipo": "banderita",
      "color": "amarillo",
      "nota": "Ver fecha de vencimiento",
      "creada": "2026-09-18T15:00:00-03:00"
    }
  ],

  // Se completa recién al generar el PDF unificado (hash del archivo final)
  "unificado": {
    "sha256": null,
    "generadoEl": null
  }
}
```

## Por qué el anclaje es por `id` de actuación

Las banderitas y el aviso de "nuevas actuaciones" comparan **ids**, no
posiciones ni cantidades. Esto evita dos problemas ya vistos:

- El total de actuaciones puede coincidir aunque el contenido cambió
  (una histórica que antes no se leía, por ejemplo).
- Si se agrega una actuación en medio de la cronología, una banderita
  anclada a "página 12" quedaría corrida. Anclada al `id`, no se mueve.

## Diff para "Mis Expedientes"

Al revisar un expediente guardado, se comparan los `id` de
`actuaciones` contra la copia local. La diferencia (ids nuevos) es lo
que dispara el aviso y lo que se resalta en el índice al abrir el
lector.

## Pendiente de definir con el código real

- Formato exacto de `id` que expone el SCW por actuación (a confirmar
  contra `scrapeActuaciones.js`).
- Cómo se completa `vinculados[].cid` al abrir un incidente (a
  confirmar contra `vinculados.js`).
- Estructura exacta que ya arma `unificador.js` para no duplicar
  lógica de paginación.
