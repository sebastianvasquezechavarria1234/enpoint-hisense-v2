const puppeteer = require('puppeteer');

const QUALTRICS_URL = 'https://hisense.fra1.qualtrics.com/jfe/form/SV_0dDkbo3a555IM0m';

// Funcion para seleccionar opciones de radio buttons en Qualtrics
// Soporta:
// 1. Posicion ordinal (ej: '1' para primera opcion, '2' para segunda, etc.)
// 2. ID o value exacto de Qualtrics (ej: '7', '9', '10')
// 3. Texto visible de la opcion (ej: 'envio', 'cobertura', 'reparacion')
async function seleccionarOpcion(page, questionPrefix, valorOUbicacion) {
  if (valorOUbicacion === null || valorOUbicacion === undefined || valorOUbicacion === '') {
    return null;
  }

  await page.waitForSelector(`[name="${questionPrefix}"], [id^="${questionPrefix}"]`, { timeout: 30000 });

  const targetInfo = await page.evaluate((prefix, val) => {
    const radios = Array.from(document.querySelectorAll(`input[name="${prefix}"], input[id^="${prefix}~"]`));
    if (!radios.length) {
      return { error: `No se encontraron opciones para el grupo ${prefix}` };
    }

    const valStr = String(val).trim().toLowerCase();
    const valNum = parseInt(valStr);

    let objetivo = null;

    // A) Si es numerico, verificar primero si coincide con el value interno de Qualtrics
    if (!isNaN(valNum)) {
      objetivo = radios.find(r => r.value === valStr || r.id === `${prefix}~${valStr}`);

      // Si no coincide con un value interno exacto, usar la posicion ordinal en pantalla
      if (!objetivo && valNum >= 1 && valNum <= radios.length) {
        objetivo = radios[valNum - 1];
      }
    }

    // B) Si es texto, buscar coincidencia en el texto visible del elemento
    if (!objetivo) {
      objetivo = radios.find(r => {
        const li = r.closest('li, td');
        const text = li ? li.innerText.toLowerCase() : '';
        return text.includes(valStr);
      });
    }

    // C) Fallback: primera opcion para no bloquear el flujo
    if (!objetivo && radios.length > 0) {
      objetivo = radios[0];
    }

    if (objetivo) {
      const li = objetivo.closest('li, td');
      const textLabelEl = (li ? li.querySelector('.SingleAnswer, label:not(.q-radio)') : null) || document.querySelector(`label[for="${objetivo.id}"]`);
      const textoLabel = textLabelEl ? textLabelEl.innerText.trim() : '';
      const esOtro = objetivo.value === '6' || objetivo.value === '5' || objetivo.value === '9' || objetivo.value === '16' || textoLabel.toLowerCase().includes('otro');

      return {
        id: objetivo.id,
        value: objetivo.value,
        text: textoLabel,
        esOtro
      };
    }

    return { error: `No se pudo seleccionar la opcion ${val} en ${prefix}` };
  }, questionPrefix, valorOUbicacion);

  if (targetInfo.error) {
    throw new Error(targetInfo.error);
  }

  // Click con CDP de Puppeteer sobre la etiqueta con texto visible (.SingleAnswer)
  const selectorLabel = `label.SingleAnswer[for="${targetInfo.id}"], label[for="${targetInfo.id}"]:not(.q-radio), label[for="${targetInfo.id}"]`;
  try {
    await page.waitForSelector(selectorLabel, { timeout: 5000 });
    await page.click(selectorLabel);
  } catch (e) {
    await page.evaluate((id) => {
      const el = document.querySelector(`label.SingleAnswer[for="${id}"]`) || document.querySelector(`label[for="${id}"]`) || document.getElementById(id);
      if (el) el.click();
    }, targetInfo.id);
  }

  // Disparar evento change en el radio para confirmar el estado en Qualtrics
  await page.evaluate((id) => {
    const input = document.getElementById(id);
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, targetInfo.id);

  return {
    exito: true,
    idSeleccionado: targetInfo.id,
    valorSeleccionado: targetInfo.value,
    textoLabel: targetInfo.text,
    esOpcionOtro: targetInfo.esOtro
  };
}

// Funcion para seleccionar en listas desplegables (<select>)
async function seleccionarSelect(page, selectId, valorOUbicacion) {
  await page.waitForSelector(`[id="${selectId}"]`, { timeout: 30000 });

  const resultado = await page.evaluate((id, val) => {
    const select = document.getElementById(id);
    if (!select) return { error: `No se encontro el elemento select con id ${id}` };

    const options = Array.from(select.options).filter(o => o.value && !o.value.includes('null'));
    if (!options.length) return { error: `No hay opciones disponibles en ${id}` };

    const valStr = String(val).trim().toLowerCase();
    const valNum = parseInt(valStr);

    let objetivo = null;

    // 1. Coincidencia por atributo value exacto
    objetivo = options.find(o => o.value === String(val) || o.id === `${id}~${val}`);

    // 2. Coincidencia por texto del centro
    if (!objetivo) {
      objetivo = options.find(o => o.text && o.text.toLowerCase().includes(valStr));
    }

    // 3. Posicion ordinal (1-indexed)
    if (!objetivo && !isNaN(valNum) && valNum >= 1 && valNum <= options.length) {
      objetivo = options[valNum - 1];
    }

    // 4. Fallback al primero
    if (!objetivo && options.length > 0) {
      objetivo = options[0];
    }

    if (objetivo) {
      select.value = objetivo.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { exito: true, valorSeleccionado: objetivo.value, textoSeleccionado: objetivo.text };
    }

    return { error: `No se pudo seleccionar ${val} en ${id}` };
  }, selectId, valorOUbicacion);

  if (resultado.error) {
    throw new Error(resultado.error);
  }
  return resultado;
}

// Funcion principal que procesa el registro completo recibido de la base de datos
async function procesarEncuesta(registro = {}) {
  const inicioTiempo = Date.now();
  console.log('[BOT] Iniciando procesamiento de registro de encuesta...');

  // 1. Extraccion de campos (Mapeo directo de la fila de DB)
  const idRegistroDb = registro.id_registro_db || null;
  const ordenId = registro.orden_id || 'ORD-DEFAULT';
  const servicioCentroId = registro.servicio_centro_id || '2';
  const nombrePersona = registro.nombre_persona || 'Cliente Anonimo';
  const tipoServicio = registro.tipo_servicio !== null && registro.tipo_servicio !== undefined ? String(registro.tipo_servicio) : '1';
  const familiaProducto = registro.familia_producto !== null && registro.familia_producto !== undefined ? String(registro.familia_producto) : '4';
  const familiaProductoOtro = registro.familia_producto_otro || '';
  const modelo = registro.modelo || 'MOD-DEFAULT';
  const posibleEncuesta = registro.posible_encuesta !== null && registro.posible_encuesta !== undefined ? String(registro.posible_encuesta) : '1';
  const posibleEncuestaOtro = registro.posible_encuesta_otro || '';

  const calificacion = registro.calificacion !== null && registro.calificacion !== undefined ? parseInt(registro.calificacion) : null;

  // Insatisfaccion (Notas 0-8)
  let motivoInsatisfaccion = registro.motivo_insatisfaccion !== null && registro.motivo_insatisfaccion !== undefined ? String(registro.motivo_insatisfaccion) : null;
  const detalleGarantiaInsat = registro.detalle_garantia_insat !== null && registro.detalle_garantia_insat !== undefined ? String(registro.detalle_garantia_insat) : null;
  const detalleReparacionInsat = registro.detalle_reparacion_insat !== null && registro.detalle_reparacion_insat !== undefined ? String(registro.detalle_reparacion_insat) : null;
  const detalleCallCenterInsat = registro.detalle_callcenter_insat !== null && registro.detalle_callcenter_insat !== undefined ? String(registro.detalle_callcenter_insat) : null;
  const detalleInsatOtroTexto = registro.detalle_insat_otro_texto || '';

  // Satisfaccion (Notas 9-10)
  let motivoSatisfaccion = registro.motivo_satisfaccion !== null && registro.motivo_satisfaccion !== undefined ? String(registro.motivo_satisfaccion) : null;
  const detalleGarantiaSat = registro.detalle_garantia_sat !== null && registro.detalle_garantia_sat !== undefined ? String(registro.detalle_garantia_sat) : null;
  const detalleReparacionSat = registro.detalle_reparacion_sat !== null && registro.detalle_reparacion_sat !== undefined ? String(registro.detalle_reparacion_sat) : null;
  const detalleCallCenterSat = registro.detalle_callcenter_sat !== null && registro.detalle_callcenter_sat !== undefined ? String(registro.detalle_callcenter_sat) : null;
  const detalleSatOtroTexto = registro.detalle_sat_otro_texto || '';

  const comentarioFinal = registro.comentario_final || '';

  // Deducir motivo de insatisfaccion si vino null pero se paso un detalle no-null
  if (!motivoInsatisfaccion) {
    if (detalleGarantiaInsat !== null) motivoInsatisfaccion = '1';
    else if (detalleReparacionInsat !== null) motivoInsatisfaccion = '2';
    else if (detalleCallCenterInsat !== null) motivoInsatisfaccion = '3';
    else motivoInsatisfaccion = '1';
  }

  // Deducir motivo de satisfaccion si vino null pero se paso un detalle no-null
  if (!motivoSatisfaccion) {
    if (detalleGarantiaSat !== null) motivoSatisfaccion = '1';
    else if (detalleReparacionSat !== null) motivoSatisfaccion = '2';
    else if (detalleCallCenterSat !== null) motivoSatisfaccion = '3';
    else motivoSatisfaccion = '1';
  }

  const browser = await puppeteer.launch({
    headless: false,
    slowMo: 100,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-extensions',
      '--disable-popup-blocking',
      '--disable-infobars',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    console.log('[BOT] Navegando a Qualtrics...');
    await page.goto(QUALTRICS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    // ==========================================
    // PASO 1: ORDEN Y CENTRO DE SERVICIO
    // ==========================================
    console.log('[BOT] Paso 1: Llenando Orden de Servicio...');
    await page.waitForSelector('[id="QR~QID16"]', { timeout: 30000 });
    await page.click('[id="QR~QID16"]');
    await page.type('[id="QR~QID16"]', ordenId, { delay: 40 });

    console.log('[BOT] Paso 1: Seleccionando Centro Autorizado...');
    const resCentro = await seleccionarSelect(page, 'QR~QID25', servicioCentroId);
    console.log(`[BOT] Centro seleccionado: ${resCentro.textoSeleccionado || servicioCentroId}`);

    await page.waitForSelector('#NextButton', { timeout: 30000 });
    await page.click('#NextButton');
    await new Promise(r => setTimeout(r, 4000));

    // ==========================================
    // PASO 2: DATOS DE ATENCION Y POSIBLE ENCUESTA
    // ==========================================
    console.log('[BOT] Paso 2: Llenando Nombre de la persona...');
    await page.waitForSelector('[id="QR~QID19"]', { timeout: 30000 });
    await page.click('[id="QR~QID19"]');
    await page.type('[id="QR~QID19"]', nombrePersona, { delay: 40 });

    console.log('[BOT] Paso 2: Seleccionando Tipo de Servicio...');
    await seleccionarOpcion(page, 'QR~QID20', tipoServicio);

    console.log('[BOT] Paso 2: Seleccionando Familia de Producto...');
    const resFamilia = await seleccionarOpcion(page, 'QR~QID14', familiaProducto);
    if ((resFamilia.esOpcionOtro || familiaProducto === '16' || familiaProducto === '6') && familiaProductoOtro) {
      await page.waitForSelector('[id="QR~QID14~16~TEXT"]', { timeout: 15000 });
      await page.type('[id="QR~QID14~16~TEXT"]', familiaProductoOtro, { delay: 40 });
    }

    console.log('[BOT] Paso 2: Llenando Numero de Modelo...');
    await page.waitForSelector('[id="QR~QID21"]', { timeout: 30000 });
    await page.click('[id="QR~QID21"]');
    await page.type('[id="QR~QID21"]', modelo, { delay: 40 });

    console.log('[BOT] Paso 2: Seleccionando Es posible realizar la encuesta?...');
    const resEncuesta = await seleccionarOpcion(page, 'QR~QID13', posibleEncuesta);
    if ((resEncuesta.esOpcionOtro || posibleEncuesta === '5') && posibleEncuestaOtro) {
      await page.waitForSelector('[id="QR~QID13~5~TEXT"]', { timeout: 15000 });
      await page.type('[id="QR~QID13~5~TEXT"]', posibleEncuestaOtro, { delay: 40 });
    }

    await page.waitForSelector('#NextButton', { timeout: 30000 });
    await page.click('#NextButton');
    await new Promise(r => setTimeout(r, 4000));

    let caminoEjecutado = '';

    // ==========================================
    // BIFURCACION PRINCIPAL
    // ==========================================
    if (posibleEncuesta === '2') {
      // ------------------------------------------
      // CAMINO A: NO HAY RESPUESTA (Termina directo)
      // ------------------------------------------
      caminoEjecutado = 'No hay respuesta (Cierre directo de formulario)';
      console.log('[BOT] Camino: No hay respuesta. Formulario finalizado directamente.');

    } else if (posibleEncuesta === '3' || posibleEncuesta === '4' || posibleEncuesta === '5') {
      // ------------------------------------------
      // CAMINO B: REPROGRAMAR / NO INTERESA / OTRO (Salta a Comentarios)
      // ------------------------------------------
      caminoEjecutado = 'Encuesta cerrada anticipadamente con comentarios';
      console.log('[BOT] Camino: Cierre anticipado. Pasando a comentarios finales...');
      await page.waitForSelector('[id="QR~QID11"]', { timeout: 30000 });
      if (comentarioFinal) {
        await page.click('[id="QR~QID11"]');
        await page.type('[id="QR~QID11"]', comentarioFinal, { delay: 30 });
      }

      await page.waitForSelector('#NextButton', { timeout: 30000 });
      await page.click('#NextButton');
      await new Promise(r => setTimeout(r, 5000));

    } else if (posibleEncuesta === '1') {
      // ------------------------------------------
      // CAMINO C: SI ESTOY (Encuesta Completa)
      // ------------------------------------------
      const notaFinal = calificacion !== null ? calificacion : 10;
      console.log(`[BOT] Paso 3: Marcando Calificacion: ${notaFinal}...`);
      await seleccionarOpcion(page, 'QR~QID2', String(notaFinal));

      await page.waitForSelector('#NextButton', { timeout: 30000 });
      await page.click('#NextButton');
      await new Promise(r => setTimeout(r, 4000));

      if (notaFinal <= 8) {
        // --- RAMA DE INSATISFACCION (0 a 8) ---
        caminoEjecutado = `Insatisfaccion (Calificacion ${notaFinal})`;
        console.log(`[BOT] Paso 4: Marcando Razon de Insatisfaccion: ${motivoInsatisfaccion}...`);
        await seleccionarOpcion(page, 'QR~QID7', motivoInsatisfaccion);

        await page.waitForSelector('#NextButton', { timeout: 30000 });
        await page.click('#NextButton');
        await new Promise(r => setTimeout(r, 4000));

        if (motivoInsatisfaccion === '1') {
          // Detalle Garantia (QID8)
          const detG = detalleGarantiaInsat || '1';
          console.log(`[BOT] Paso 5 (Garantia Insat): Marcando detalle ${detG}...`);
          const resDet = await seleccionarOpcion(page, 'QR~QID8', detG);
          if ((resDet.esOpcionOtro || detG === '6') && detalleInsatOtroTexto) {
            await page.waitForSelector('[id="QR~QID8~6~TEXT"]', { timeout: 15000 });
            await page.type('[id="QR~QID8~6~TEXT"]', detalleInsatOtroTexto, { delay: 40 });
          }
        } else if (motivoInsatisfaccion === '2') {
          // Detalle Reparacion (QID9)
          const detR = detalleReparacionInsat || '1';
          console.log(`[BOT] Paso 5 (Reparacion Insat): Marcando detalle ${detR}...`);
          const resDet = await seleccionarOpcion(page, 'QR~QID9', detR);
          if ((resDet.esOpcionOtro || detR === '9' || detR === '6') && detalleInsatOtroTexto) {
            await page.waitForSelector('[id="QR~QID9~9~TEXT"]', { timeout: 15000 });
            await page.type('[id="QR~QID9~9~TEXT"]', detalleInsatOtroTexto, { delay: 40 });
          }
        } else if (motivoInsatisfaccion === '3') {
          // Detalle Call Center (QID10)
          const detC = detalleCallCenterInsat || '1';
          console.log(`[BOT] Paso 5 (Call Center Insat): Marcando detalle ${detC}...`);
          const resDet = await seleccionarOpcion(page, 'QR~QID10', detC);
          if ((resDet.esOpcionOtro || detC === '5') && detalleInsatOtroTexto) {
            await page.waitForSelector('[id="QR~QID10~5~TEXT"]', { timeout: 15000 });
            await page.type('[id="QR~QID10~5~TEXT"]', detalleInsatOtroTexto, { delay: 40 });
          }
        }

        await page.waitForSelector('#NextButton', { timeout: 30000 });
        await page.click('#NextButton');
        await new Promise(r => setTimeout(r, 4000));

      } else {
        // --- RAMA DE SATISFACCION (9 y 10) ---
        caminoEjecutado = `Satisfaccion (Calificacion ${notaFinal})`;
        console.log(`[BOT] Paso 4: Marcando Razon de Satisfaccion: ${motivoSatisfaccion}...`);
        await seleccionarOpcion(page, 'QR~QID3', motivoSatisfaccion);

        await page.waitForSelector('#NextButton', { timeout: 30000 });
        await page.click('#NextButton');
        await new Promise(r => setTimeout(r, 4000));

        if (motivoSatisfaccion === '1') {
          // Detalle Garantia Sat (QID4)
          const detG = detalleGarantiaSat || '1';
          console.log(`[BOT] Paso 5 (Garantia Sat): Marcando detalle ${detG}...`);
          const resDet = await seleccionarOpcion(page, 'QR~QID4', detG);
          if ((resDet.esOpcionOtro || detG === '6') && detalleSatOtroTexto) {
            await page.waitForSelector('[id="QR~QID4~6~TEXT"]', { timeout: 15000 });
            await page.type('[id="QR~QID4~6~TEXT"]', detalleSatOtroTexto, { delay: 40 });
          }
        } else if (motivoSatisfaccion === '2') {
          // Detalle Reparacion Sat (QID5)
          const detR = detalleReparacionSat || '1';
          console.log(`[BOT] Paso 5 (Reparacion Sat): Marcando detalle ${detR}...`);
          const resDet = await seleccionarOpcion(page, 'QR~QID5', detR);
          if ((resDet.esOpcionOtro || detR === '9' || detR === '6') && detalleSatOtroTexto) {
            await page.waitForSelector('[id="QR~QID5~9~TEXT"]', { timeout: 15000 });
            await page.type('[id="QR~QID5~9~TEXT"]', detalleSatOtroTexto, { delay: 40 });
          }
        } else if (motivoSatisfaccion === '3') {
          // Detalle Call Center Sat (QID6)
          const detC = detalleCallCenterSat || '1';
          console.log(`[BOT] Paso 5 (Call Center Sat): Marcando detalle ${detC}...`);
          const resDet = await seleccionarOpcion(page, 'QR~QID6', detC);
          if ((resDet.esOpcionOtro || detC === '5') && detalleSatOtroTexto) {
            await page.waitForSelector('[id="QR~QID6~5~TEXT"]', { timeout: 15000 });
            await page.type('[id="QR~QID6~5~TEXT"]', detalleSatOtroTexto, { delay: 40 });
          }
        }

        await page.waitForSelector('#NextButton', { timeout: 30000 });
        await page.click('#NextButton');
        await new Promise(r => setTimeout(r, 4000));
      }

      // Paso 6: Comentario final y Entrega
      console.log('[BOT] Paso 6: Escribiendo comentario final (opcional)...');
      await page.waitForSelector('[id="QR~QID11"]', { timeout: 30000 });
      if (comentarioFinal) {
        await page.click('[id="QR~QID11"]');
        await page.type('[id="QR~QID11"]', comentarioFinal, { delay: 30 });
      }

      console.log('[BOT] Paso 6: Haciendo click en Entregar (#NextButton)...');
      await page.waitForSelector('#NextButton', { timeout: 30000 });
      await page.click('#NextButton');
      await new Promise(r => setTimeout(r, 5000));
    }

    const textoFinal = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    const exitoRegistrado = textoFinal.includes('SU RESPUESTA HA SIDO REGISTRADA') || textoFinal.includes('agradecemos el tiempo');

    const tiempoTotalMs = Date.now() - inicioTiempo;
    console.log(`[BOT] Proceso completado en ${Math.round(tiempoTotalMs / 1000)}s.`);
    console.log(`[BOT] Estado registrado: ${exitoRegistrado ? 'SI' : 'NO'}\n`);

    return {
      status: 'completado',
      idRegistroDb,
      encuestaEntregada: exitoRegistrado,
      caminoEjecutado,
      ordenId,
      tiempoTotalMs,
      urlFinal: page.url()
    };

  } catch (error) {
    console.error('[BOT] Error durante el procesamiento:', error.message);
    throw error;
  }
}

module.exports = { procesarEncuesta, QUALTRICS_URL };
