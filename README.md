# OptiCast

Sistema de cartelería para televisiones en una red local. Un servidor con Python
y Flask administra imágenes, videos, carruseles y avisos programados; cada TV
abre su dirección de reproducción en el navegador.

Puede ejecutarse en Linux, incluido Raspberry Pi OS, y en Windows. El servidor
y las TVs deben poder comunicarse por la red local. Las seis pantallas son
`comedor`, `crosscutter`, `extrusion`, `vulcas`, `kalandria` y `confections`.

## Requisitos

- Python 3.10 o posterior, con `pip` y soporte para entornos virtuales.
- Las dependencias de `requirements.txt`: actualmente `Flask==3.0.0`.
- Espacio para los archivos multimedia y permisos de escritura donde se crea
  la carpeta de datos `instance/` dentro del proyecto.
- Un navegador en cada TV compatible con el contenido que se va a reproducir.
- Git, si se instala o actualiza clonando este repositorio.

SQLite forma parte de Python y no requiere instalar un servidor de base de datos.
Node.js se usa únicamente para pruebas de desarrollo; no se necesita para
ejecutar OptiCast ni para reproducir contenido en las TVs.

## Instalación

Clonar el repositorio o copiar su código a una carpeta del servidor:

```bash
git clone https://github.com/CarlosArguelloDev/OptiCast.git
cd OptiCast
```

En Linux, crear y activar el entorno virtual:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

En Windows, desde PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
```

Si PowerShell impide activar el entorno, usar directamente su ejecutable, por
ejemplo `.\.venv\Scripts\python.exe -m pip install -r requirements.txt`.

Con el entorno activado, instalar las dependencias:

```bash
python -m pip install -r requirements.txt
```

No copiar un entorno virtual de otro equipo: crearlo de nuevo en el servidor
de destino e instalar `requirements.txt`.

## Primera ejecución

En una instalación nueva sin datos anteriores, crear el administrador:

```bash
python -m flask --app app create-admin
```

El comando solicita usuario y contraseña con confirmación. La contraseña debe
tener al menos 10 caracteres. No hay una cuenta ni contraseña predeterminadas.
Si se trasladó una base de datos existente, se conservan sus cuentas y no es
necesario volver a crearlas.

Iniciar el programa desde la carpeta del proyecto:

```bash
python app.py
```

Este comando inicia el servidor incorporado de Flask en `0.0.0.0:5001`, sin modo
de depuración. Un servicio de arranque, como el ejemplo de abajo, administra el
proceso pero no cambia el servidor HTTP.

Abrir el panel desde un equipo de la misma red:

```text
http://IP-DEL-SERVIDOR:5001/login
```

Reemplazar `IP-DEL-SERVIDOR` por la dirección local del equipo que ejecuta OptiCast.
El firewall debe permitir el puerto TCP 5001 en la red local. Conviene mantener
estable esa dirección mediante una reserva DHCP o una configuración equivalente.

El administrador crea una cuenta por departamento en **Configuración →
Departamentos** y confirma los horarios en **Configuración → Turnos**.
Los turnos iniciales 06:00–14:00 y 14:00–22:00 están desactivados y pendientes
de confirmar; establecer sus días y activarlos antes de usarlos.

## Direcciones de las televisiones

| TV | Dirección |
| --- | --- |
| comedor | `http://IP-DEL-SERVIDOR:5001/comedor` |
| crosscutter | `http://IP-DEL-SERVIDOR:5001/crosscutter` |
| extrusion | `http://IP-DEL-SERVIDOR:5001/extrusion` |
| vulcas | `http://IP-DEL-SERVIDOR:5001/vulcas` |
| kalandria | `http://IP-DEL-SERVIDOR:5001/kalandria` |
| confections | `http://IP-DEL-SERVIDOR:5001/confections` |

Las TVs no necesitan usuario, contraseña ni claves en su dirección. El panel sí
requiere iniciar sesión. Las listas, horarios y archivos publicados son accesibles
sin sesión dentro de la red; mantener el servicio en la red local y no publicar
su puerto directamente en Internet.

