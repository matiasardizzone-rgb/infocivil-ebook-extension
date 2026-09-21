# Identidad y publicación de la extensión

Destinatarios: operadores del PJN, en Chrome común (sin política
empresarial: equipos Windows de 32 bits y macOS por VPN). Distribución
prevista: Chrome Web Store, **no listada**, cuenta institucional.
Estado actual: **desarrollo**, sin publicar.

## Dos ids, a propósito

| Etapa | Cómo se instala | Id |
|---|---|---|
| Desarrollo | "Cargar descomprimida" con el `manifest.json` del repo | `blbghgllddeiignhkclocamalkblagbi` (fijo por el campo `"key"`) |
| Producción | Link no listado de la Store | Lo asigna la Store al crear el ítem |

La Store no acepta el campo `"key"` en el paquete: asigna su propio id y su
propia clave. Por eso el `manifest.json` del repo es el de desarrollo, y
`scripts/empaquetar-store.mjs` genera el de producción.

Se mantienen los dos ids distintos para que en SYTEC se pueda tener
instalada la versión publicada y la de desarrollo al mismo tiempo. La
landing prueba ambos (`landing/deteccion-extension.js`) y prefiere la de la
Store.

`infocivil-ebook.pem` solo sirve para desarrollo. Conviene conservarlo
(si se pierde cambia el id de desarrollo), pero **no afecta a producción** y
nunca debe ir dentro del ZIP ni del repo (el script lo verifica).

## Checklist para la primera publicación (cuando llegue)

1. Agregar el origen real de la landing a `externally_connectable.matches`
   en `manifest.json`. Sin eso el script de empaquetado se niega a correr.
2. `node scripts/empaquetar-store.mjs` → `dist/infocivil-ebook-<versión>.zip`.
3. Subirlo desde la cuenta institucional; visibilidad **No listada**.
4. Completar en el panel de la Store la justificación de cada permiso
   (`tabs`, `scripting`, `downloads`, `unlimitedStorage`, host de SCW) y la
   sección de prácticas de privacidad: la extensión guarda contenido de
   expedientes **solo en el navegador del usuario** (IndexedDB) y no lo
   envía a ningún servidor. Los ítems no listados pasan igual por revisión.
5. Con el id asignado: completarlo en `IDS_CANDIDATOS` y el link en
   `URL_INSTALACION` de `landing/deteccion-extension.js`.
6. Una vez confirmada la landing de producción, quitar `*://10.5.1.224/*`
   del manifest de desarrollo si ya no se usa.

Las actualizaciones posteriores se distribuyen solas por la Store: subir el
ZIP con `version` incrementada en el manifest.

## Decisiones tomadas en esta pasada

- `host_permissions` reducido a `https://scw.pjn.gov.ar/*` (antes también
  `*.pjn.gov.ar`). La revisión de la Store penaliza permisos más amplios de
  lo que se usa. Cuando se confirme el dominio de LEX100 se agrega ese host
  puntual, junto con su entrada en `content_scripts.matches`.
- Se quitó `default_locale`: exige una carpeta `_locales/` que no existe y
  sin ella Chrome no carga la extensión.
- El canal externo (`src/background/externo.js`) revalida el origen del
  remitente contra el mismo `externally_connectable` del manifest, y expone
  `ping` con la versión instalada (sirve para pedir "actualizá la
  extensión" desde la landing más adelante).

## Piso de compatibilidad: Chrome 109

Confirmado: hay equipos de 32 bits con Windows 7/8.1, donde Chrome quedó
congelado en la versión 109. El manifest declara
`"minimum_chrome_version": "109"` y todo el código tiene que funcionar ahí.

- PDF.js: quedarse en la rama 3.x (hoy 3.11.174). No actualizar a 4.x o
  posterior sin probar en 109: esas versiones usan APIs más nuevas.
- No usar en código propio: `Promise.withResolvers`, `toSorted`,
  `toReversed`, `toSpliced`, `Array.prototype.with`, `Object.groupBy`,
  `Map.groupBy`, `Array.fromAsync` (todas posteriores a Chrome 109).
- Cada versión se prueba al menos una vez en un equipo real con Chrome 109
  antes de publicarla.
