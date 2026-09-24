const express = require('express');
const cors = require('cors');
const { procesarEncuesta } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Endpoint de documentacion y salud
app.get('/', (req, res) => {
  res.json({
    nombre: 'API Encuestas Hisense Qualtrics v2',
    version: '2.0.0',
    descripcion: 'Endpoint unico que recibe un registro completo de base de datos (con valores null) y procesa la encuesta de inicio a fin con Puppeteer.',
    endpoint_principal: {
      metodo: 'POST',
      ruta: '/api/encuesta/procesar',
      ejemplo_body: {
        id_registro_db: 101,
        orden_id: 'ORD-998877',
        servicio_centro_id: '2',
        nombre_persona: 'Carlos Mendoza',
        tipo_servicio: '1',
        familia_producto: '4',
        familia_producto_otro: null,
        modelo: 'HISENSE-55U7G',
        posible_encuesta: '1',
        posible_encuesta_otro: null,
        calificacion: 10,
        motivo_insatisfaccion: null,
        detalle_garantia_insat: null,
        detalle_reparacion_insat: null,
        detalle_callcenter_insat: null,
        detalle_insat_otro_texto: null,
        motivo_satisfaccion: '1',
        detalle_garantia_sat: '4',
        detalle_reparacion_sat: null,
        detalle_callcenter_sat: null,
        detalle_sat_otro_texto: null,
        comentario_final: 'Excelente atencion y servicio rapido.'
      }
    }
  });
});

// Endpoint Unico: Procesa el registro completo de la base de datos
app.post('/api/encuesta/procesar', async (req, res) => {
  try {
    const registro = req.body || {};
    
    // Validacion minima
    if (!registro.orden_id) {
      return res.status(400).json({
        error: 'El campo orden_id es obligatorio en el cuerpo de la peticion.'
      });
    }

    console.log(`\n[SERVER] Peticion recibida para procesar Orden: ${registro.orden_id}`);
    const resultado = await procesarEncuesta(registro);

    res.status(200).json({
      mensaje: 'Registro de encuesta procesado exitosamente',
      resultado
    });

  } catch (error) {
    console.error('[SERVER] Error al procesar encuesta:', error.message);
    res.status(500).json({
      error: error.message,
      nota: 'Ocurrio un error durante la ejecucion de la automatizacion.'
    });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n[SERVER] Servidor corriendo en http://localhost:${PORT}`);
  console.log(`[SERVER] Endpoint unico: POST http://localhost:${PORT}/api/encuesta/procesar\n`);
});