El administrador también puede consultar las direcciones en **Configuración →
Direcciones de las televisiones**.

## Uso del panel

Las TVs son destinos de publicación, no nombres de departamentos. Cada cuenta
puede publicar en cualquiera de las seis TVs y administra su biblioteca y sus
programaciones. El administrador puede gestionar el contenido de todas las cuentas.

### 1 Archivos

Cargar imágenes o videos en la biblioteca del departamento. Se admiten JPG, JPEG,
PNG, GIF, MP4 y WebM, con un máximo de 64 MB por archivo. Subir un archivo no lo
publica: después hay que agregarlo al carrusel o programarlo.

Las tarjetas permiten **Agregar al carrusel**, **Programar** o **Eliminar archivo**.
Eliminar un archivo también lo retira de todos los carruseles y elimina sus
programaciones.

### 2 Carrusel

Seleccionar una TV para consultar su orden. Elegir un archivo de la biblioteca,
la duración de la imagen en segundos y una o varias TVs de destino; pulsar
**Agregar al carrusel**.

Cada TV tiene un orden y una duración por imagen independientes. Las flechas
permiten mover los archivos propios; **Guardar duración** cambia los segundos
de una imagen. Los videos del carrusel habitual llegan al final, silenciados.
La compatibilidad de video depende de los códecs del navegador de la TV.

Agregar otra vez el mismo archivo a una TV actualiza su duración sin duplicarlo
ni cambiar su posición. **Quitar del carrusel** lo retira únicamente de la TV
seleccionada y conserva el archivo y sus programaciones.

El contenido de otros departamentos aparece como puestos reservados, sin nombres,
vistas previas ni controles de edición para la cuenta actual. Al ordenar los
archivos propios, esos puestos se conservan.

### 3 Avisos y programados

Usar un archivo de la biblioteca o subir uno nuevo directamente. Indicar nombre,
TVs, días, duración y unidad en segundos o minutos. Elegir una de estas opciones:

- **Interrumpir a una hora:** ocupa la pantalla desde la hora indicada durante
  el tiempo configurado y después permite continuar el carrusel. Un video más
  corto puede repetirse dentro del aviso.
- **Agregar durante un intervalo:** alterna el archivo con el carrusel entre
  inicio y fin. La duración indica el tiempo de una imagen por aparición, no
  el tiempo total del intervalo. Puede cruzar medianoche; los días corresponden
  al día de inicio.

Los horarios se repiten en los días seleccionados mientras estén activos. Las
programaciones pueden editarse, pausarse, activarse y eliminarse. Al editarlas,
la duración se expresa en segundos. Para cambiar el tipo de reproducción o el
turno asociado, crear otra programación y pausar o eliminar la anterior.
Eliminar una programación conserva el archivo de la biblioteca.

Subir contenido desde este apartado no lo agrega al carrusel habitual. El campo
**Turno** solo aparece si hay turnos activos. Los horarios usan UTC−06:00,
correspondiente a America/Mexico_City, con el reloj del servidor como referencia;
mantener correcta la fecha y hora del servidor.

La imagen compartida de descanso de `assets/ley-silla.png` está disponible para
programarla. El tiempo de cada aviso se configura en el formulario. No hay
avisos con sonido; los videos permanecen silenciados.

## Datos locales y Git

El repositorio contiene el código, plantillas, pruebas y la imagen compartida de
`assets/ley-silla.png`. Los datos de cada instalación se guardan por separado:

| Ruta | Contenido | Se incluye en Git |
| --- | --- | --- |
| `instance/opticast.sqlite` | Cuentas, turnos, biblioteca, carruseles y programaciones | No |
| `instance/uploads/` | Imágenes y videos cargados desde el panel | No |
| `instance/session.key` | Clave de las sesiones del panel | No |
| `static/NOMBRE/` | Archivos de carruseles heredados | No |
| `entregables/` | Documentos generados, como el manual | No |
| `assets/ley-silla.png` | Imagen compartida incluida con el programa | Sí |

La carpeta `instance/`, la base de datos y la clave de sesiones se crean cuando
son necesarias. No hay que crear las tablas a mano.

