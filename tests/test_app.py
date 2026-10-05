import os
from pathlib import Path
import tempfile
import unittest

from app import app


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.original_static = app.static_folder
        self.original_data = app.config.get("DATA_DIR")
        app.config["DATA_DIR"] = self.directory.name
        app.static_folder = self.directory.name
        self.screen = Path(self.directory.name) / "screen"
        self.screen.mkdir()
        self.client = app.test_client()

    def tearDown(self):
        app.static_folder = self.original_static
        if self.original_data is None:
            app.config.pop("DATA_DIR", None)
        else:
            app.config["DATA_DIR"] = self.original_data
        self.directory.cleanup()

    def test_changes_and_conditional_requests(self):
        (self.screen / "b.jpg").write_bytes(b"first")
        (self.screen / "a.mp4").write_bytes(b"video")
        (self.screen / "ignored.txt").write_text("skip")
        (self.screen / "folder.jpg").mkdir()
        first = self.client.get("/api/pantallas/screen/media")
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.headers["Cache-Control"], "no-store")
        self.assertEqual([m["file"] for m in first.json["media"]], ["screen/a.mp4", "screen/b.jpg"])
        self.assertEqual([m["size"] for m in first.json["media"]], [5, 5])
        etag = first.headers["ETag"]
        unchanged = self.client.get("/api/pantallas/screen/media", headers={"If-None-Match": etag})
        self.assertEqual(unchanged.status_code, 304)
        self.assertEqual(unchanged.data, b"")
        old_video_version = first.json["media"][0]["version"]
        (self.screen / "b.jpg").write_bytes(b"replacement is larger")
        changed = self.client.get("/api/pantallas/screen/media", headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.json["version"], first.json["version"])
        self.assertEqual(changed.json["media"][0]["version"], old_video_version)
        (self.screen / "a.mp4").unlink()
        self.assertEqual(len(self.client.get("/api/pantallas/screen/media").json["media"]), 1)

    def test_empty_missing_and_rendered_page(self):
        self.assertEqual(self.client.get("/api/pantallas/missing/media").status_code, 404)
        self.assertEqual(self.client.get("/api/pantallas/screen/media").json["media"], [])
        page = self.client.get("/screen")
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.headers["Cache-Control"], "no-store")
        self.assertIn("/api/pantallas/screen/media", page.text)
        self.assertIn("function poll()", page.text)
        self.assertNotIn("location.reload", page.text)
        self.assertIn("function createCarouselCache", page.text)
        self.assertIn('id="offline-status"', page.text)

    def test_version_changes_with_timestamp_even_for_same_size(self):
        file = self.screen / "a.jpg"
        file.write_bytes(b"old")
        first = self.client.get("/api/pantallas/screen/media").json
        timestamp = file.stat().st_mtime_ns
        file.write_bytes(b"new")
        os.utime(file, ns=(timestamp + 1000000000, timestamp + 1000000000))
        second = self.client.get("/api/pantallas/screen/media").json
        self.assertNotEqual(first["media"][0]["version"], second["media"][0]["version"])


if __name__ == "__main__":
    unittest.main()
