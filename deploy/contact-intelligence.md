# Consulta de WhatsApp para la intranet

`GET /api/v1/integrations/contact-intelligence/events?after=0&limit=500`
usa `Authorization: Bearer <token hexadecimal de 64 caracteres>`.
El token solo permite leer el historial del tenant configurado. No sirve como
sesión de usuario ni autoriza envíos, cierres o cambios. No se exportan cuerpos,
archivos, nombres ni credenciales de WhatsApp.

La migración 063 instala captura prospectiva, inicialmente sin tenants activos.
Después de desplegar por `git pull --ff-only` y arrancar el backend, ejecutar
`node scripts/contactIntelligence.js <tenant UUID>` dentro del contenedor,
entregando el token por stdin. El proceso crea una línea base de estados, sin
importar mensajes anteriores. Repetirlo rota el token y conserva la activación.

El cliente fija `source_id` y `activated_at`, guarda los eventos y `next_cursor`
en una única transacción y continúa mientras `has_more` sea verdadero. Las
secuencias están ordenadas por confirmación: un escritor concurrente no puede
adelantar un evento todavía sin confirmar. Fechas UTC conservan microsegundos.

`state` registra OPEN, CLOSED, UNASSIGNED o REMOVED. `sent` prueba un mensaje
saliente aceptado, enviado cuando la conversación estaba OPEN. Recibidos,
pendientes, fallidos y mensajes anteriores a la activación no generan toques.
Una confirmación tardía utiliza el instante original del mensaje y el estado
histórico, aunque el chat ya esté cerrado. La identidad del mensaje impide
duplicados por ACK, relectura o resincronización. Los warmups internos ya son
excluidos por el receptor antes de insertarse en `chat_messages`.

El cliente intranet agrupa por conversación + día CDMX + crédito. El envío no
equivale a entrega o lectura. Borrar o cerrar un chat conserva el historial.

Para este cambio sin dependencias nuevas, `deploy/backend-code.Dockerfile`
permite conservar exactamente las dependencias de la imagen instalada. Retener
primero una etiqueta de esa imagen, construir con `BASE_IMAGE` y reiniciar solo
backend mediante Compose, conservando PostgreSQL, Redis, medios y sesiones.
Para cambios de dependencias utilizar el Dockerfile habitual.

Prueba aislada: `scripts/testContactIntelligence.js` requiere una base vacía
PostgreSQL 16 llamada `contact_test`; crea su fixture de mensajes particionados
y verifica captura, aislamiento por tenant, API y concurrencia. No envía mensajes.