Clonar el repositorio en otro equipo **no traslada la configuración ni el contenido**:
una instalación nueva empieza sin las cuentas y publicaciones anteriores. Las
seis TVs funcionan aunque no existan carpetas `static/NOMBRE/`; cuando no tienen
contenido muestran **Sin contenido para esta pantalla**.

Si se copia la base de datos sin sus archivos multimedia, el programa omite esos
archivos en la reproducción. La configuración puede seguir referenciándolos y
sus vistas previas no estarán disponibles. Para conservar una instalación,
trasladar la base de datos y sus archivos juntos.

`.gitignore` evita agregar datos nuevos accidentalmente, pero no deja de seguir
archivos que ya estén versionados. Antes de publicar cambios, revisar
`git status --short` y `git diff --cached --name-only`. Los respaldos y datos
locales se transfieren por fuera del repositorio.

## Respaldar o trasladar una instalación

1. Detener OptiCast antes de copiar los datos, para que la base de datos y los
   archivos correspondan al mismo estado.
2. Copiar `instance/` completo a un respaldo fuera del repositorio. Así se
   conservan cuentas, turnos, orden, duraciones, programaciones, archivos
   subidos y la clave de sesiones.
3. Si se usa contenido heredado, respaldar también `static/` completo.
4. Instalar el código y sus dependencias en el equipo de destino, creando un
   entorno virtual nuevo. Con el programa detenido, restaurar `instance/` junto
   a `app.py` y, si aplica, `static/`.
5. Comprobar que el usuario que ejecuta el programa pueda leer y escribir los
   datos restaurados. Iniciar OptiCast y verificar el acceso al panel y las TVs.
6. Si cambió la dirección del servidor, actualizar las direcciones abiertas en
   las televisiones.

No mezclar parcialmente los datos de dos instalaciones ni sobrescribir una
instalación de destino sin respaldarla. Tratar el respaldo como información
privada, porque incluye cuentas y la clave de sesiones.

## Actualizar una instalación existente

1. Detener el programa y respaldar los datos como se explica arriba.
2. Actualizar todo el código del repositorio en conjunto, incluidas las plantillas
   y los scripts del reproductor. Si se utiliza Git y el checkout no tiene
   cambios pendientes, ejecutar `git pull --ff-only`.
3. Con el entorno virtual activado, ejecutar
   `python -m pip install -r requirements.txt`.
4. Reiniciar el proceso. Las migraciones de SQLite se aplican automáticamente
   al abrir la base de datos; no borrar `instance/` para actualizar.
5. Si cambió el reproductor, abrir de nuevo o recargar una vez la página de cada
   TV con conexión disponible, para que cargue los scripts nuevos.

La migración del carrusel incorpora los destinos publicados anteriormente una
sola vez, conservando su orden anterior por nombre. Al conservar los datos locales
no es necesario recrear cuentas, volver a subir archivos ni rehacer horarios.

## Arranque automático en Linux

En un servidor Linux con systemd, se puede ejecutar el programa como servicio.
El ejemplo usa `.venv/`; adaptar esa ruta si el entorno tiene otro nombre.

Crear `/etc/systemd/system/opticast.service` con este contenido y reemplazar
`USUARIO_DEL_SERVIDOR` y `/RUTA/AL/PROYECTO` por valores reales. Usar rutas
absolutas y un usuario con permisos sobre `instance/`:

```ini
[Unit]
Description=OptiCast carteleria local
After=network.target

[Service]
Type=simple
User=USUARIO_DEL_SERVIDOR
WorkingDirectory=/RUTA/AL/PROYECTO
ExecStart=/RUTA/AL/PROYECTO/.venv/bin/python /RUTA/AL/PROYECTO/app.py
Environment=PYTHONUNBUFFERED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Habilitarlo y consultar su estado:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opticast
systemctl status opticast
journalctl -u opticast -n 100 --no-pager
```

Para respaldar o actualizar, detenerlo con `sudo systemctl stop opticast` y
arrancarlo después con `sudo systemctl start opticast`. No mantener además otra
ejecución manual en el mismo puerto.

## Reproducción y cortes de WiFi

