from flask import Flask, render_template
import os

app = Flask(__name__)

@app.route("/")
def index():
    # Leer archivos de la carpeta static
    files = os.listdir("static")
    
    # Filtrar solo imágenes y videos
    allowed = [f for f in files if f.lower().endswith((
        ".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm"
    ))]

    return render_template("index.html", media=allowed)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
