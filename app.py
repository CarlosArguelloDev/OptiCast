from flask import Flask, render_template
import os

app = Flask(__name__)

@app.route("/<pantalla>")
def pantalla(pantalla):
    ruta = os.path.join("static", pantalla)

    if not os.path.exists(ruta):
        return f"La pantalla '{pantalla}' no existe.", 404

    archivos = os.listdir(ruta)

    media = [
        f"{pantalla}/{f}" for f in archivos
        if f.lower().endswith((".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm"))
    ]

    if not media:
        return f"No hay archivos para la pantalla '{pantalla}'.", 404

    return render_template("index.html", media=media)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
