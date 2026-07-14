# Manual del operador — Etiquetas Walmart → SAE → Zebra

Guía paso a paso para **capturar un pedido, generar la factura de SAE e imprimir
las etiquetas** en la impresora Zebra GK420T. No necesitas saber de computación:
solo seguir los pasos en orden.

---

## Antes de empezar (ten esto listo)

1. **Tu usuario y contraseña** de la app (te los da tu supervisor).
2. La **impresora Zebra GK420T** encendida, con rollo de etiquetas y conectada por USB.
3. El **PDF del pedido** de Walmart (descargado de RetailLink).
4. **Aspel SAE** abierto en la computadora (para el paso de la factura).

> **Dirección de la app:** ábrela en **Google Chrome** en la dirección web que te
> pasó tu supervisor (termina en `.netlify.app`). El sistema ya está conectado al
> servidor; tú no configuras nada.

---

## Las dos formas de imprimir (elige una)

| | Modo A — Directo | Modo B — Estación |
|---|---|---|
| **Cuándo** | Trabajas en la **misma PC** que tiene la Zebra | La Zebra está en una PC aparte, o quieres que imprima sola |
| **Qué haces** | En la web tocas **“🖨 Conectar Zebra”** y eliges la impresora | Dejas corriendo el programa **EstacionZebra.exe** en la PC de la Zebra |
| **Navegador** | Chrome o Edge (obligatorio para el USB) | Cualquiera |

Ambos imprimen igual de bien. Si no estás seguro, usa el **Modo A**: es el más simple.

---

## PASO A PASO

### 1) Entrar
Abre la app en Chrome, escribe tu **usuario** y **contraseña**, y toca **Entrar**.

### 2) Elegir la cadena y cargar el pedido
1. Ve a la pestaña **Operar**.
2. Arriba, elige la cadena del pedido: **Walmart**, **HEB**, **Alsuper** o **Casa Ley**.
3. **Arrastra el PDF del pedido** al recuadro que dice *“Arrastra el PDF del pedido”*
   (o toca **Cargar pedido** y búscalo).
   - ¿Solo quieres probar? Usa **Cargar pedido de ejemplo**.

### 3) Revisar la validación ✅
El sistema lee el PDF solo y te muestra el resultado:

- **Verde / “Los totales cuadran”** → todo bien, continúa.
- **Con errores** (precio distinto, existencia insuficiente, SKU inexistente…) →
  **el pedido NO avanza**. Corrige en el origen o avisa a tu supervisor.
  No se puede facturar un pedido con errores.

### 4) Capturar la factura en SAE
1. Toca **Marcar capturado en SAE** (o **Generar factura**).
2. Se **descarga un archivo**. En **Aspel SAE**: menú **Importar → seleccionar
   ese archivo**. SAE crea la factura **SIN TIMBRAR**.
3. **Tú revisas y timbras la factura manualmente en SAE.** El sistema nunca timbra.

> **Importante:** la Orden de Compra (OC) de Walmart queda escrita en la factura.
> **1 OC = 1 factura.** Si intentas subir dos veces la misma OC, el sistema la
> rechaza para que no se duplique.

### 5) Generar las etiquetas
Toca **Generar etiquetas**. El sistema crea **una etiqueta por caja** (según las
piezas por caja del pedido). Verás la cuenta de etiquetas y una vista previa.

### 6) Imprimir en la Zebra 🖨
- **Modo A (directo):** si aún no lo hiciste, toca **🖨 Conectar Zebra**, elige tu
  impresora en la ventanita y acepta. El botón cambia a **“Zebra conectada”**.
- Luego toca **Imprimir todas las etiquetas** (o marca solo algunas cajas y usa
  **Imprimir seleccionadas**).
- Verás una barra de avance *“0 de N… imprimiendo”*. Cuando llega al 100%, listo.
- Con el **Modo B**, es igual, pero quien imprime es la estación `EstacionZebra.exe`
  que corre en la PC de la Zebra (la web solo manda el trabajo a la cola).

---

## Reimprimir cajas (si una salió mal)
1. En el pedido, usa **Reimprimir cajas de ___ a ___** (por ejemplo, de la 3 a la 5).
2. O marca cajas concretas y toca **Reimprimir seleccionadas**.
3. Si te equivocaste de trabajo, puedes **Cancelar impresión** mientras va en curso.

---

## Instalar la estación de impresión (solo Modo B, una vez por PC)

En la **PC que tiene la Zebra conectada**:

1. Descarga el programa desde este enlace (siempre la última versión):
   **https://github.com/redstoneft/SAE-y-ETIQUETAS/releases/latest/download/EstacionZebra.exe**
2. Cópialo al Escritorio y dale **doble clic**.
   - Si Windows muestra *“Windows protegió tu PC”* (SmartScreen): toca
     **Más información → Ejecutar de todas formas**. Es normal en programas nuevos.
3. Se abre una ventana negra que dice *“Zebra detectada automáticamente”* y
   *“Revisando cada 5s”*. **Déjala abierta**: mientras esté abierta, imprime sola.
4. (Opcional) Para que arranque solo al prender la PC: copia un acceso directo del
   `.exe` en la carpeta de Inicio de Windows (tecla Windows+R → escribe
   `shell:startup` → Enter → pega ahí el acceso directo).

---

## Problemas comunes

| Síntoma | Qué hacer |
|---|---|
| **No imprime nada** | Revisa que la Zebra esté **encendida, con papel y cable USB**. En Modo A, que el botón diga *“Zebra conectada”*. En Modo B, que la ventana negra de la estación esté **abierta**. |
| **No aparece la Zebra al “Conectar”** | Usa **Chrome o Edge** (no Safari/Firefox). Que la impresora esté prendida y conectada antes de tocar el botón. |
| **La validación sale con errores** | El pedido **no puede facturarse** así. Revisa precios/existencias/SKU o avisa a tu supervisor. |
| **“OC duplicada” / rechazo** | Esa Orden de Compra ya se facturó. **1 OC = 1 factura.** Búscala en la pestaña **Pedidos**. |
| **SmartScreen bloquea el .exe** | **Más información → Ejecutar de todas formas.** |
| **Las etiquetas salen corridas** | Revisa que sea rollo de **10×10 cm aprox.** y el driver **ZDesigner (ZPL)**. Para ajuste fino existe **Ajustar posición** en la app. |
| **La factura salió timbrada / mal** | El sistema **nunca timbra**; el timbrado lo haces tú en SAE. Revisa ahí. |

---

## Reglas que nunca cambian

- **1 Orden de Compra = 1 factura** (no se puede duplicar).
- La factura se crea **sin timbrar**; **tú la revisas y timbras** en SAE.
- La **OC de Walmart** siempre queda escrita en la factura.
- **Una etiqueta por caja.**
- Si la validación falla, **el pedido no avanza a SAE**.

---

*¿Dudas o algo no funciona? Toma una foto de la pantalla (con el mensaje de error)
y mándala a tu supervisor o al soporte técnico.*
