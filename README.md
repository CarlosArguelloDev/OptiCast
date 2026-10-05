# OptiCast

Carrusel local para pantallas de televisión, servido por Flask en el puerto 5001.
Cada pantalla abre `http://IP-DE-LA-RASPBERRY:5001/NOMBRE` y utiliza los archivos
de `static/NOMBRE/`. Admite JPG, JPEG, PNG, GIF, MP4 y WebM; la reproducción de
video depende de los códecs que soporte la televisión.

## Actualización de la tercera fase

Actualizar juntos `app.py`, `templates/index.html`, `templates/player.js` y
`templates/cache.js`. La Raspberry sigue necesitando solamente Flask; Node se
utiliza únicamente para ejecutar las pruebas de desarrollo.
Reiniciar el proceso de Flask y abrir de nuevo el carrusel en cada televisión
una vez para cargar el reproductor nuevo. El puerto y las direcciones de las
pantallas no cambian.

Después de esa carga inicial, el reproductor no recarga la página automáticamente.
Consulta `/api/pantallas/NOMBRE/media` cada 60 segundos. Si no hay cambios, el
servidor responde sin reenviar la lista. Los cambios se aplican al terminar la
imagen o video actual, manteniendo lo anterior visible hasta cargar el siguiente.

Los archivos se ordenan por nombre. Cada archivo tiene una versión basada en su
fecha de modificación y tamaño para actualizar la caché al reemplazarlo. Conviene
copiar archivos nuevos con una extensión temporal (por ejemplo `.tmp`) y luego
renombrarlos al terminar; así el carrusel no intenta reproducir una copia parcial.
Una carpeta temporalmente vacía no elimina el contenido actual de las TVs abiertas.

Si falla una consulta, se reintenta a los 30, 60, 120, 240 y hasta 300 segundos.
Cada solicitud tiene un límite de 10 segundos y no se solapa con otra. Al recuperar
la conexión, vuelve a consultar cada minuto. Los errores no navegan a una página
de error ni borran la lista que ya tiene el reproductor.

## Contenido durante cortes de Wi-Fi

El navegador guarda archivos completos en IndexedDB y los reproduce desde copias
locales. No utiliza Service Workers ni requiere cambiar el servidor local a HTTPS.
Se intenta abrir el almacenamiento al iniciar; si el navegador no lo permite,
se conserva el funcionamiento por red de las fases anteriores.

Por pantalla se guardan hasta 32 MiB y 24 archivos, con un máximo de 8 MiB por
archivo. Se seleccionan por orden de nombre, omitiendo archivos demasiado grandes.
Los límites son constantes al principio de `templates/cache.js`. Las descargas
son secuenciales, tienen un límite de 30 segundos y se interrumpen si superan el
tamaño permitido. Los archivos incompletos no se guardan. Si falla la conexión,
se reintenta al volver a consultar exitosamente al servidor. Se eliminan archivos
retirados y versiones anteriores antes de guardar reemplazos.

El reproductor usa las copias disponibles incluso con conexión. Cuando detecta
que el servidor no responde, circula por los archivos guardados de la lista actual
y omite los demás. La detección puede tardar hasta la siguiente consulta y su
límite de espera. Solo hay dos referencias a archivos locales a la vez (actual y
siguiente); se liberan al cambiar o al cancelar una carga. Estos límites acotan el
almacenamiento de archivos, no la memoria que un video o imagen consume al decodificarse.

Para revisar la preparación en una TV, abrir la dirección de su pantalla con
`?estado=1`, por ejemplo `http://IP-DE-LA-RASPBERRY:5001/crosscutter?estado=1`.
El indicador muestra cuántos archivos se han guardado y si una consulta falló.
Esperar a que aparezca «Contenido guardado» y comprobar el número antes de
desconectar el Wi-Fi. «Guardado parcial» indica que no se terminó de guardar toda
la selección. «Almacenamiento local no disponible» significa que hay que usar
la conexión habitual o un reproductor externo si se necesita funcionamiento
sin conexión confiable. Quitar `?estado=1` oculta el indicador.

Si una copia local no se puede reproducir, se intenta el archivo por red y se
excluye esa copia durante la sesión. El indicador «Copia local no reproducible»
permite identificar este caso. Cambiar la versión del archivo permite probarlo
de nuevo. Esto no resuelve un códec que tampoco pueda reproducirse por red.

La garantía se limita a los archivos efectivamente guardados que el navegador
pueda reproducir, mientras la página siga abierta. No permite abrir o recargar
la página sin conexión, ni recupera una TV que cierre su navegador. El navegador
puede borrar sus datos o rechazar almacenamiento por cuota o configuración.
Se necesita una prueba en el modelo Hisense real; los tests no verifican sus
códecs, su cuota ni su estabilidad durante un turno completo.

## Verificación

Solo para desarrollo, con Node instalado:
`node --test tests/player.test.cjs tests/cache.test.cjs`.

Con Python y las dependencias de `requirements.txt` instaladas:
`python -m unittest discover -s tests -p test_app.py`.

Las pruebas comprueban errores de reproducción, límites de espera, reintentos,
cambios durante un video, respuestas inválidas, versiones, consultas sin cambios,
límites de almacenamiento, cuota agotada, persistencia simulada y liberación de URLs.
Para validar en la Hisense: esperar la preparación con `?estado=1`, quitar el Wi-Fi
durante más de 30 minutos y confirmar que se repiten varios contenidos locales.
Restaurar el Wi-Fi y comprobar que adopta un archivo nuevo sin recargar la página.
Repetir reemplazando un archivo con el mismo nombre. Después hacer una prueba
durante todo un turno para observar el comportamiento y la memoria de la TV.

Referencias del navegador: [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
y [URLs de archivos locales](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static).
