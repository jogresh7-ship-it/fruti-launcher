#!/usr/bin/env python3
"""Turn .swf / .wasm files into .js files so the launcher works from file:// (no server).

  python3 tools/embed.py swf  path/to/game.swf  <id>   -> games/<id>.js
  python3 tools/embed.py rom  path/to/game.z64  <id>   -> games/n64/<id>.js  (Nintendo 64)
  python3 tools/embed.py wasm path/to/file.wasm        -> ruffle/<file>.wasm.js
"""
import base64, os, sys

def write(out, var, key, data):
    b64 = base64.b64encode(data).decode()
    with open(out, "w") as f:
        f.write(f'(window.{var}=window.{var}||{{}})[{key!r}]="{b64}";\n'.replace("'", '"'))
    print(out, len(b64) // 1024, "KB")

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
kind, src = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()
if kind == "swf":
    gid = sys.argv[3]
    write(os.path.join(root, "games", gid + ".js"), "FRUTI_SWF", gid, data)
elif kind == "rom":
    gid = sys.argv[3]
    os.makedirs(os.path.join(root, "games", "n64"), exist_ok=True)
    write(os.path.join(root, "games", "n64", gid + ".js"), "FRUTI_ROM", gid, data)
else:
    name = os.path.basename(src)
    write(os.path.join(root, "ruffle", name + ".js"), "FRUTI_WASM", name, data)
