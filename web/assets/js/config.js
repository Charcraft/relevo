/* ==========================================================================
   Relevo: configuración del negocio
   Edita SOLO este archivo con tus datos reales.
   Los precios son rangos en pesos mexicanos: [mínimo, máximo].
   ========================================================================== */

window.RELEVO = {
  // Dirección del rastreador de visitas del servidor (proxy same-origin /t).
  track: "/t",

  // Número de WhatsApp con lada de país, solo dígitos.
  whatsapp: "5210000000000",
  whatsappPretty: "+52 000 000 0000",

  // Usuario de Instagram sin la arroba. Déjalo vacío para ocultarlo.
  instagram: "relevo.demo",

  currency: "MXN",

  // Rangos por servicio. El mínimo global es 50 y el techo 250.
  prices: {
    ensayo: [100, 250],
    presentacion: [80, 180],
    formato: [50, 90],
    cambridge: [60, 150],
    tarea: [50, 120]
  }
};