El reproductor no recarga la página automáticamente. Consulta la lista y los
horarios cada 60 segundos; los cambios del carrusel se aplican al terminar el
archivo actual, manteniendo el anterior visible hasta cargar el siguiente.

Si falla una consulta, reintenta a los 30, 60, 120, 240 y hasta 300 segundos.
Cada solicitud tiene un límite de 10 segundos y no se solapa con otra. Al
recuperar la conexión, vuelve a consultar cada minuto. Un fallo de red no borra
la lista ya recibida ni navega a una página de error.

El navegador intenta guardar archivos completos en IndexedDB. No usa Service
Workers ni requiere HTTPS para este almacenamiento. Si el navegador no permite
almacenamiento local, la reproducción sigue dependiendo de la conexión.

Por pantalla se guardan hasta 32 MiB y 24 archivos, con un máximo de 8 MiB por
archivo. El límite de carga del panel de 64 MB es distinto: un archivo aceptado
por el panel puede ser demasiado grande para quedar guardado en la TV. Los
archivos de avisos tienen prioridad frente al carrusel normal. Los límites
están definidos en `templates/cache.js`.

Las descargas son secuenciales y tienen un límite de 30 segundos. Los archivos
incompletos no se guardan. El reproductor mantiene como máximo las referencias
locales del archivo actual y el siguiente, y las libera al cambiar de contenido.
Estos límites acotan los archivos guardados, pero no la memoria necesaria para
decodificar una imagen o un video.

Durante un corte pueden continuar el contenido y los horarios ya recibidos cuyos
archivos estén guardados y sean reproducibles. **La página debe permanecer
abierta**: no se puede abrir ni recargar sin conexión. El navegador puede borrar
sus datos o rechazar almacenamiento; se necesita probar el modelo de TV real.

Cuando se retira todo el contenido de una de las seis TVs, el reproductor recibe
la lista vacía, termina la reproducción actual y muestra **Sin contenido para
esta pantalla**. Un fallo de conexión conserva el contenido recibido previamente.

### Comprobar el almacenamiento en una TV

Agregar `?estado=1` a su dirección, por ejemplo:

```text
http://IP-DEL-SERVIDOR:5001/crosscutter?estado=1
```

El indicador muestra cuántos archivos se han guardado y si falló una consulta.
Esperar a **Contenido guardado** y comprobar el número antes de probar un corte
de WiFi. **Guardado parcial** significa que no se completó toda la selección;
**Almacenamiento local no disponible** indica que se requiere conexión para la
reproducción habitual. Quitar `?estado=1` oculta el indicador.

Si una copia local no se reproduce, se intenta por red y se excluye esa copia
durante la sesión. **Copia local no reproducible** ayuda a identificar el caso.
Una versión nueva del archivo permite intentarlo de nuevo, pero no corrige un
códec incompatible con la TV.

## Archivos heredados

El contenido de `static/NOMBRE/` sigue funcionando y se ordena por nombre al
principio del carrusel. Se administra directamente en el servidor; para
gestionarlo desde las cuentas, subirlo desde el panel y retirar la copia heredada
cuando corresponda, evitando que aparezca dos veces.

La versión de un archivo utiliza su fecha de modificación y tamaño. Al copiar
contenido heredado, usar una extensión temporal, como `.tmp`, y renombrarlo al
terminar para que el reproductor no intente abrir una copia parcial.

## Verificación para desarrollo

Con las dependencias de Python instaladas:

```bash
python -m unittest discover -s tests -p 'test_*.py'
```

Solo para desarrollo, con Node.js instalado:

```bash
node --test tests/player.test.cjs tests/cache.test.cjs tests/schedule.test.cjs
```

En una TV real, comprobar carga, videos, orden y avisos. Esperar la preparación
con `?estado=1`, probar un corte de WiFi de más de 30 minutos y verificar que
continúen varios archivos guardados. Recuperar la conexión y comprobar que reciba
contenido nuevo sin recargar. Hacer también una prueba durante un turno completo.
Las pruebas automáticas no verifican los códecs, la cuota ni la estabilidad del
navegador de una TV Hisense.
