from flask import Flask, jsonify, make_response, render_template, request, url_for
import hashlib
import json
import os

app = Flask(__name__)
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 86400

def manifest_for(pantalla):
    # Solo carpetas directas de static; independiente del directorio de arranque.
    if pantalla in (".", "..") or "/" in pantalla or "\\" in pantalla:
        return None
    ruta = os.path.join(app.static_folder, pantalla)

    if not os.path.isdir(ruta):
        return None
    media = []
    for nombre in sorted(os.listdir(ruta)):
        if not nombre.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm")):
            continue
        archivo = os.path.join(ruta, nombre)
        try:
            if not os.path.isfile(archivo):
                continue
            stat = os.stat(archivo)
        except FileNotFoundError:
            # Puede desaparecer mientras se actualiza la carpeta.
            continue
        media.append({"file": f"{pantalla}/{nombre}",
                      "size": stat.st_size,
                      "version": f"{stat.st_mtime_ns:x}-{stat.st_size:x}"})
    version = hashlib.sha256(json.dumps(media, sort_keys=True).encode()).hexdigest()
    return {"media": media, "version": version}


@app.route("/api/pantallas/<pantalla>/media")
def pantalla_media(pantalla):
    manifest = manifest_for(pantalla)
    if manifest is None:
        response = make_response(jsonify(error="Pantalla no disponible"), 404)
    else:
        response = make_response("", 304) if request.if_none_match.contains(manifest["version"]) else jsonify(manifest)
        response.set_etag(manifest["version"])
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/<pantalla>")
def pantalla(pantalla):
    manifest = manifest_for(pantalla)
    if manifest is None:
        return f"La pantalla '{pantalla}' no existe.", 404
    # Una carpeta vacía puede recibir contenido sin recargar la página.
    response = make_response(render_template(
        "index.html", manifest=manifest,
        manifest_url=url_for("pantalla_media", pantalla=pantalla)))
    response.headers["Cache-Control"] = "no-store"
    return response

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
