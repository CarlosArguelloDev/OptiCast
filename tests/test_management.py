import io
import json
import tempfile
import unittest
from pathlib import Path

from app import app
from management import database
from werkzeug.security import generate_password_hash


class ManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.saved = {key: app.config.get(key) for key in ("DATA_DIR", "SECRET_KEY", "TESTING")}
        app.config.update(DATA_DIR=self.temp.name, SECRET_KEY="test-only", TESTING=True)
        with app.app_context():
            db = database()
            for name, admin in (("admin", 1), ("rh", 0), ("calidad", 0)):
                db.execute("INSERT INTO accounts(name,username,password,admin) VALUES(?,?,?,?)", (name, name, generate_password_hash("password-test"), admin))
            db.commit()
        self.client = app.test_client()
        self.as_user(2)

    def tearDown(self):
        app.config.update(self.saved)
        self.temp.cleanup()

    def as_user(self, user):
        with self.client.session_transaction() as session:
            session["account"] = user
            session["csrf"] = "test-csrf"

    def upload(self, publish=True, **extra):
        data = {"csrf": "test-csrf", "file": (io.BytesIO(b"\x89PNG\r\n\x1a\n" + b"fake-payload"), "file.png"),
                "name": "Aviso RH", "targets": ["comedor", "extrusion"], "seconds": "10", "mode": "normal", **extra}
        if data["mode"] != "normal":
            data["intent"] = "scheduled"
        response = self.client.post("/panel/upload", data=data, content_type="multipart/form-data")
        if publish and data["mode"] == "normal":
            self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": self.asset_id(),
                             "targets": data["targets"], "seconds": data["seconds"]})
        return response

    def asset_id(self):
        with app.app_context():
            return database().execute("SELECT id FROM assets WHERE owner=2").fetchone()[0]

    def test_upload_privacy_and_destinations(self):
        self.assertEqual(self.upload().status_code, 302)
        asset = self.asset_id()
        with self.client.get(f"/media/{asset}") as response:
            self.assertEqual(response.status_code, 200)
        self.as_user(3)
        with self.client.get(f"/media/{asset}") as response:
            self.assertEqual(response.status_code, 200)
        self.assertNotIn("Aviso RH", self.client.get("/panel").text)
        self.assertEqual(self.client.post(f"/panel/assets/{asset}", data={"csrf": "test-csrf", "action": "delete"}).status_code, 404)
        self.client = app.test_client()
        with self.client.get(f"/media/{asset}") as response:
            self.assertEqual(response.status_code, 200)
        public = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(len(public["media"]), 1)
        self.assertNotIn("key=", public["media"][0]["url"])
        self.assertEqual(self.client.get("/comedor").status_code, 200)
        self.assertEqual(self.client.get("/api/pantallas/vulcas/media").json["media"], [])
        self.assertEqual(self.client.get("/panel").status_code, 302)

    def test_schedule_from_upload_minutes_and_disabled_turns(self):
        self.upload(mode="moment", start="08:00", days=["0", "1"], seconds="10", unit="minutes")
        self.client = app.test_client()
        linked = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(linked["media"], [])
        self.assertEqual(linked["schedules"][0]["seconds"], 600)
        self.assertNotIn("key=", linked["schedules"][0]["media"]["url"])
        with self.client.get(linked["schedules"][0]["media"]["url"]) as response:
            self.assertEqual(response.status_code, 200)
        self.assertEqual(linked["shifts"], [])
        self.as_user(2)
        self.assertEqual(len(self.client.get("/panel").data) > 1000, True)

    def test_bad_schedule_rolls_back_upload(self):
        self.upload(mode="moment", start="25:00", days=["0"])
        with app.app_context():
            self.assertEqual(database().execute("SELECT COUNT(*) FROM assets WHERE owner=2").fetchone()[0], 0)
        self.assertEqual(list((Path(self.temp.name) / "uploads").iterdir()), [])

    def test_csrf_admin_and_invalid_upload(self):
        self.assertEqual(self.client.post("/panel/accounts", data={"csrf": "test-csrf"}).status_code, 403)
        self.assertEqual(self.client.post("/panel/upload", data={"csrf": "bad"}).status_code, 400)
        self.client.post("/panel/upload", data={"csrf": "test-csrf", "targets": "comedor", "seconds": "5", "file": (io.BytesIO(b"<script>"), "bad.png")})
        with app.app_context():
            self.assertEqual(database().execute("SELECT COUNT(*) FROM assets WHERE owner=2").fetchone()[0], 0)

    def test_login_and_admin_panel(self):
        self.client = app.test_client()
        self.assertEqual(self.client.get("/panel").status_code, 302)
        page = self.client.get("/login")
        self.assertEqual(page.status_code, 200)
        with self.client.session_transaction() as session:
            token = session["csrf"]
        self.client.post("/login", data={"csrf": token, "username": "admin", "password": "password-test"})
        page = self.client.get("/panel?view=settings")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Direcciones de las televisiones", page.text)
        self.assertNotIn("?key=", page.text)
        self.assertIn("Turno 1", page.text)

    def test_unpublished_asset_remains_private_in_panel(self):
        self.upload(publish=False)
        asset = self.asset_id()
        self.client = app.test_client()
        self.assertEqual(self.client.get(f"/media/{asset}").status_code, 404)
        self.assertEqual(self.client.get("/api/pantallas/comedor/media").json["media"], [])

    def test_upload_is_separate_from_publication_and_views_are_separate(self):
        self.upload(publish=False)
        asset = self.asset_id()
        self.assertEqual(self.client.get("/api/pantallas/comedor/media").json["media"], [])
        files = self.client.get("/panel").text
        self.assertIn("Cargar archivo", files)
        self.assertNotIn("Publica hoy", files)
        self.assertNotIn("Toma tu descanso", files)
        self.assertNotIn("Crear programación", files)
        self.assertNotIn("flask --app", self.client.get("/login").text)
        self.assertNotIn("Cargar archivo", self.client.get("/panel?view=carousel").text)
        self.assertIn("Crear programación", self.client.get("/panel?view=scheduled").text)
        self.assertEqual(self.client.get("/panel?view=settings").status_code, 403)
        self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": asset, "targets": "comedor", "seconds": "12"})
        manifest = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(manifest["media"][0]["seconds"], 12)
        with self.client.get(f"/media/{asset}") as response:
            self.assertEqual(response.status_code, 200)

    def test_carousel_order_destinations_duplicate_and_remove_without_deleting(self):
        self.upload(publish=False, name="Z primero")
        first = self.asset_id()
        self.upload(publish=False, name="A segundo")
        with app.app_context():
            second = database().execute("SELECT id FROM assets WHERE name='A segundo'").fetchone()[0]
        for asset in (first, second):
            self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": asset,
                             "targets": ["comedor", "extrusion"], "seconds": "7"})
        manifest = self.client.get("/api/pantallas/comedor/media")
        self.assertEqual([x["url"] for x in manifest.json["media"]], [f"/media/{first}", f"/media/{second}"])
        self.client.post(f"/panel/carousel/comedor/{second}", data={"csrf": "test-csrf", "action": "up"})
        reordered = self.client.get("/api/pantallas/comedor/media")
        self.assertNotEqual(manifest.headers['ETag'], reordered.headers['ETag'])
        self.assertEqual([x["url"] for x in reordered.json["media"]], [f"/media/{second}", f"/media/{first}"])
        self.assertEqual(self.client.get("/api/pantallas/extrusion/media").json["media"][0]["url"], f"/media/{first}")
        self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": second, "targets": "comedor", "seconds": "9"})
        same = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(len(same["media"]), 2)
        self.assertEqual(same["media"][0]["url"], f"/media/{second}")
        self.client.post("/panel/schedules", data={"csrf": "test-csrf", "asset": second, "targets": "comedor",
                         "mode": "moment", "days": "0", "start": "08:00", "seconds": "10"})
        self.client.post(f"/panel/carousel/comedor/{second}", data={"csrf": "test-csrf", "action": "remove"})
        remaining = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(len(remaining["media"]), 1)
        self.assertEqual(len(remaining["schedules"]), 1)
        self.assertIn("A segundo", self.client.get("/panel").text)
        self.assertEqual(len(self.client.get("/api/pantallas/extrusion/media").json["media"]), 2)

    def test_other_department_positions_and_files_are_private(self):
        self.upload(name="Primer RH")
        first = self.asset_id()
        self.as_user(3)
        self.upload(publish=False, name="Confidencial Calidad")
        with app.app_context():
            other = database().execute("SELECT id FROM assets WHERE owner=3").fetchone()[0]
        self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": other, "targets": "comedor", "seconds": "5"})
        self.as_user(2)
        self.upload(publish=False, name="Último RH")
        with app.app_context():
            last = database().execute("SELECT id FROM assets WHERE name='Último RH'").fetchone()[0]
        self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": last, "targets": "comedor", "seconds": "5"})
        page = self.client.get("/panel?view=carousel").text
        self.assertNotIn("Confidencial Calidad", page)
        self.assertNotIn(f"/media/{other}", page)
        self.assertIn("Contenido de otro departamento", page)
        self.assertEqual(self.client.post(f"/panel/carousel/comedor/{other}", data={"csrf": "test-csrf", "action": "remove"}).status_code, 404)
        self.client.post(f"/panel/carousel/comedor/{last}", data={"csrf": "test-csrf", "action": "up"})
        self.assertEqual([x["url"] for x in self.client.get("/api/pantallas/comedor/media").json["media"]],
                         [f"/media/{last}", f"/media/{other}", f"/media/{first}"])
        self.assertEqual(self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": other, "targets": "comedor", "seconds": "5"}).status_code, 404)

    def test_old_carousels_migrate_once_and_removals_survive_restart(self):
        self.upload(publish=False)
        asset = self.asset_id()
        with app.app_context():
            db = database()
            db.execute("UPDATE assets SET targets=?,enabled=1,seconds=11 WHERE id=?", (json.dumps(["vulcas"]), asset))
            db.execute("DELETE FROM migrations WHERE name='carousel_items'")
            db.commit()
        app.extensions["opticast_databases"].discard(self.temp.name)
        manifest = self.client.get("/api/pantallas/vulcas/media").json
        self.assertEqual(manifest["media"][0]["seconds"], 11)
        self.client.post(f"/panel/carousel/vulcas/{asset}", data={"csrf": "test-csrf", "action": "remove"})
        app.extensions["opticast_databases"].discard(self.temp.name)
        self.assertEqual(self.client.get("/api/pantallas/vulcas/media").json["media"], [])

    def test_scheduled_existing_and_library_delete_cleanup(self):
        self.upload(publish=False)
        asset = self.asset_id()
        self.client.post("/panel/upload", data={"csrf": "test-csrf", "intent": "scheduled", "source": "existing",
                         "asset": asset, "targets": "comedor", "mode": "window", "days": "0",
                         "start": "09:00", "end": "11:00", "seconds": "15"})
        manifest = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(manifest["media"], [])
        self.assertEqual(manifest["schedules"][0]["mode"], "window")
        self.client.post("/panel/carousel", data={"csrf": "test-csrf", "asset": asset, "targets": "comedor", "seconds": "5"})
        self.client.post(f"/panel/assets/{asset}", data={"csrf": "test-csrf", "action": "delete"})
        manifest = self.client.get("/api/pantallas/comedor/media").json
        self.assertEqual(manifest["media"], [])
        self.assertEqual(manifest["schedules"], [])
        self.assertEqual(list((Path(self.temp.name)/"uploads").iterdir()), [])

    def test_schedule_edit_and_other_department_cannot_edit(self):
        self.upload(mode="moment", start="08:00", days=["0"], seconds="10")
        with app.app_context():
            schedule_id = database().execute("SELECT id FROM schedules").fetchone()[0]
        self.as_user(3)
        self.assertEqual(self.client.post(f"/panel/schedules/{schedule_id}", data={"csrf": "test-csrf"}).status_code, 404)
        self.as_user(2)
        self.client.post(f"/panel/schedules/{schedule_id}", data={"csrf": "test-csrf", "action": "save", "targets": "vulcas", "days": "2", "start": "09:00", "seconds": "15", "unit": "minutes"})
        with app.app_context():
            row = database().execute("SELECT * FROM schedules WHERE id=?", (schedule_id,)).fetchone()
            self.assertEqual(row["seconds"], 900)
            self.assertEqual(row["start"], "09:00")
            self.assertEqual(json.loads(row["targets"]), ["vulcas"])

    def test_confirmed_shift_and_one_account_per_department(self):
        self.as_user(1)
        self.client.post("/panel/shifts/1", data={"csrf": "test-csrf", "name": "Mañana", "start": "06:00", "end": "14:00", "days": ["0", "1"], "enabled": "on"})
        with app.app_context():
            self.assertEqual(database().execute("SELECT enabled FROM shifts WHERE id=1").fetchone()[0], 1)
        data = {"csrf": "test-csrf", "name": "Calidad nueva", "username": "nuevo", "password": "password-test"}
        self.client.post("/panel/accounts", data=data)
        self.client.post("/panel/accounts", data={**data, "username": "duplicado"})
        with app.app_context():
            self.assertEqual(database().execute("SELECT COUNT(*) FROM accounts WHERE name='Calidad nueva'").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
