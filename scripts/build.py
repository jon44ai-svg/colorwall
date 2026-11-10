#!/usr/bin/env python3
"""Assemble the single-file app: .build/{head,body,app}.html/js -> index.html"""
import base64
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / ".build"

head = (BUILD / "head.html").read_text()
body = (BUILD / "body.html").read_text()
js = (BUILD / "app.js").read_text()

room = (ROOT / "assets" / "room.jpg").read_bytes()
data_uri = "data:image/jpeg;base64," + base64.b64encode(room).decode("ascii")

if "@@ROOM_SRC@@" not in js:
    raise SystemExit("app.js is missing the @@ROOM_SRC@@ placeholder")
js = js.replace("@@ROOM_SRC@@", data_uri)

html = (
    head
    + body
    + "\n<script>\n"
    + js
    + "\n</script>\n</body>\n</html>\n"
)

# Sanity checks that catch a broken assembly before it reaches a browser.
for needed in ('id="scene"', 'id="paletteGrid"', 'ColortrendSim', 'CORE'):
    if needed not in html:
        raise SystemExit("assembled output is missing: " + needed)
if re.search(r"@@[A-Z_]+@@", html):
    raise SystemExit("unreplaced placeholder left in output")

out = ROOT / "index.html"
out.write_text(html)
print("wrote %s (%.1f KB, %d lines)" % (out.name, len(html) / 1024, html.count("\n") + 1))
