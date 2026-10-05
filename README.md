# OptiCast

Carrusel local para pantallas de televisión, servido por Flask en el puerto 5001.
Cada pantalla abre `http://IP-DE-LA-RASPBERRY:5001/NOMBRE` y utiliza los archivos
de `static/NOMBRE/`. Admite JPG, JPEG, PNG, GIF, MP4 y WebM; la reproducción de
video depende de los códecs que soporte la televisión.

## Actualización de la segunda fase

Actualizar juntos `app.py`, `templates/index.html` y `templates/player.js`.
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

Esto todavía no garantiza reproducir todos los archivos sin Wi-Fi: depende de
qué recursos conserve la caché del navegador. Tampoco recupera una TV que cierre
su navegador o apague la aplicación. El almacenamiento para funcionamiento sin
conexión corresponde a la siguiente fase.

## Verificación

Con Node instalado: `node --test tests/player.test.cjs`.

Con Python y las dependencias de `requirements.txt` instaladas:
`python -m unittest discover -s tests -p test_app.py`.

Las pruebas comprueban errores de reproducción, límites de espera, reintentos,
cambios durante un video, respuestas inválidas, versiones y consultas sin cambios.
Para validar en la Hisense: reproducir el carrusel, quitar el Wi-Fi durante más de
30 minutos, restaurarlo y comprobar que adopta un archivo nuevo sin recargar la
página. Repetir reemplazando un archivo con el mismo nombre. La compatibilidad y
el consumo de memoria deben verificarse en el modelo de televisión real.
