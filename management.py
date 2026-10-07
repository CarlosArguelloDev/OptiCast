"""Panel local: cuentas, archivos privados y programación."""
import functools
import json
import os
import secrets
import sqlite3
import uuid
from pathlib import Path

import click
from flask import Blueprint, abort, current_app, flash, g, redirect, render_template, request, send_file, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

panel = Blueprint("panel", __name__)
SCREENS = ("comedor", "crosscutter", "extrusion", "vulcas", "kalandria", "confections")
WEEKDAYS = ("Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo")


def database():
    if "db" not in g:
        root = Path(current_app.config.get("DATA_DIR", current_app.instance_path))
        root.mkdir(parents=True, exist_ok=True)
        (root / "uploads").mkdir(exist_ok=True)
        g.db = sqlite3.connect(root / "opticast.sqlite", timeout=10)
        g.db.row_factory = sqlite3.Row
        initialized = current_app.extensions.setdefault("opticast_databases", set())
        if str(root) in initialized:
            return g.db
        g.db.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL, admin INTEGER NOT NULL DEFAULT 0);
        CREATE UNIQUE INDEX IF NOT EXISTS one_department_account ON accounts(name) WHERE admin=0;
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY, owner INTEGER, name TEXT NOT NULL, filename TEXT NOT NULL,
            targets TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
            seconds INTEGER NOT NULL DEFAULT 5, builtin INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL, start TEXT NOT NULL,
            end TEXT NOT NULL, days TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS schedules (
            id TEXT PRIMARY KEY, owner INTEGER NOT NULL, asset TEXT NOT NULL,
            title TEXT NOT NULL, targets TEXT NOT NULL, days TEXT NOT NULL,
            start TEXT NOT NULL, end TEXT, seconds INTEGER NOT NULL,
            mode TEXT NOT NULL, shift_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1);
        CREATE TABLE IF NOT EXISTS carousel_items (
            screen TEXT NOT NULL, asset TEXT NOT NULL, position INTEGER NOT NULL,
            seconds INTEGER NOT NULL DEFAULT 5, PRIMARY KEY(screen, asset));
        CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
        """)
        # Importar una sola vez la publicación existente, conservando su orden.
        if not g.db.execute("SELECT 1 FROM migrations WHERE name='carousel_items'").fetchone():
            positions = {screen: 0 for screen in SCREENS}
            for asset in g.db.execute("SELECT * FROM assets WHERE enabled=1 ORDER BY name,id").fetchall():
                for screen in json.loads(asset["targets"]):
                    if screen in positions:
                        g.db.execute("INSERT OR IGNORE INTO carousel_items VALUES(?,?,?,?)",
                                     (screen, asset["id"], positions[screen], asset["seconds"]))
                        positions[screen] += 1
            g.db.execute("INSERT INTO migrations VALUES('carousel_items')")
        if not g.db.execute("SELECT 1 FROM shifts").fetchone():
            g.db.executemany("INSERT INTO shifts(name,start,end,days) VALUES (?,?,?,?)", (
                ("Turno 1 · por confirmar", "06:00", "14:00", "[]"),
                ("Turno 2 · por confirmar", "14:00", "22:00", "[]")))
        g.db.commit()
        initialized.add(str(root))
    return g.db


def root_dir():
    return Path(current_app.config.get("DATA_DIR", current_app.instance_path))


def current_user():
    return database().execute("SELECT * FROM accounts WHERE id=?", (session.get("account"),)).fetchone()


def csrf():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(24)
    return session["csrf"]


def protected(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        user = current_user()
        if user is None:
            return redirect(url_for("panel.login"))
        if request.method == "POST" and not secrets.compare_digest(request.form.get("csrf", ""), csrf()):
            abort(400)
        return fn(user, *args, **kwargs)
    return wrapper


def owned_asset(user, asset_id):
    row = database().execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    if not row or (not user["admin"] and row["owner"] != user["id"] and not row["builtin"]):
        abort(404)
    return row


def selection(name, allowed):
    values = request.form.getlist(name)
    if not values or any(value not in allowed for value in values):
        raise ValueError("Selecciona al menos una opción válida.")
    return json.dumps(sorted(set(values)))


def clock(value):
    parts = value.split(":")
    if len(parts) != 2 or not all(x.isdigit() for x in parts):
        raise ValueError("Indica una hora válida.")
    hour, minute = map(int, parts)
    if not 0 <= hour < 24 or not 0 <= minute < 60:
        raise ValueError("Indica una hora válida.")
    return f"{hour:02}:{minute:02}"


def number(value, low, high):
    try:
        result = int(value)
    except (ValueError, TypeError):
        raise ValueError("Indica una duración válida.")
    if not low <= result <= high:
        raise ValueError(f"La duración debe estar entre {low} y {high} segundos.")
    return result


@panel.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        if not secrets.compare_digest(request.form.get("csrf", ""), csrf()):
            abort(400)
        user = database().execute("SELECT * FROM accounts WHERE username=?", (request.form.get("username", "").strip(),)).fetchone()
        if user and check_password_hash(user["password"], request.form.get("password", "")):
            session.clear()
            session["account"] = user["id"]
            return redirect(url_for("panel.home"))
        flash("Usuario o contraseña incorrectos.", "error")
    return render_template("login.html", csrf=csrf())


@panel.post("/logout")
@protected
def logout(user):
    session.clear()
    return redirect(url_for("panel.login"))


@panel.get("/panel")
@protected
def home(user):
    db = database()
    assets = db.execute("SELECT * FROM assets WHERE owner=? OR builtin=1 OR ?=1 ORDER BY name", (user["id"], user["admin"])).fetchall()
    schedules = db.execute("SELECT s.*, a.name AS asset_name FROM schedules s JOIN assets a ON a.id=s.asset WHERE s.owner=? OR ?=1 ORDER BY s.start", (user["id"], user["admin"])).fetchall()
    view = request.args.get("view", "files")
    if view not in ("files", "carousel", "scheduled", "settings"):
        view = "files"
    if view == "settings" and not user["admin"]:
        abort(403)
    screen = request.args.get("screen", SCREENS[0])
    if screen not in SCREENS:
        abort(404)
    rows = db.execute("SELECT c.*,a.name,a.filename,a.owner,a.builtin FROM carousel_items c JOIN assets a ON a.id=c.asset WHERE c.screen=? ORDER BY c.position,c.asset", (screen,)).fetchall()
    rows = [row for row in rows if asset_path(row).is_file()]
    editable = [row["asset"] for row in rows if user["admin"] or row["owner"] == user["id"]]
    legacy_root = Path(current_app.static_folder) / screen
    legacy = [name for name in sorted(os.listdir(legacy_root))
              if Path(name).suffix.lower() in (".jpg", ".jpeg", ".png", ".gif", ".mp4", ".webm")
              and (legacy_root / name).is_file()] if legacy_root.is_dir() else []
    return render_template("panel.html", user=user, assets=assets, schedules=schedules,
                           view=view, screen=screen, carousel=rows, editable=editable, legacy=legacy,
                           selected_asset=request.args.get("asset", ""),
                           shifts=db.execute("SELECT * FROM shifts").fetchall(),
                           accounts=db.execute("SELECT id,name,username FROM accounts").fetchall() if user["admin"] else [],
                           screens=[{"name": n} for n in SCREENS],
                           weekdays=WEEKDAYS, csrf=csrf(), loads=json.loads)


@panel.post("/panel/accounts")
@protected
def add_account(user):
    if not user["admin"]:
        abort(403)
    name = request.form.get("name", "").strip()[:100]
    username = request.form.get("username", "").strip()[:60]
    password = request.form.get("password", "")
    if not name or not username or len(password) < 10:
        flash("Indica departamento, usuario y contraseña de al menos 10 caracteres.", "error")
    else:
        try:
            if database().execute("SELECT 1 FROM accounts WHERE name=?", (name,)).fetchone():
                flash("Ese departamento ya tiene una cuenta.", "error")
                return redirect(url_for("panel.home", view="settings", _anchor="cuentas"))
            database().execute("INSERT INTO accounts(name,username,password) VALUES(?,?,?)", (name, username, generate_password_hash(password)))
            database().commit()
            flash("Cuenta de departamento creada.", "success")
        except sqlite3.IntegrityError:
            flash("Ese usuario ya existe.", "error")
    return redirect(url_for("panel.home", view="settings", _anchor="cuentas"))


@panel.post("/panel/upload")
@protected
def upload(user):
    if request.form.get("intent") == "scheduled" and request.form.get("source") == "existing":
        return add_schedule.__wrapped__(user)
    try:
        scheduled = request.form.get("intent") == "scheduled"
        targets = selection("targets", SCREENS) if scheduled else "[]"
        seconds = duration() if scheduled else 5
        file = request.files.get("file")
        if not file or not file.filename:
            raise ValueError("Selecciona un archivo.")
        original = secure_filename(file.filename)
        suffix = Path(original).suffix.lower()
        head = file.stream.read(32)
        file.stream.seek(0)
        signatures = {
            ".jpg": head.startswith(b"\xff\xd8\xff"), ".jpeg": head.startswith(b"\xff\xd8\xff"),
            ".png": head.startswith(b"\x89PNG\r\n\x1a\n"), ".gif": head.startswith((b"GIF87a", b"GIF89a")),
            ".mp4": len(head) >= 12 and head[4:8] == b"ftyp", ".webm": head.startswith(b"\x1aE\xdf\xa3")}
        if not signatures.get(suffix):
            raise ValueError("El archivo no tiene un formato de imagen o video admitido.")
        asset_id = uuid.uuid4().hex
        filename = asset_id + suffix
        destination = root_dir() / "uploads" / filename
        temp = destination.with_suffix(".tmp")
        try:
            file.save(temp)
            os.replace(temp, destination)
            database().execute("INSERT INTO assets(id,owner,name,filename,targets,seconds,enabled) VALUES(?,?,?,?,?,?,?)",
                               (asset_id, user["id"], (request.form.get("name", "").strip() or request.form.get("title", "").strip())[:120] or original,
                                filename, targets, seconds, 0))
            if scheduled:
                insert_program(user, owned_asset(user, asset_id))
            database().commit()
        except Exception:
            database().rollback()
            temp.unlink(missing_ok=True)
            destination.unlink(missing_ok=True)
            raise
        flash("Aviso guardado." if scheduled else "Archivo guardado en tu biblioteca.", "success")
    except ValueError as error:
        flash(str(error), "error")
    return redirect(url_for("panel.home", view="scheduled" if request.form.get("intent") == "scheduled" else "files"))


@panel.post("/panel/carousel")
@protected
def add_carousel(user):
    asset = owned_asset(user, request.form.get("asset"))
    if asset["builtin"] and not user["admin"]:
        abort(403)
    try:
        targets = json.loads(selection("targets", SCREENS))
        seconds = duration()
        db = database()
        db.execute("BEGIN IMMEDIATE")
        for screen in targets:
            position = db.execute("SELECT COALESCE(MAX(position),-1)+1 FROM carousel_items WHERE screen=?", (screen,)).fetchone()[0]
            db.execute("INSERT INTO carousel_items VALUES(?,?,?,?) ON CONFLICT(screen,asset) DO UPDATE SET seconds=excluded.seconds",
                       (screen, asset["id"], position, seconds))
        db.commit()
        flash("Archivo agregado al carrusel.", "success")
    except ValueError as error:
        flash(str(error), "error")
    return redirect(url_for("panel.home", view="carousel", screen=request.form.get("screen", SCREENS[0])))


@panel.post("/panel/carousel/<screen>/<asset_id>")
@protected
def update_carousel(user, screen, asset_id):
    if screen not in SCREENS:
        abort(404)
    owned_asset(user, asset_id)
    db = database()
    db.execute("BEGIN IMMEDIATE")
    row = db.execute("SELECT c.*,a.owner FROM carousel_items c JOIN assets a ON a.id=c.asset WHERE c.screen=? AND c.asset=?", (screen, asset_id)).fetchone()
    if not row or (not user["admin"] and row["owner"] != user["id"]):
        abort(404)
    action = request.form.get("action")
    if action == "remove":
        db.execute("DELETE FROM carousel_items WHERE screen=? AND asset=?", (screen, asset_id))
        flash("Archivo retirado de esta TV. Sigue en tu biblioteca.", "success")
    elif action in ("up", "down"):
        # Reordenar únicamente los puestos propios; otros departamentos conservan sus puestos.
        comparison, direction = ("<", "DESC") if action == "up" else (">", "ASC")
        other = db.execute(f"SELECT c.asset,c.position FROM carousel_items c JOIN assets a ON a.id=c.asset WHERE c.screen=? AND c.position {comparison} ? AND (a.owner=? OR ?=1) ORDER BY c.position {direction},c.asset LIMIT 1",
                           (screen, row["position"], user["id"], user["admin"])).fetchone()
        if other:
            db.execute("UPDATE carousel_items SET position=? WHERE screen=? AND asset=?", (other["position"], screen, asset_id))
            db.execute("UPDATE carousel_items SET position=? WHERE screen=? AND asset=?", (row["position"], screen, other["asset"]))
    elif action == "save":
        try:
            seconds = duration()
            db.execute("UPDATE carousel_items SET seconds=? WHERE screen=? AND asset=?", (seconds, screen, asset_id))
            flash("Duración guardada.", "success")
        except ValueError as error:
            flash(str(error), "error")
    else:
        abort(400)
    db.commit()
    return redirect(url_for("panel.home", view="carousel", screen=screen))


@panel.post("/panel/assets/<asset_id>")
@protected
def update_asset(user, asset_id):
    row = owned_asset(user, asset_id)
    if row["builtin"]:
        abort(403)
    try:
        if request.form.get("action") == "delete":
            database().execute("DELETE FROM carousel_items WHERE asset=?", (asset_id,))
            database().execute("DELETE FROM schedules WHERE asset=?", (asset_id,))
            database().execute("DELETE FROM assets WHERE id=?", (asset_id,))
            database().commit()
            (root_dir() / "uploads" / row["filename"]).unlink(missing_ok=True)
            flash("Archivo eliminado.", "success")
        else:
            targets = selection("targets", SCREENS)
            seconds = number(request.form.get("seconds"), 1, 28800)
            database().execute("UPDATE assets SET targets=?,seconds=?,enabled=? WHERE id=?",
                               (targets, seconds, int(bool(request.form.get("enabled"))), asset_id))
            database().execute("DELETE FROM carousel_items WHERE asset=?", (asset_id,))
            if request.form.get("enabled"):
                for screen in json.loads(targets):
                    position = database().execute("SELECT COALESCE(MAX(position),-1)+1 FROM carousel_items WHERE screen=?", (screen,)).fetchone()[0]
                    database().execute("INSERT INTO carousel_items VALUES(?,?,?,?)", (screen, asset_id, position, seconds))
            database().commit()
            flash("Contenido actualizado.", "success")
    except ValueError as error:
        flash(str(error), "error")
    return redirect(url_for("panel.home", view="files"))


@panel.post("/panel/schedules")
@protected
def add_schedule(user):
    try:
        asset = owned_asset(user, request.form.get("asset"))
        insert_program(user, asset)
        database().commit()
        flash("Programación guardada.", "success")
    except ValueError as error:
        flash(str(error), "error")
    return redirect(url_for("panel.home", view="scheduled"))


def duration():
    value = number(request.form.get("seconds"), 1, 28800)
    if request.form.get("unit") == "minutes":
        value *= 60
    if value > 28800:
        raise ValueError("La duración máxima es de 8 horas.")
    return value


def insert_program(user, asset):
    targets = selection("targets", SCREENS)
    days = selection("days", tuple(str(n) for n in range(7)))
    mode = request.form.get("mode")
    if mode not in ("moment", "window"):
        raise ValueError("Selecciona un tipo de programación.")
    start = clock(request.form.get("start", ""))
    end = clock(request.form.get("end", "")) if mode == "window" else None
    if start == end:
        raise ValueError("El inicio y fin del intervalo deben ser diferentes.")
    seconds = duration()
    shift_id = request.form.get("shift") or None
    if shift_id and not database().execute("SELECT 1 FROM shifts WHERE id=? AND enabled=1", (shift_id,)).fetchone():
        raise ValueError("El turno aún no está confirmado y activo.")
    title = request.form.get("title", "").strip()[:120] or asset["name"]
    database().execute("INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
        uuid.uuid4().hex, user["id"], asset["id"], title, targets, days, start, end,
        seconds, mode, shift_id, 1))


@panel.post("/panel/schedules/<schedule_id>")
@protected
def update_schedule(user, schedule_id):
    row = database().execute("SELECT * FROM schedules WHERE id=? AND (owner=? OR ?=1)", (schedule_id, user["id"], user["admin"])).fetchone()
    if not row:
        abort(404)
    if request.form.get("action") == "delete":
        database().execute("DELETE FROM schedules WHERE id=?", (schedule_id,))
    elif request.form.get("action") == "save":
        try:
            targets = selection("targets", SCREENS)
            days = selection("days", tuple(str(n) for n in range(7)))
            start = clock(request.form.get("start", ""))
            end = clock(request.form.get("end", "")) if row["mode"] == "window" else None
            if start == end:
                raise ValueError("El inicio y fin deben ser diferentes.")
            seconds = duration()
            database().execute("UPDATE schedules SET targets=?,days=?,start=?,end=?,seconds=? WHERE id=?", (targets, days, start, end, seconds, schedule_id))
        except ValueError as error:
            flash(str(error), "error")
    else:
        database().execute("UPDATE schedules SET enabled=? WHERE id=?", (int(not row["enabled"]), schedule_id))
    database().commit()
    return redirect(url_for("panel.home", view="scheduled"))


@panel.post("/panel/shifts/<int:shift_id>")
@protected
def update_shift(user, shift_id):
    if not user["admin"]:
        abort(403)
    try:
        days = selection("days", tuple(str(n) for n in range(7)))
        start, end = clock(request.form.get("start", "")), clock(request.form.get("end", ""))
        if start == end:
            raise ValueError("El inicio y fin deben ser diferentes.")
        database().execute("UPDATE shifts SET name=?,start=?,end=?,days=?,enabled=? WHERE id=?", (
            request.form.get("name", "Turno").strip()[:100], start, end, days,
            int(bool(request.form.get("enabled"))), shift_id))
        database().commit()
        flash("Turno actualizado.", "success")
    except ValueError as error:
        flash(str(error), "error")
    return redirect(url_for("panel.home", view="settings", _anchor="turnos"))


def asset_path(row):
    if row["builtin"]:
        return Path(current_app.root_path) / "assets" / row["filename"]
    return root_dir() / "uploads" / row["filename"]


@panel.get("/media/<asset_id>")
def asset_file(asset_id):
    row = database().execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
    if not row:
        abort(404)
    user = current_user()
    allowed = user and (user["admin"] or row["owner"] == user["id"] or row["builtin"])
    if not allowed:
        # Los archivos publicados en los carruseles se reproducen sin sesión ni clave.
        assigned = database().execute("SELECT 1 FROM carousel_items WHERE asset=? LIMIT 1", (asset_id,)).fetchone()
        scheduled = database().execute("SELECT 1 FROM schedules WHERE asset=? AND enabled=1 LIMIT 1", (asset_id,)).fetchone()
        allowed = row["builtin"] or assigned or scheduled
    if not allowed:
        abort(404)
    path = asset_path(row)
    if not path.is_file():
        abort(404)
    return send_file(path, conditional=True, max_age=86400)


def managed_manifest(screen):
    """Reproducción pública para las TVs; la administración usa cuentas."""
    if screen not in SCREENS:
        return {"media": [], "schedules": [], "shifts": []}
    db = database()
    records = {}
    entries = []
    programs = []
    for row in db.execute("SELECT * FROM assets ORDER BY name, id"):
        path = asset_path(row)
        if not path.is_file():
            continue
        stat = path.stat()
        item = {"file": "managed/" + row["filename"], "version": f"{stat.st_mtime_ns:x}-{stat.st_size:x}",
                "size": stat.st_size, "seconds": row["seconds"],
                "url": url_for("panel.asset_file", asset_id=row["id"])}
        records[row["id"]] = item
    for row in db.execute("SELECT asset,seconds FROM carousel_items WHERE screen=? ORDER BY position,asset", (screen,)):
        if row["asset"] in records:
            entries.append({**records[row["asset"]], "seconds": row["seconds"]})
    for row in db.execute("SELECT * FROM schedules WHERE enabled=1 ORDER BY id"):
        if screen in json.loads(row["targets"]) and row["asset"] in records:
            programs.append({"id": row["id"], "media": records[row["asset"]], "days": json.loads(row["days"]),
                             "start": row["start"], "end": row["end"], "seconds": row["seconds"],
                             "mode": row["mode"], "shift": row["shift_id"],
                             "priority": 100 if row["asset"] == "ley-silla" else 10})
    shifts = [dict(row) for row in db.execute("SELECT * FROM shifts WHERE enabled=1")]
    for shift in shifts:
        shift["days"] = json.loads(shift["days"])
    return {"media": entries, "schedules": programs, "shifts": shifts}


def init_management(app):
    app.register_blueprint(panel)
    app.config.setdefault("MAX_CONTENT_LENGTH", 64 * 1024 * 1024)
    if app.config["MAX_CONTENT_LENGTH"] is None:
        app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024
    # Debe existir antes de que Flask abra la primera sesión.
    if not app.secret_key:
        root = Path(app.config.get("DATA_DIR", app.instance_path))
        root.mkdir(parents=True, exist_ok=True)
        key_file = root / "session.key"
        try:
            descriptor = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as file:
                file.write(secrets.token_hex(32))
        except FileExistsError:
            pass
        app.secret_key = key_file.read_text()

    @app.teardown_appcontext
    def close_db(error):
        db = g.pop("db", None)
        if db:
            db.close()

    @app.cli.command("create-admin")
    @click.option("--username", prompt="Usuario administrador")
    @click.password_option(confirmation_prompt=True)
    def create_admin(username, password):
        if len(password) < 10:
            raise click.ClickException("La contraseña debe tener al menos 10 caracteres.")
        db = database()
        try:
            db.execute("INSERT INTO accounts(name,username,password,admin) VALUES(?,?,?,1)",
                       ("Administración", username, generate_password_hash(password)))
            db.commit()
        except sqlite3.IntegrityError:
            raise click.ClickException("El usuario ya existe.")
        click.echo("Administrador creado. Abre /login.")

    @app.before_request
    def secret_and_builtin():
        image = Path(app.root_path) / "assets" / "ley-silla.png"
        initialized = app.extensions.setdefault("opticast_builtins", set())
        data_path = str(root_dir())
        if image.is_file() and data_path not in initialized:
            db = database()
            db.execute("INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?,?,?)", (
                "ley-silla", None, "Ley Silla · descanso sentado", "ley-silla.png", "[]", 0, 5, 1))
            db.commit()
            initialized.add(data_path)
